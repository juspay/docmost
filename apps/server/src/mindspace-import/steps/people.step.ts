import { targetId } from '../import-map';
import type { SpaceRoleName } from '../import-writer';
import {
  alreadyImported,
  eachItem,
  type ImportContext,
  type ImportStep,
} from '../runner';
import {
  matchByEmail,
  reportAmbiguous,
  type DocmostUser,
} from '../docmost-reader';
import { ImportReport } from '../report';
import type { MapEntry } from '../import-writer';
import { inviteUnmatched } from '../invites';
import type { MsMemberRole } from '../source/mindspace.types';

const ROLE: Record<MsMemberRole, SpaceRoleName> = {
  editor: 'writer',
  viewer: 'reader',
};

export const SPACE_DESCRIPTION = 'Imported from mindspace';

/** Makes the owner an admin of the space: adds them, or raises a lower role. */
async function ensureAdmin(
  ctx: ImportContext,
  spaceId: string,
  userId: string,
  map: MapEntry,
): Promise<boolean> {
  if (await ctx.writer.addSpaceMember(spaceId, userId, 'admin', map))
    return true;
  const current = (await ctx.docmost.spaceMembers(spaceId)).find(
    (m) => m.userId === userId,
  );
  if (!current || current.role === 'admin') return false;
  await ctx.writer.setSpaceRole(spaceId, userId, 'admin', map);
  return true;
}

export function unmatchedReason(user: DocmostUser | undefined): string | null {
  if (!user) return 'no docmost account with this email';
  if (user.deletedAt) return 'the docmost account is deleted';
  if (user.deactivatedAt) return 'the docmost account is deactivated';
  if (!user.emailVerifiedAt)
    return 'the docmost account has not verified its email';
  return null;
}

/**
 * Maps confirmed mindspace people to verified, active docmost people by email
 * (nobody is created or invited), then turns each workspace into a space whose
 * members are exactly the mapped owner and the mapped members.
 */
async function matchPeople(ctx: ImportContext, record = true) {
  const report = record ? ctx.report : new ImportReport();
  const users = await ctx.source.users();
  report.count('user.source', users.length);
  const emails = new Map(users.map((u) => [u.id, u.email]));
  const matched = new Map<string, string>();
  const noAccount: string[] = [];

  const confirmed = users.filter((u) => {
    if (u.emailConfirmedAt && u.email) return true;
    // nobody may claim mindspace content by registering an address they do not own
    report.count('user.skipped.unconfirmed');
    report.warn('user-unconfirmed', { email: u.email });
    return false;
  });
  const { users: byEmail, ambiguous } = await matchByEmail(
    ctx.docmost,
    confirmed.map((u) => u.email),
  );
  const docmostUsers = [...byEmail.values()];
  ctx.state.ambiguousReported ??= new Set();
  if (record) reportAmbiguous(report, ctx.state.ambiguousReported, ambiguous);

  for (const u of confirmed) {
    if (ambiguous.has(u.email.toLowerCase())) {
      // two accounts, one address: giving either the content could be wrong
      report.count('user.skipped.ambiguous');
      continue;
    }
    const found = byEmail.get(u.email.toLowerCase());
    const reason = unmatchedReason(found);
    if (reason) {
      if (!found) noAccount.push(u.email);
      report.count('user.skipped.unmatched');
      report.warn('user-unmatched', {
        email: u.email.toLowerCase(),
        reason,
      });
      continue;
    }
    matched.set(u.id, found.id);
    report.count('user.matched');
  }

  ctx.state.users = matched;
  ctx.state.emails = emails;
  return {
    noAccount,
    names: new Map(
      docmostUsers.map((d) => [d.id, d.name ?? d.email.split('@')[0]]),
    ),
  };
}

