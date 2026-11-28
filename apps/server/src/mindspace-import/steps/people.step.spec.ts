import { MemoryImportMap, targetId } from '../import-map';
import { RecordingWriter } from '../recording-writer';
import {
  msProject,
  msUser,
  msWorkspace,
  type FakeData,
} from '../testing/fake-source';
import { WS, docmostUser, testContext } from '../testing/test-context';
import { peopleStep } from './people.step';
import { FakeInviter } from '../testing/fake-inviter';

const ada = docmostUser('d-ada', 'ada@acme.test', { name: 'Ada' });
const grace = docmostUser('d-grace', 'grace@acme.test', { name: 'Grace' });
const linus = docmostUser('d-linus', 'linus@acme.test', { name: 'Linus' });

const team: FakeData = {
  users: [
    msUser('m-ada', 'ada@acme.test'),
    msUser('m-grace', 'Grace@ACME.test'),
    msUser('m-linus', 'linus@acme.test'),
  ],
  workspaces: [msWorkspace('w-team', 'Team', 'm-ada')],
  members: [
    { workspaceId: 'w-team', userId: 'm-grace', role: 'editor' },
    { workspaceId: 'w-team', userId: 'm-linus', role: 'viewer' },
  ],
};

const spaceOf = (workspaceId: string) => targetId(WS, 'workspace', workspaceId);

