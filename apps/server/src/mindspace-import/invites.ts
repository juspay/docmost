import { Queue } from 'bullmq';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { User, Workspace } from '@docmost/db/types/entity.types';
import type { UserRepo } from '@docmost/db/repos/user/user.repo';
import type { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { WorkspaceInvitationService } from '../core/workspace/services/workspace-invitation.service';
import type { InviteUserDto } from '../core/workspace/dto/invitation.dto';
import { MailService } from '../integrations/mail/mail.service';
import type { EnvironmentService } from '../integrations/environment/environment.service';
import type { DomainService } from '../integrations/environment/domain.service';
import { NoopAuditService } from '../integrations/audit/audit.service';
import { QueueName } from '../integrations/queue/constants';
import { createRetryStrategy, parseRedisUrl } from '../common/helpers';
import type { ImportContext } from './runner';
import type { InviteEntry } from './report';
import { isEmail } from 'class-validator';
import {
  validateAllowedEmail,
  validateSsoEnforcement,
} from '../core/auth/auth.util';

/** Invitations to the target docmost workspace, role member. */
export interface Inviter {
  /** Why docmost would refuse this address on acceptance, or null. */
  acceptBlocker(email: string): string | null;
  /** Lower-cased emails with an invitation of this workspace, expired or not. */
  invitedEver(emails: string[]): Promise<Set<string>>;
  /** Lower-cased emails that already have a live (unexpired) invitation. */
  pending(emails: string[]): Promise<Set<string>>;
  /**
   * Sends the invitations; resolves once their emails are queued. If some
   * emails cannot be queued it throws InviteEmailError naming them; their
   * invitations exist and are resent from Settings > Members > Pending.
   */
  invite(emails: string[]): Promise<void>;
}

export class InviteEmailError extends Error {
  constructor(
    readonly emails: string[],
    readonly cause: Error,
  ) {
    super(
      `Invitation emails could not be queued for ${emails.join(', ')}: ${cause.message}`,
    );
  }
}

/** docmost's own rules for accepting an invitation (auth.util). */
export function acceptBlocker(
  email: string,
  workspace: Workspace,
): string | null {
  try {
    validateSsoEnforcement(workspace);
    validateAllowedEmail(email, workspace);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** A factory for the email queue, so tests can give their own. */
export const IMPORT_EMAIL_QUEUE = Symbol('IMPORT_EMAIL_QUEUE');

export const INVITE_MESSAGE =
  'Your mindspace content is moving to docmost. Accept this invitation and it will be brought over for you.';

/** docmost's own limit per request */
const INVITE_BATCH = 50;

export async function pendingInvitations(
  db: KyselyDB,
  workspaceId: string,
  emails: string[],
  includeExpired = false,
): Promise<Set<string>> {
  const lower = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (lower.length === 0) return new Set();
  const rows = await db
    .selectFrom('workspaceInvitations')
    .select('email')
    .where('workspaceId', '=', workspaceId)
    .where((eb) => eb(eb.fn('lower', ['email']), 'in', lower))
    .$if(!includeExpired, (q) => q.where('expiresAt', '>', new Date()))
    .execute();
  return new Set(rows.map((r) => (r.email ?? '').toLowerCase()));
}

/**
 * The open-source WorkspaceInvitationService, unchanged, except that the
 * invitation emails it starts without waiting are awaited: a one-off process
 * must not exit before they are queued.
 */
class AwaitedInvitationService extends WorkspaceInvitationService {
  readonly sending: { email: string; sent: Promise<void> }[] = [];

  override sendInvitationMail(
    ...args: Parameters<WorkspaceInvitationService['sendInvitationMail']>
  ) {
    const sent = super.sendInvitationMail(...args);
    // the service does not await it; this catch keeps it from going unhandled
    sent.catch(() => undefined);
    this.sending.push({ email: args[1], sent });
    return sent;
  }
}

const unused = (what: string) =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error(`${what} is not available in the mindspace import`);
      },
    },
  );

/** The email queue the app's worker reads; the import adds jobs, never processes them. */
export function createEmailQueue(environment: EnvironmentService): Queue {
  const redis = parseRedisUrl(environment.getRedisUrl());
  return new Queue(QueueName.EMAIL_QUEUE, {
    connection: {
      host: redis.host,
      port: redis.port,
      username: redis.username,
      password: redis.password,
      db: redis.db,
      family: redis.family,
      tls: redis.tls,
      retryStrategy: createRetryStrategy(),
    },
    // as QueueModule
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 20 * 1000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  });
}

/** Sends invitations through docmost's invitation service, as the fallback owner. */
export class ServiceInviter implements Inviter {
  private readonly service: AwaitedInvitationService;

  constructor(
    private readonly deps: {
      db: KyselyDB;
      userRepo: UserRepo;
      groupUserRepo: GroupUserRepo;
      environment: EnvironmentService;
      domain: DomainService;
      emailQueue: Pick<Queue, 'add'> & Partial<Pick<Queue, 'waitUntilReady'>>;
      workspace: Workspace;
      inviter: User;
    },
  ) {
    // createInvitation needs only the database, mail, domain and audit;
    // the rest is there for other methods and refuses to be used
    const mail = new MailService(
      unused('Sending mail directly') as any,
      deps.environment,
      deps.emailQueue as Queue,
    );
    this.service = new AwaitedInvitationService(
      deps.userRepo,
      deps.groupUserRepo,
      mail,
      deps.domain,
      unused('TokenService') as any,
      unused('SessionService') as any,
      deps.db,
      unused('The billing queue') as any,
      deps.environment,
      new NoopAuditService(),
    );
  }

