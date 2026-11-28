// the email renderer loads itself with a dynamic import jest cannot run; the
// stand-in renders the template's props, which carry the invitation link
jest.mock('@react-email/render', () => ({
  render: async (element: { props: Record<string, unknown> }) =>
    JSON.stringify(element.props),
}));

import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { DomainService } from '../integrations/environment/domain.service';
import { QueueJob } from '../integrations/queue/constants';
import {
  INVITE_MESSAGE,
  InviteEmailError,
  ServiceInviter,
  acceptBlocker,
  pendingInvitations,
} from './invites';

// docmost's invitation service against a real, migrated docmost database, in a
// fresh workspace that is deleted afterwards. Runs only when
// MINDSPACE_IMPORT_TEST_DATABASE_URL names a database containing "test" or "_p7".
// a real database, and a cold compile, can take longer than the default 5 s
jest.setTimeout(30_000);

const configured = process.env.MINDSPACE_IMPORT_TEST_DATABASE_URL;
const databaseUrl =
  configured && /test|_p7/.test(new URL(configured).pathname)
    ? configured
    : undefined;

(databaseUrl ? describe : describe.skip)(
  'ServiceInviter through WorkspaceInvitationService',
  () => {
    let db: Kysely<any>;
    let workspace: any;
    let admin: any;
    const queued: { name: string; data: any }[] = [];

    const environment = {
      getMailBlockedRecipientDomains: () => [],
      getAppUrl: () => 'https://docs.example.test',
      isCloud: () => false,
      isHttps: () => true,
    } as any;

    const inviter = () =>
      new ServiceInviter({
        db: db as any,
        userRepo: new UserRepo(db as any),
        groupUserRepo: {} as any,
        environment,
        domain: new DomainService(environment),
        emailQueue: {
          add: async (name: string, data: any) => {
            queued.push({ name, data });
            return {} as any;
          },
        },
        workspace,
        inviter: admin,
      });

    beforeAll(async () => {
      db = new Kysely<any>({
        dialect: new PostgresJSDialect({
          postgres: postgres(databaseUrl, {
            max: 2,
            onnotice: () => undefined,
          }),
        }),
        plugins: [new CamelCasePlugin()],
      });
      workspace = await db
        .insertInto('workspaces')
        .values({ name: 'invite-integration-test' })
        .returningAll()
        .executeTakeFirstOrThrow();
      admin = await db
        .insertInto('users')
        .values({
          email: 'admin@acme.test',
          name: 'Admin',
          workspaceId: workspace.id,
          role: 'owner',
          emailVerifiedAt: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    afterAll(async () => {
      if (workspace) {
        await db
          .deleteFrom('workspaces')
          .where('id', '=', workspace.id)
          .execute();
      }
      await db?.destroy();
    });

    it('creates a member invitation, queues its email, and is found pending afterwards', async () => {
      expect([
        ...(await pendingInvitations(db as any, workspace.id, [
          'olga@acme.test',
        ])),
      ]).toEqual([]);

      await inviter().invite(['olga@acme.test']);

      const rows = await db
        .selectFrom('workspaceInvitations')
        .selectAll()
        .where('workspaceId', '=', workspace.id)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        email: 'olga@acme.test',
        role: 'member',
        invitedById: admin.id,
        message: INVITE_MESSAGE,
      });
      expect(new Date(rows[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
      // the email was queued before invite() resolved
      expect(queued).toHaveLength(1);
      expect(queued[0].name).toBe(QueueJob.SEND_EMAIL);
      expect(queued[0].data.to).toBe('olga@acme.test');
      expect(queued[0].data.html).toContain(`/invites/${rows[0].id}?token=`);

      expect([
        ...(await pendingInvitations(db as any, workspace.id, [
          'OLGA@acme.test',
          'x@y.test',
        ])),
      ]).toEqual(['olga@acme.test']);
    });

    it('creates no user and invites nobody who already has an account', async () => {
      const before = await db
        .selectFrom('users')
        .select('id')
        .where('workspaceId', '=', workspace.id)
        .execute();
      await inviter().invite(['admin@acme.test']);
      const after = await db
        .selectFrom('users')
        .select('id')
        .where('workspaceId', '=', workspace.id)
        .execute();
      expect(after).toHaveLength(before.length);
      const forAdmin = await db
        .selectFrom('workspaceInvitations')
        .select('id')
        .where('workspaceId', '=', workspace.id)
        .where('email', '=', 'admin@acme.test')
        .execute();
      expect(forAdmin).toEqual([]);
    });

    it('an email that cannot be queued names its address; the invitation exists for a resend', async () => {
      const failing = new ServiceInviter({
        db: db as any,
        userRepo: new UserRepo(db as any),
        groupUserRepo: {} as any,
        environment,
        domain: new DomainService(environment),
        emailQueue: {
          add: async () => Promise.reject(new Error('Redis is down')),
        },
        workspace,
        inviter: admin,
      });
      const err = await failing.invite(['grace@acme.test']).catch((e) => e);
      expect(err).toBeInstanceOf(InviteEmailError);
      expect(err.emails).toEqual(['grace@acme.test']);
      expect(err.cause.message).toBe('Redis is down');
      expect([
        ...(await pendingInvitations(db as any, workspace.id, [
          'grace@acme.test',
        ])),
      ]).toEqual(['grace@acme.test']);
    });

    it('an expired invitation is not pending, and inviting again renews the same row', async () => {
      await db
        .updateTable('workspaceInvitations')
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where('workspaceId', '=', workspace.id)
        .where('email', '=', 'olga@acme.test')
        .execute();
      expect([
        ...(await pendingInvitations(db as any, workspace.id, [
          'olga@acme.test',
        ])),
      ]).toEqual([]);
      // still listed, expired or not, for the last runs
      expect([
        ...(await pendingInvitations(
          db as any,
          workspace.id,
          ['olga@acme.test'],
          true,
        )),
      ]).toEqual(['olga@acme.test']);
      await inviter().invite(['olga@acme.test']);
      const rows = await db
        .selectFrom('workspaceInvitations')
        .selectAll()
        .where('workspaceId', '=', workspace.id)
        .where('email', '=', 'olga@acme.test')
        .execute();
      expect(rows).toHaveLength(1);
      expect(new Date(rows[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("acceptBlocker uses docmost's own rules: enforced SSO, allowed email domains", () => {
      expect(acceptBlocker('olga@acme.test', workspace)).toBeNull();
      expect(
        acceptBlocker('olga@acme.test', {
          ...workspace,
          emailDomains: ['docmost.test'],
        }),
      ).toBe(
        'The email domain "acme.test" is not approved for this workspace.',
      );
      expect(
        acceptBlocker('olga@acme.test', { ...workspace, enforceSso: true }),
      ).toBe('This workspace has enforced SSO login.');
    });
  },
);