function uniqueName(name: string, owner: string, taken: Set<string>): string {
  for (let n = 0; ; n++) {
    const candidate =
      n === 0
        ? name
        : n === 1
          ? `${name} (${owner})`
          : `${name} (${owner} ${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The people mapping a later step needs, rebuilt without writing or reporting
 * when the people step did not run in this process (`--only`).
 */
export async function ensurePeople(ctx: ImportContext): Promise<void> {
  if (ctx.state.users && ctx.state.workspaceOwners) return;
  await matchPeople(ctx, false);
  ctx.state.skippedWorkspaces = new Map();
  ctx.state.workspaceOwners = new Map();
  for (const w of await ctx.source.workspaces()) {
    const owner = ctx.state.users.get(w.ownerId);
    if (owner) ctx.state.workspaceOwners.set(w.id, owner);
    else if (ctx.options.grantFallbackAdmin)
      ctx.state.workspaceOwners.set(w.id, ctx.fallbackOwner.id);
    else ctx.state.skippedWorkspaces.set(w.id, 'owner-unmatched');
  }
}

export const peopleStep: ImportStep = {
  name: 'people',
  async run(ctx) {
    const { names, noAccount } = await matchPeople(ctx);
    await inviteUnmatched(
      ctx,
      noAccount.map((email) => ({
        email,
        reason: 'workspace member' as const,
      })),
    );
    const users = ctx.state.users;
    const [workspaces, members, projects] = await Promise.all([
      ctx.source.workspaces(),
      ctx.source.members(),
      ctx.source.projects(),
    ]);
    names.set(
      ctx.fallbackOwner.id,
      ctx.fallbackOwner.name ?? ctx.fallbackOwner.email,
    );

    ctx.report.count('workspace.source', workspaces.length);
    ctx.report.count('member.source', members.length);
    ctx.state.skippedWorkspaces = new Map();
    ctx.state.workspaceOwners = new Map();
    const taken = await ctx.docmost.spaceNames();

    for (const w of workspaces) {
      const wsMembers = members.filter((m) => m.workspaceId === w.id);
      const owner = users.get(w.ownerId);

      if (!owner && !ctx.options.grantFallbackAdmin) {
        // giving it to someone else would show them content they could not see
        ctx.report.count('workspace.skipped.owner-unmatched');
        ctx.report.count(
          'member.skipped.workspace-not-migrated',
          wsMembers.length,
        );
        ctx.report.warn('workspace-owner-unmatched', {
          workspaceId: w.id,
          name: w.name,
          ownerEmail: ctx.state.emails.get(w.ownerId) ?? null,
          projects: projects.filter((p) => p.workspaceId === w.id).length,
        });
        ctx.state.skippedWorkspaces.set(w.id, 'owner-unmatched');
        continue;
      }
      const adminId = owner ?? ctx.fallbackOwner.id;

      const space = await eachItem(ctx, 'workspace', w.id, async () => {
        let spaceId = await alreadyImported(
          ctx,
          'workspace',
          w.id,
          'workspace',
        );
        // an earlier run gave the space to the fallback owner; the owner now
        // has an account, so they get back the access they had in mindspace
        // once per space: a docmost admin may remove or demote the owner later
        const ownerKey = `owner:${w.id}`;
        if (
          spaceId &&
          owner &&
          !(await ctx.map.get('grant', ownerKey)) &&
          (await ensureAdmin(ctx, spaceId, owner, {
            type: 'grant',
            sourceId: ownerKey,
          }))
        ) {
          ctx.report.warn('space-owner-added', {
            workspaceId: w.id,
            name: w.name,
            ownerEmail: ctx.state.emails.get(w.ownerId) ?? null,
          });
        }
        if (spaceId && owner)
          await ctx.map.set('grant', ownerKey, 'user', owner);
        if (!spaceId) {
          const name = uniqueName(
            w.name,
            names.get(adminId) ?? 'mindspace',
            taken,
          );
          const space = await ctx.writer.createSpace({
            id: targetId(ctx.workspaceId, 'workspace', w.id),
            name,
            description: SPACE_DESCRIPTION,
            adminId,
            map: { type: 'workspace', sourceId: w.id },
          });
          taken.add(name.toLowerCase());
          spaceId = space.id;
          ctx.report.count('workspace.imported');
          // the owner is made admin by createSpace: that is their one grant
          if (owner) await ctx.map.set('grant', ownerKey, 'user', owner);
          if (!owner) {
            ctx.report.warn('workspace-granted-to-fallback-owner', {
              workspaceId: w.id,
              name,
              ownerEmail: ctx.state.emails.get(w.ownerId) ?? null,
              fallbackOwner: ctx.fallbackOwner.email,
            });
          }
        }
        return spaceId;
      });
      if (!space.ok) {
        ctx.report.count('member.failed.workspace-failed', wsMembers.length);
        ctx.state.skippedWorkspaces.set(w.id, 'workspace-failed');
        continue;
      }
      const spaceId = space.value;
      ctx.state.workspaceOwners.set(w.id, adminId);

      for (const m of wsMembers) {
        const userId = users.get(m.userId);
        if (!userId) {
          ctx.report.count('member.skipped.unmatched');
          ctx.report.warn('member-unmatched', {
            workspace: w.name,
            email: ctx.state.emails.get(m.userId)?.toLowerCase() ?? null,
            role: m.role,
          });
          continue;
        }
        if (userId === adminId) {
          ctx.report.count('member.skipped.already-admin');
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(ROLE, m.role)) {
          ctx.report.count('member.skipped.unknown-role');
          ctx.report.warn('member-role-unknown', {
            workspace: w.name,
            email: ctx.state.emails.get(m.userId)?.toLowerCase() ?? null,
            role: m.role,
          });
          continue;
        }
        await eachItem(ctx, 'member', `${w.id}:${m.userId}`, async () => {
          // added by an earlier run: an admin may have removed them since
          const key = `member:${w.id}:${m.userId}`;
          if (await ctx.map.get('grant', key)) {
            ctx.report.count('member.already-imported');
            return;
          }
          // the membership and its map row in one transaction; a new one is
          // held to the source by this run's verify (the member, not the space)
          const added = await ctx.writer.addSpaceMember(
            spaceId,
            userId,
            ROLE[m.role],
            { type: 'grant', sourceId: key },
          );
          ctx.report.count(
            added ? 'member.imported' : 'member.already-imported',
          );
        });
      }
    }
  },
};