describe('people step', () => {
  it('matches users by email without regard to case', async () => {
    const { ctx } = testContext(team, { users: [ada, grace, linus] });
    await peopleStep.run(ctx);
    expect(ctx.state.users.get('m-grace')).toBe('d-grace');
    expect(ctx.report.get('user.matched')).toBe(3);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('an unmatched user creates nothing and is reported', async () => {
    const { ctx, writer } = testContext(
      { users: [msUser('m-olga', 'olga@acme.test')] },
      { users: [ada] },
    );
    await peopleStep.run(ctx);
    expect(ctx.state.users.size).toBe(0);
    expect(ctx.report.warningsOf('user-unmatched')).toEqual([
      {
        email: 'olga@acme.test',
        reason: 'no docmost account with this email',
      },
    ]);
    expect(ctx.report.get('user.skipped.unmatched')).toBe(1);
    expect(writer.operations).toEqual([]);
  });

  it('a docmost account with the same email but no verified email is not matched', async () => {
    const unverified = docmostUser('d-ivan', 'ivan@acme.test', {
      emailVerifiedAt: null,
    });
    const deactivated = docmostUser('d-zed', 'zed@acme.test', {
      deactivatedAt: new Date(),
    });
    const { ctx } = testContext(
      {
        users: [
          msUser('m-ivan', 'ivan@acme.test'),
          msUser('m-zed', 'zed@acme.test'),
        ],
      },
      { users: [unverified, deactivated] },
    );
    await peopleStep.run(ctx);
    expect(ctx.state.users.size).toBe(0);
    expect(ctx.report.warningsOf('user-unmatched')).toEqual([
      {
        email: 'ivan@acme.test',
        reason: 'the docmost account has not verified its email',
      },
      { email: 'zed@acme.test', reason: 'the docmost account is deactivated' },
    ]);
  });

  it('a workspace becomes a space with owner as admin, editors as writers, viewers as readers', async () => {
    const { ctx, writer } = testContext(team, { users: [ada, grace, linus] });
    await peopleStep.run(ctx);
    const space = writer.spaces.get(spaceOf('w-team'));
    expect(space.name).toBe('Team');
    expect(Object.fromEntries(writer.members.get(space.id))).toEqual({
      'd-ada': 'admin',
      'd-grace': 'writer',
      'd-linus': 'reader',
    });
    expect(await ctx.map.get('workspace', 'w-team')).toBe(space.id);
    expect(ctx.report.get('workspace.imported')).toBe(1);
    expect(ctx.report.get('member.imported')).toBe(2);
  });

  it('two workspaces named "Personal" get distinct space names', async () => {
    const { ctx, writer } = testContext(
      {
        users: [
          msUser('m-ada', 'ada@acme.test'),
          msUser('m-grace', 'grace@acme.test'),
        ],
        workspaces: [
          msWorkspace('w-g', 'Personal', 'm-grace'),
          msWorkspace('w-a', 'Personal', 'm-ada'),
          msWorkspace('w-x', 'Wiki', 'm-ada'),
        ],
      },
      { users: [ada, grace], spaceNames: ['wiki'] },
    );
    await peopleStep.run(ctx);
    expect([...writer.spaces.values()].map((s) => s.name)).toEqual([
      'Personal',
      'Personal (Ada)',
      'Wiki (Ada)',
    ]);
  });

  it('a mindspace user with an unconfirmed email is ignored', async () => {
    // eve signed up with an address she never confirmed; a verified docmost
    // account with that address must not inherit her mindspace content
    const eve = docmostUser('d-eve', 'eve@acme.test');
    const { ctx, writer } = testContext(
      {
        users: [
          msUser('m-ada', 'ada@acme.test'),
          msUser('m-eve', 'eve@acme.test', false),
        ],
        workspaces: [
          msWorkspace('w-team', 'Team', 'm-ada'),
          msWorkspace('w-eve', 'Eve', 'm-eve'),
        ],
        members: [{ workspaceId: 'w-team', userId: 'm-eve', role: 'editor' }],
      },
      { users: [ada, eve] },
    );
    await peopleStep.run(ctx);
    expect(ctx.state.users.has('m-eve')).toBe(false);
    expect(ctx.report.get('user.skipped.unconfirmed')).toBe(1);
    expect(writer.members.get(spaceOf('w-team')).has('d-eve')).toBe(false);
    expect(writer.spaces.has(spaceOf('w-eve'))).toBe(false);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('a workspace whose owner is unmatched is not migrated and is reported with its project count', async () => {
    const { ctx, writer } = testContext(
      {
        users: [
          msUser('m-olga', 'olga@acme.test'),
          msUser('m-ada', 'ada@acme.test'),
        ],
        workspaces: [msWorkspace('w-olga', "Olga's notes", 'm-olga')],
        members: [{ workspaceId: 'w-olga', userId: 'm-ada', role: 'viewer' }],
        projects: [
          msProject({ id: 'p1', workspaceId: 'w-olga' }),
          msProject({ id: 'p2', workspaceId: 'w-olga', kind: 'doc' }),
        ],
      },
      { users: [ada] },
    );
    await peopleStep.run(ctx);
    expect(writer.operations).toEqual([]);
    expect(ctx.report.warningsOf('workspace-owner-unmatched')).toEqual([
      {
        workspaceId: 'w-olga',
        name: "Olga's notes",
        ownerEmail: 'olga@acme.test',
        projects: 2,
      },
    ]);
    expect(ctx.report.get('workspace.skipped.owner-unmatched')).toBe(1);
    expect(ctx.report.get('member.skipped.workspace-not-migrated')).toBe(1);
    expect(ctx.state.skippedWorkspaces.get('w-olga')).toBe('owner-unmatched');
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it("with --grant-fallback-admin the fallback owner becomes admin of an unmatched owner's space", async () => {
    const { ctx, writer } = testContext(
      {
        users: [
          msUser('m-olga', 'olga@acme.test'),
          msUser('m-ada', 'ada@acme.test'),
        ],
        workspaces: [msWorkspace('w-olga', "Olga's notes", 'm-olga')],
        members: [{ workspaceId: 'w-olga', userId: 'm-ada', role: 'viewer' }],
      },
      { users: [ada], options: { grantFallbackAdmin: true } },
    );
    await peopleStep.run(ctx);
    const space = writer.spaces.get(spaceOf('w-olga'));
    expect(Object.fromEntries(writer.members.get(space.id))).toEqual({
      'fallback-user': 'admin',
      'd-ada': 'reader',
    });
    expect(ctx.state.workspaceOwners.get('w-olga')).toBe('fallback-user');
    expect(
      ctx.report.warningsOf('workspace-granted-to-fallback-owner'),
    ).toHaveLength(1);
  });

  it('a second run creates no second space', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    await peopleStep.run(
      testContext(team, { users: [ada, grace, linus], map, writer }).ctx,
    );
    const before = writer.operations.length;

    const second = testContext(team, {
      users: [ada, grace, linus],
      map,
      writer,
    }).ctx;
    await peopleStep.run(second);
    expect(writer.operations.length).toBe(before);
    expect(writer.spaces.size).toBe(1);
    expect(second.report.get('workspace.already-imported')).toBe(1);
    expect(second.report.get('member.already-imported')).toBe(2);
    expect(second.report.mismatches()).toEqual([]);
  });

  it('no space has a member who was not a member in mindspace, the fallback owner included', async () => {
    const outsider = docmostUser('d-out', 'outsider@acme.test');
    const { ctx, writer } = testContext(
      {
        ...team,
        users: [...team.users, msUser('m-olga', 'olga@acme.test')],
        workspaces: [
          ...team.workspaces,
          msWorkspace('w-olga', 'Olga', 'm-olga'),
        ],
      },
      { users: [ada, grace, linus, outsider] },
    );
    await peopleStep.run(ctx);
    const everyone = [...writer.members.values()].flatMap((m) => [...m.keys()]);
    expect(everyone.sort()).toEqual(['d-ada', 'd-grace', 'd-linus']);
    expect(everyone).not.toContain(ctx.fallbackOwner.id);
  });

  it('an unmatched member is skipped with a warning', async () => {
    const { ctx, writer } = testContext(team, { users: [ada, grace] });
    await peopleStep.run(ctx);
    expect(writer.members.get(spaceOf('w-team')).has('d-linus')).toBe(false);
    expect(ctx.report.warningsOf('member-unmatched')).toEqual([
      { workspace: 'Team', email: 'linus@acme.test', role: 'viewer' },
    ]);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  describe('with --invite-unmatched', () => {
    const data: FakeData = {
      users: [
        msUser('m-ada', 'ada@acme.test'),
        msUser('m-olga', 'Olga@Acme.test'), // no docmost account
        msUser('m-ivan', 'ivan@acme.test'), // account, email never verified
        msUser('m-eve', 'eve@acme.test', false), // never confirmed in mindspace
      ],
      workspaces: [
        msWorkspace('w-olga', "Olga's notes", 'm-olga'),
        msWorkspace('w-ada', 'Team', 'm-ada'),
      ],
      members: [{ workspaceId: 'w-ada', userId: 'm-olga', role: 'editor' }],
    };
    const users = [
      ada,
      docmostUser('d-ivan', 'ivan@acme.test', { emailVerifiedAt: null }),
    ];

    it('invites each confirmed person with no docmost account, and only them', async () => {
      const invites = new FakeInviter();
      const { ctx, writer } = testContext(data, {
        users,
        invites,
        options: { inviteUnmatched: true },
      });
      await peopleStep.run(ctx);
      expect(invites.sent).toEqual([['olga@acme.test']]);
      expect(ctx.report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'invited',
          for: ['workspace member'],
        },
      ]);
      // their content waits until they accept: olga's workspace is not migrated
      expect(writer.spaces.has(targetId(WS, 'workspace', 'w-olga'))).toBe(
        false,
      );
      expect(ctx.report.get('workspace.skipped.owner-unmatched')).toBe(1);
      expect(ctx.report.mismatches()).toEqual([]);
    });

    it('--no-new-invites sends and renews nothing, and lists every unaccepted invitation, expired or not', async () => {
      const invites = new FakeInviter(new Set(['olga@acme.test']));
      const twoUnmatched: FakeData = {
        ...data,
        users: [
          ...data.users,
          msUser('m-zoe', 'zoe@acme.test'),
          msUser('m-max', 'max@acme.test'),
        ],
      };
      invites.expired.add('zoe@acme.test');
      const { ctx } = testContext(twoUnmatched, {
        users,
        invites,
        options: { inviteUnmatched: true, noNewInvites: true },
      });
      await peopleStep.run(ctx);
      expect(invites.sent).toEqual([]);
      expect(ctx.report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'invited-not-accepted',
          for: ['workspace member'],
        },
        {
          email: 'zoe@acme.test',
          status: 'invited-not-accepted',
          for: ['workspace member'],
        },
        {
          email: 'max@acme.test',
          status: 'not-invited',
          for: ['workspace member'],
        },
      ]);
    });

    it('--no-new-invites still names addresses that are not addresses or could never accept', async () => {
      const invites = new FakeInviter(new Set(), new Set(), {
        'olga@acme.test': 'This workspace has enforced SSO login.',
      });
      const { ctx } = testContext(data, {
        users,
        invites,
        options: { noNewInvites: true },
      });
      await peopleStep.run(ctx);
      expect(ctx.report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'cannot-accept',
          for: ['workspace member'],
          reason: 'This workspace has enforced SSO login.',
        },
      ]);
    });

    it('--no-new-invites works without --invite-unmatched too, and in a dry run', async () => {
      const invites = new FakeInviter(new Set(['olga@acme.test']));
      const { ctx } = testContext(data, {
        users,
        invites,
        options: { noNewInvites: true },
      });
      ctx.dryRun = true;
      await peopleStep.run(ctx);
      expect(invites.sent).toEqual([]);
      expect(ctx.report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'invited-not-accepted',
          for: ['workspace member'],
        },
      ]);
    });

    it('sends nothing without the flag', async () => {
      const invites = new FakeInviter();
      const { ctx } = testContext(data, { users, invites });
      await peopleStep.run(ctx);
      expect(invites.sent).toEqual([]);
      expect(ctx.report.invited()).toEqual([]);
    });

    it('skips anyone with a pending invitation, so a re-run sends none twice', async () => {
      const invites = new FakeInviter(new Set(['olga@acme.test']));
      const { ctx } = testContext(data, {
        users,
        invites,
        options: { inviteUnmatched: true },
      });
      await peopleStep.run(ctx);
      expect(invites.sent).toEqual([]);
      expect(ctx.report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'already-invited',
          for: ['workspace member'],
        },
      ]);
    });

    it('a dry run lists who would be invited and sends nothing', async () => {
      const invites = new FakeInviter();
      const { ctx } = testContext(data, {
        users,
        invites,
        options: { inviteUnmatched: true },
      });
      ctx.dryRun = true;
      await peopleStep.run(ctx);
      expect(invites.sent).toEqual([]);
      expect(ctx.report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'would-invite',
          for: ['workspace member'],
        },
      ]);
    });

    it('once the invitation is accepted, a re-run maps the person and imports their workspace', async () => {
      const map = new MemoryImportMap();
      const writer = new RecordingWriter(map, WS);
      const invites = new FakeInviter();
      await peopleStep.run(
        testContext(data, {
          users,
          invites,
          map,
          writer,
          options: { inviteUnmatched: true },
        }).ctx,
      );
      const olga = docmostUser('d-olga', 'olga@acme.test', { name: 'Olga' });
      const again = testContext(data, {
        users: [...users, olga],
        invites,
        map,
        writer,
        options: { inviteUnmatched: true },
      });
      await peopleStep.run(again.ctx);
      expect(invites.sent).toEqual([['olga@acme.test']]);
      expect(writer.spaces.has(targetId(WS, 'workspace', 'w-olga'))).toBe(true);
      expect(
        writer.members.get(targetId(WS, 'workspace', 'w-ada')).get('d-olga'),
      ).toBe('writer');
      expect(again.ctx.report.invited()).toEqual([]);
    });

    it('an invitation whose email could not be queued is reported and fails the run, which goes on', async () => {
      const invites = new FakeInviter(new Set(), new Set(['olga@acme.test']));
      const { ctx, writer } = testContext(data, {
        users,
        invites,
        options: { inviteUnmatched: true },
      });
      await peopleStep.run(ctx);
      expect(ctx.report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'invited-email-failed',
          for: ['workspace member'],
          reason: 'Redis is down',
        },
      ]);
      expect(ctx.report.mismatches()).toEqual([
        'the invitation email to olga@acme.test was not queued (Redis is down); resend it from Settings > Members > Pending',
      ]);
      // the rest of the step still ran
      expect(writer.spaces.has(targetId(WS, 'workspace', 'w-ada'))).toBe(true);
    });

    it('someone docmost would never let accept (SSO, email domains) is listed and not invited', async () => {
      const invites = new FakeInviter(new Set(), new Set(), {
        'olga@acme.test':
          'The email domain "acme.test" is not approved for this workspace.',
      });
      const { ctx } = testContext(data, {
        users,
        invites,
        options: { inviteUnmatched: true },
      });
      ctx.dryRun = true;
      await peopleStep.run(ctx);
      expect(invites.sent).toEqual([]);
      expect(ctx.report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'cannot-accept',
          for: ['workspace member'],
          reason:
            'The email domain "acme.test" is not approved for this workspace.',
        },
      ]);
    });
  });

  describe('two docmost accounts whose emails differ only by case', () => {
    const twins = [
      docmostUser('d-grace-1', 'grace@acme.test'),
      docmostUser('d-grace-2', 'Grace@ACME.test'),
    ];
    const data: FakeData = {
      users: [
        msUser('m-ada', 'ada@acme.test'),
        msUser('m-grace', 'grace@acme.test'),
      ],
      workspaces: [
        msWorkspace('w-team', 'Team', 'm-ada'),
        msWorkspace('w-grace', 'Grace', 'm-grace'),
      ],
      members: [{ workspaceId: 'w-team', userId: 'm-grace', role: 'editor' }],
      projectShares: [],
    };

    it('map nobody: the person is unmatched everywhere and reported once with the count', async () => {
      const invites = new FakeInviter();
      const { ctx, writer } = testContext(data, {
        users: [ada, ...twins],
        invites,
        options: { inviteUnmatched: true },
      });
      await peopleStep.run(ctx);
      expect(ctx.state.users.has('m-grace')).toBe(false);
      expect(ctx.report.warningsOf('user-ambiguous')).toEqual([
        { email: 'grace@acme.test', count: 2 },
      ]);
      expect(ctx.report.get('user.skipped.ambiguous')).toBe(1);
      // no membership, no space of their own, no invitation
      expect([
        ...writer.members.get(targetId(WS, 'workspace', 'w-team')).keys(),
      ]).toEqual(['d-ada']);
      expect(writer.spaces.has(targetId(WS, 'workspace', 'w-grace'))).toBe(
        false,
      );
      expect(invites.sent).toEqual([]);
      expect(ctx.report.invited()).toEqual([]);
      expect(ctx.report.mismatches()).toEqual([]);
    });
  });

  it('a member with a role mindspace does not define is skipped, not added', async () => {
    const { ctx, writer } = testContext(
      {
        users: [
          msUser('m-ada', 'ada@acme.test'),
          msUser('m-grace', 'grace@acme.test'),
        ],
        workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
        members: [
          { workspaceId: 'w1', userId: 'm-grace', role: 'owner' as any },
        ],
      },
      { users: [ada, docmostUser('d-grace', 'grace@acme.test')] },
    );
    await peopleStep.run(ctx);
    expect([
      ...writer.members.get(targetId(WS, 'workspace', 'w1')).keys(),
    ]).toEqual(['d-ada']);
    expect(ctx.report.get('member.skipped.unknown-role')).toBe(1);
    expect(ctx.report.warningsOf('member-role-unknown')).toEqual([
      { workspace: 'Team', email: 'grace@acme.test', role: 'owner' },
    ]);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('an owner who is already a member below admin is raised to admin', async () => {
    const space = targetId(WS, 'workspace', 'w1');
    const map = new MemoryImportMap();
    await map.set('workspace', 'w1', 'space', space);
    const { ctx, writer } = testContext(
      {
        users: [msUser('m-ada', 'ada@acme.test')],
        workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
      },
      {
        users: [ada],
        map,
        members: {
          [space]: [
            { userId: 'fallback-user', role: 'admin' },
            { userId: 'd-ada', role: 'writer' },
          ],
        },
      },
    );
    await peopleStep.run(ctx);
    expect(writer.members.get(space).get('d-ada')).toBe('admin');
    expect(ctx.report.warningsOf('space-owner-added')).toHaveLength(1);
  });

  it('a member an admin removed after an earlier run is not added again', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const d: FakeData = {
      users: [
        msUser('m-ada', 'ada@acme.test'),
        msUser('m-grace', 'grace@acme.test'),
      ],
      workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
      members: [{ workspaceId: 'w1', userId: 'm-grace', role: 'editor' }],
    };
    const people = [ada, docmostUser('d-grace', 'grace@acme.test')];
    await peopleStep.run(testContext(d, { users: people, map, writer }).ctx);
    const space = targetId(WS, 'workspace', 'w1');
    writer.members.get(space).delete('d-grace');

    const again = testContext(d, { users: people, map, writer });
    await peopleStep.run(again.ctx);
    expect(writer.members.get(space).has('d-grace')).toBe(false);
    expect(again.ctx.report.get('member.already-imported')).toBe(1);
  });

  it('the owner is added or raised once; an admin removing or demoting them later is kept', async () => {
    const space = targetId(WS, 'workspace', 'w1');
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const d: FakeData = {
      users: [msUser('m-ada', 'ada@acme.test')],
      workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
    };
    await peopleStep.run(testContext(d, { users: [ada], map, writer }).ctx);
    expect(writer.members.get(space).get('d-ada')).toBe('admin');

    writer.members.get(space).set('d-ada', 'reader');
    const demoted = testContext(d, { users: [ada], map, writer });
    await peopleStep.run(demoted.ctx);
    expect(writer.members.get(space).get('d-ada')).toBe('reader');
    expect(demoted.ctx.report.warningsOf('space-owner-added')).toEqual([]);

    writer.members.get(space).delete('d-ada');
    await peopleStep.run(testContext(d, { users: [ada], map, writer }).ctx);
    expect(writer.members.get(space).has('d-ada')).toBe(false);
  });
});