  /**
   * Fails unless Redis answers within `timeoutMs`, before any invitation is
   * created: an invitation without its email would sit pending, unseen.
   */
  async ready(timeoutMs = 10_000): Promise<void> {
    if (!this.deps.emailQueue.waitUntilReady) return;
    let timer: NodeJS.Timeout;
    await Promise.race([
      this.deps.emailQueue.waitUntilReady(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${timeoutMs / 1000} s`)),
          timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  acceptBlocker(email: string) {
    return acceptBlocker(email, this.deps.workspace);
  }

  pending(emails: string[]) {
    return pendingInvitations(this.deps.db, this.deps.workspace.id, emails);
  }

  invitedEver(emails: string[]) {
    return pendingInvitations(
      this.deps.db,
      this.deps.workspace.id,
      emails,
      true,
    );
  }

  async invite(emails: string[]): Promise<void> {
    for (let i = 0; i < emails.length; i += INVITE_BATCH) {
      const dto: InviteUserDto = {
        emails: emails.slice(i, i + INVITE_BATCH),
        role: 'member',
        groupIds: [],
        message: INVITE_MESSAGE,
      };
      await this.service.createInvitation(
        dto,
        this.deps.workspace,
        this.deps.inviter,
      );
    }
    const results = await Promise.allSettled(
      this.service.sending.map((s) => s.sent),
    );
    const failed = this.service.sending.filter(
      (_, i) => results[i].status === 'rejected',
    );
    this.service.sending.length = 0;
    if (failed.length > 0) {
      const first = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      throw new InviteEmailError(
        failed.map((f) => f.email),
        first.reason instanceof Error
          ? first.reason
          : new Error(String(first.reason)),
      );
    }
  }
}

/** The dry run's inviter: reads which invitations exist, sends nothing. */
export class DryRunInviter implements Inviter {
  constructor(
    private readonly db: KyselyDB,
    private readonly workspace: Workspace,
  ) {}

  acceptBlocker(email: string) {
    return acceptBlocker(email, this.workspace);
  }

  pending(emails: string[]) {
    return pendingInvitations(this.db, this.workspace.id, emails);
  }

  invitedEver(emails: string[]) {
    return pendingInvitations(this.db, this.workspace.id, emails, true);
  }

  async invite(): Promise<void> {
    throw new Error('A dry run sends no invitation');
  }
}

export type InviteReason = 'workspace member' | 'project share';

/**
 * With --invite-unmatched: invites each address that has no docmost account
 * (role member), skipping any with a live invitation, so a re-run sends none
 * twice. Their content stays skipped until they accept; a re-run then maps them.
 */
export async function inviteUnmatched(
  ctx: ImportContext,
  people: { email: string; reason: InviteReason }[],
): Promise<void> {
  const listOnly = !!ctx.options.noNewInvites;
  if (
    (!ctx.options.inviteUnmatched && !listOnly) ||
    !ctx.invites ||
    people.length === 0
  )
    return;
  const byEmail = new Map<string, InviteReason[]>();
  for (const p of people) {
    const email = p.email.toLowerCase();
    byEmail.set(email, [...new Set([...(byEmail.get(email) ?? []), p.reason])]);
  }
  ctx.state.invited ??= new Set();
  // already handled earlier in this run: only note the extra reason
  for (const [email, reasons] of byEmail) {
    if (ctx.state.invited.has(email))
      ctx.report.addInviteReasons(email, reasons);
  }
  const fresh = [...byEmail.keys()].filter((e) => !ctx.state.invited.has(e));
  if (fresh.length === 0) return;
  if (listOnly) {
    // the last runs: nothing is sent or renewed; who never accepted is listed
    const ever = await ctx.invites.invitedEver(fresh);
    for (const email of fresh) {
      ctx.state.invited.add(email);
      const blocker = isEmail(email) ? ctx.invites.acceptBlocker(email) : null;
      const s: InviteEntry['status'] = !isEmail(email)
        ? 'invalid-email'
        : blocker
          ? 'cannot-accept'
          : ever.has(email)
            ? 'invited-not-accepted'
            : 'not-invited';
      ctx.report.invite({
        email,
        status: s,
        for: byEmail.get(email),
        ...(blocker ? { reason: blocker } : {}),
      });
      ctx.report.count(`invite.${s}`);
    }
    return;
  }
  const status = new Map<string, InviteEntry['status']>();
  const reason = new Map<string, string>();
  for (const email of fresh) {
    // mindspace data: a share address is whatever someone typed
    if (!isEmail(email)) status.set(email, 'invalid-email');
    else {
      const blocker = ctx.invites.acceptBlocker(email);
      if (blocker) {
        status.set(email, 'cannot-accept');
        reason.set(email, blocker);
      }
    }
  }
  const candidates = fresh.filter((e) => !status.has(e));
  const pending = await ctx.invites.pending(candidates);
  for (const e of candidates)
    if (pending.has(e)) status.set(e, 'already-invited');
  const toSend = candidates.filter((e) => !pending.has(e));
  for (const e of toSend)
    status.set(e, ctx.dryRun ? 'would-invite' : 'invited');
  if (toSend.length > 0 && !ctx.dryRun) {
    try {
      await ctx.invites.invite(toSend);
    } catch (err) {
      if (!(err instanceof InviteEmailError)) throw err;
      for (const email of err.emails) {
        status.set(email, 'invited-email-failed');
        reason.set(email, err.cause.message);
        ctx.report.fail(
          `the invitation email to ${email} was not queued (${err.cause.message}); resend it from Settings > Members > Pending`,
        );
      }
    }
  }
  for (const email of fresh) {
    ctx.state.invited.add(email);
    const s = status.get(email);
    ctx.report.invite({
      email,
      status: s,
      for: byEmail.get(email),
      ...(reason.has(email) ? { reason: reason.get(email) } : {}),
    });
    ctx.report.count(`invite.${s}`);
  }
}
