jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

import { DbImportMap, MemoryImportMap, targetId } from '../import-map';
import { ImportWriter } from '../import-writer';
import { RecordingWriter } from '../recording-writer';
import {
  msProject,
  msUser,
  msWorkspace,
  type FakeData,
} from '../testing/fake-source';
import { RecordingDb } from '../testing/recording-db';
import { WS, docmostUser, testContext } from '../testing/test-context';
import { docsStep } from './docs.step';
import { peopleStep } from './people.step';
import { projectsStep } from './projects.step';
import { sharesStep } from './shares.step';
import { FakeInviter } from '../testing/fake-inviter';

const ada = docmostUser('d-ada', 'ada@acme.test', { name: 'Ada' });
const now = Date.now();
const DAY = 86_400_000;
const base: FakeData = {
  users: [msUser('m-ada', 'ada@acme.test')],
  workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
};
const shareOf = (projectId: string) => targetId(WS, 'share', projectId);

async function run(data: FakeData, o: Parameters<typeof testContext>[1] = {}) {
  const world = testContext({ ...base, ...data }, { users: [ada], ...o });
  for (const step of [peopleStep, projectsStep, docsStep, sharesStep])
    await step.run(world.ctx);
  return world;
}

describe('shares step', () => {
  it('a link-visible project without expiry gets a share', async () => {
    const { writer, ctx } = await run({
      projects: [
        msProject({
          id: 'p1',
          workspaceId: 'w1',
          visibility: 'link',
          linkExpiresAt: null,
        }),
      ],
    });
    const share = writer.shares.get(shareOf('p1'));
    expect(share).toMatchObject({
      pageId: targetId(WS, 'project', 'p1'),
      includeSubPages: false,
      expiresAt: null,
    });
    expect(await ctx.map.get('link', 'p1')).toBe(shareOf('p1'));
    const page = writer.pages.get(targetId(WS, 'project', 'p1'));
    // the link list now points at the public share, and still names the page
    expect(ctx.report.links()).toEqual([
      {
        oldUrl: 'https://mind.example.com/p/p1',
        newUrl: `https://docs.example.com/share/${writer.shares.get(shareOf('p1')).key}/p/${page.slugId}`,
        pageUrl: `https://docs.example.com/s/${writer.spaces.get(targetId(WS, 'workspace', 'w1')).slug}/p/${page.slugId}?block=${targetId(WS, 'block', 'p1')}`,
      },
    ]);
    expect(ctx.report.get('link.no-expiry')).toBe(1);
  });

  it('a doc project share includes sub-pages', async () => {
    const { writer } = await run({
      projects: [
        msProject({
          id: 'd1',
          workspaceId: 'w1',
          kind: 'doc',
          visibility: 'link',
        }),
      ],
    });
    expect(writer.shares.get(shareOf('d1')).includeSubPages).toBe(true);
  });

  it('a link with a future expiry becomes a share with that same expiry date', async () => {
    const expires = new Date(now + 5 * DAY);
    const { writer, ctx } = await run({
      projects: [
        msProject({
          id: 'p1',
          workspaceId: 'w1',
          visibility: 'link',
          linkExpiresAt: expires,
        }),
      ],
    });
    expect(writer.shares.get(shareOf('p1')).expiresAt).toEqual(expires);
    expect(ctx.report.get('link.live')).toBe(1);
  });

  it('a link whose expiry has passed becomes a share that is already expired', async () => {
    const expired = new Date(now - 2 * DAY);
    const { writer, ctx } = await run({
      projects: [
        msProject({
          id: 'p1',
          workspaceId: 'w1',
          visibility: 'link',
          linkExpiresAt: expired,
        }),
      ],
    });
    expect(writer.shares.get(shareOf('p1')).expiresAt).toEqual(expired);
    expect(ctx.report.get('link.expired')).toBe(1);
  });

  it('a legacy link with no expiry becomes a share with no expiry row', async () => {
    const rec = new RecordingDb();
    const setExact = jest.fn();
    const writer = new ImportWriter(rec.db, new DbImportMap(rec.db, WS), WS, {
      setExact,
    });
    rec.respond = (q) =>
      /^insert into "shares"/.test(q.sql)
        ? [{ id: shareOf('p1'), key: 'k' }]
        : [];
    await writer.createShare({
      id: shareOf('p1'),
      page: { id: 'page-1', spaceId: 's' } as any,
      includeSubPages: false,
      creatorId: 'u',
      map: { type: 'link', sourceId: 'p1' },
    });
    expect(setExact).not.toHaveBeenCalled();
    expect(rec.writesTo('share_expiries')).toEqual([]);
    expect(rec.writesTo('shares')).toHaveLength(1);
  });

  it('the share, its expiry row and its map row are written in one transaction', async () => {
    const rec = new RecordingDb();
    const expiresAt = new Date(now - DAY);
    const setExact = jest.fn(async (_id, _at, _days, _user, trx) => {
      await trx
        .insertInto('shareExpiries')
        .values({ shareId: shareOf('p1') } as any)
        .execute();
      return {} as any;
    });
    const writer = new ImportWriter(rec.db, new DbImportMap(rec.db, WS), WS, {
      setExact,
    });
    rec.respond = (q) =>
      /^insert into "shares"/.test(q.sql)
        ? [{ id: shareOf('p1'), key: 'k' }]
        : [];
    await writer.createShare({
      id: shareOf('p1'),
      page: { id: 'page-1', spaceId: 's' } as any,
      includeSubPages: false,
      creatorId: 'u',
      expiry: { expiresAt, periodDays: 7 },
      map: { type: 'link', sourceId: 'p1' },
    });
    expect(setExact).toHaveBeenCalledWith(
      shareOf('p1'),
      expiresAt,
      7,
      'u',
      expect.anything(),
    );
    const txs = ['shares', 'share_expiries', 'mindspace_import_map'].map(
      (t) => rec.writesTo(t)[0].tx,
    );
    expect(new Set(txs).size).toBe(1);
    expect(rec.events).toEqual([`begin ${txs[0]}`, `commit ${txs[0]}`]);
  });

  it('if setExact fails, the share is not created either', async () => {
    const rec = new RecordingDb();
    const setExact = jest
      .fn()
      .mockRejectedValue(new Error('Invalid expiry period'));
    const writer = new ImportWriter(rec.db, new DbImportMap(rec.db, WS), WS, {
      setExact,
    });
    rec.respond = (q) =>
      /^insert into "shares"/.test(q.sql)
        ? [{ id: shareOf('p1'), key: 'k' }]
        : [];
    await expect(
      writer.createShare({
        id: shareOf('p1'),
        page: { id: 'page-1', spaceId: 's' } as any,
        includeSubPages: false,
        creatorId: 'u',
        expiry: { expiresAt: new Date(), periodDays: 7 },
        map: { type: 'link', sourceId: 'p1' },
      }),
    ).rejects.toThrow('Invalid expiry period');
    // the insert ran inside the transaction that was rolled back
    const [insert] = rec.writesTo('shares');
    expect(rec.events).toEqual([`begin ${insert.tx}`, `rollback ${insert.tx}`]);
    expect(rec.writesTo('mindspace_import_map')).toEqual([]);
  });

  it('a private project gets no share', async () => {
    const { writer, ctx } = await run({
      projects: [msProject({ id: 'p1', workspaceId: 'w1' })],
    });
    expect(writer.shares.size).toBe(0);
    expect(ctx.report.get('link.source')).toBe(0);
  });

  describe('project_shares (Q4: add to the space)', () => {
    const space = targetId(WS, 'workspace', 'w1');
    const grace = docmostUser('d-grace', 'grace@acme.test', { name: 'Grace' });
    const linus = docmostUser('d-linus', 'linus@acme.test', { name: 'Linus' });
    const projects = [
      msProject({ id: 'p1', workspaceId: 'w1', name: 'Roadmap' }),
    ];

    it('a matched recipient becomes a member of the whole space: editor writer, viewer reader', async () => {
      const { writer, ctx } = await run(
        {
          projects,
          projectShares: [
            { projectId: 'p1', email: 'Grace@ACME.test', role: 'editor' },
            { projectId: 'p1', email: 'linus@acme.test', role: 'viewer' },
          ],
        },
        { users: [ada, grace, linus] },
      );
      expect(Object.fromEntries(writer.members.get(space))).toEqual({
        'd-ada': 'admin',
        'd-grace': 'writer',
        'd-linus': 'reader',
      });
      expect(ctx.report.warningsOf('space-member-granted-from-share')).toEqual([
        {
          projectId: 'p1',
          project: 'Roadmap',
          projects: ['Roadmap'],
          email: 'grace@acme.test',
          role: 'writer',
          outcome: 'added',
          note: 'the membership covers the whole space, not only this project',
        },
        {
          projectId: 'p1',
          project: 'Roadmap',
          projects: ['Roadmap'],
          email: 'linus@acme.test',
          role: 'reader',
          outcome: 'added',
          note: 'the membership covers the whole space, not only this project',
        },
      ]);
      expect(ctx.report.warningsOf('project-share-not-mapped')).toEqual([]);
      expect(ctx.report.get('project-share.imported')).toBe(2);
      expect(ctx.report.mismatches()).toEqual([]);
    });

    it('nobody becomes admin, a higher role is kept, and a lower one is raised', async () => {
      const { writer, ctx } = await run(
        {
          users: [
            msUser('m-ada', 'ada@acme.test'),
            msUser('m-grace', 'grace@acme.test'),
            msUser('m-linus', 'linus@acme.test'),
          ],
          members: [
            { workspaceId: 'w1', userId: 'm-grace', role: 'editor' },
            { workspaceId: 'w1', userId: 'm-linus', role: 'viewer' },
          ],
          projects,
          projectShares: [
            { projectId: 'p1', email: 'ada@acme.test', role: 'editor' }, // the owner, admin
            { projectId: 'p1', email: 'grace@acme.test', role: 'viewer' }, // already writer
            { projectId: 'p1', email: 'linus@acme.test', role: 'editor' }, // reader, raised
          ],
        },
        { users: [ada, grace, linus] },
      );
      expect(Object.fromEntries(writer.members.get(space))).toEqual({
        'd-ada': 'admin',
        'd-grace': 'writer',
        'd-linus': 'writer',
      });
      expect(
        ctx.report
          .warningsOf('space-member-granted-from-share')
          .map((w) => [w.email, w.outcome]),
      ).toEqual([['linus@acme.test', 'raised']]);
      expect(ctx.report.get('project-share.imported')).toBe(1);
      // kept because they already had the role: not "already imported" on a first run
      expect(ctx.report.get('project-share.kept')).toBe(2);
      expect(ctx.report.get('project-share.already-imported')).toBe(0);
      expect(ctx.report.mismatches()).toEqual([]);
    });

    it('an unmatched recipient is invited with --invite-unmatched and added on a re-run once they accept', async () => {
      const map = new MemoryImportMap();
      const writer = new RecordingWriter(map, WS);
      const invites = new FakeInviter();
      const data = {
        projects,
        projectShares: [
          {
            projectId: 'p1',
            email: 'friend@outside.test',
            role: 'viewer' as const,
          },
        ],
      };
      const first = await run(data, {
        map,
        writer,
        invites,
        options: { inviteUnmatched: true },
      });
      expect(invites.sent).toEqual([['friend@outside.test']]);
      expect(first.ctx.report.invited()).toEqual([
        {
          email: 'friend@outside.test',
          status: 'invited',
          for: ['project share'],
        },
      ]);
      expect(first.ctx.report.get('project-share.skipped.unmatched')).toBe(1);
      expect(writer.members.get(space).has('d-friend')).toBe(false);

      const friend = docmostUser('d-friend', 'friend@outside.test');
      const second = await run(data, {
        map,
        writer,
        invites,
        users: [ada, friend],
        options: { inviteUnmatched: true },
      });
      expect(writer.members.get(space).get('d-friend')).toBe('reader');
      expect(second.ctx.report.get('project-share.imported')).toBe(1);
      expect(invites.sent).toHaveLength(1);
    });

    it('without --invite-unmatched an unmatched recipient is only reported', async () => {
      const invites = new FakeInviter();
      const { ctx } = await run(
        {
          projects,
          projectShares: [
            { projectId: 'p1', email: 'friend@outside.test', role: 'viewer' },
          ],
        },
        { invites },
      );
      expect(invites.sent).toEqual([]);
      expect(ctx.report.warningsOf('project-share-unmatched')).toEqual([
        {
          projectId: 'p1',
          project: 'Roadmap',
          email: 'friend@outside.test',
          role: 'viewer',
          reason: 'no docmost account with this email',
        },
      ]);
      expect(ctx.report.mismatches()).toEqual([]);
    });

    it('a share address that is not an email is never invited', async () => {
      const invites = new FakeInviter();
      const { ctx } = await run(
        {
          projects,
          projectShares: [
            { projectId: 'p1', email: 'not an address', role: 'viewer' },
            { projectId: 'p1', email: 'friend@outside.test', role: 'viewer' },
          ],
        },
        { invites, options: { inviteUnmatched: true } },
      );
      expect(invites.sent).toEqual([['friend@outside.test']]);
      expect(ctx.report.invited()).toEqual([
        {
          email: 'not an address',
          status: 'invalid-email',
          for: ['project share'],
        },
        {
          email: 'friend@outside.test',
          status: 'invited',
          for: ['project share'],
        },
      ]);
    });

    it('a recipient matching two accounts that differ only by case gets no grant and no invitation', async () => {
      const invites = new FakeInviter();
      const { writer, ctx } = await run(
        {
          projects,
          projectShares: [
            { projectId: 'p1', email: 'GRACE@acme.test', role: 'editor' },
          ],
        },
        {
          users: [ada, grace, docmostUser('d-grace-2', 'Grace@Acme.test')],
          invites,
          options: { inviteUnmatched: true },
        },
      );
      expect(Object.fromEntries(writer.members.get(space))).toEqual({
        'd-ada': 'admin',
      });
      expect(ctx.report.warningsOf('user-ambiguous')).toEqual([
        { email: 'grace@acme.test', count: 2 },
      ]);
      expect(ctx.report.get('project-share.skipped.ambiguous')).toBe(1);
      expect(invites.sent).toEqual([]);
      expect(ctx.report.mismatches()).toEqual([]);
    });

    it('recipients of a workspace waiting for its owner are listed for later, not invited now', async () => {
      const invites = new FakeInviter();
      const { ctx } = await run(
        {
          users: [msUser('m-olga', 'olga@acme.test')],
          workspaces: [msWorkspace('w1', 'Olga', 'm-olga')],
          projects,
          projectShares: [
            { projectId: 'p1', email: 'friend@outside.test', role: 'viewer' },
          ],
        },
        { users: [], invites, options: { inviteUnmatched: true } },
      );
      expect(invites.sent).toEqual([['olga@acme.test']]);
      expect(ctx.report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'invited',
          for: ['workspace member'],
        },
        {
          email: 'friend@outside.test',
          status: 'would-invite-later',
          for: ['project share'],
          reason: 'waits for the owner of workspace w1 ("Olga")',
        },
      ]);
    });

    it('a recipient waiting on one workspace is still invited for a share in a ready one', async () => {
      const invites = new FakeInviter();
      const { ctx } = await run(
        {
          users: [
            msUser('m-ada', 'ada@acme.test'),
            msUser('m-olga', 'olga@acme.test'),
          ],
          workspaces: [
            msWorkspace('w0', 'Olga', 'm-olga'),
            msWorkspace('w1', 'Team', 'm-ada'),
          ],
          projects: [
            msProject({ id: 'waiting', workspaceId: 'w0', position: 1 }),
            msProject({ id: 'ready', workspaceId: 'w1', position: 2 }),
          ],
          projectShares: [
            { projectId: 'waiting', email: 'x@outside.test', role: 'viewer' },
            { projectId: 'ready', email: 'x@outside.test', role: 'viewer' },
          ],
        },
        { invites, options: { inviteUnmatched: true } },
      );
      expect(invites.sent.flat()).toContain('x@outside.test');
      expect(
        ctx.report.invited().find((i) => i.email === 'x@outside.test'),
      ).toMatchObject({ status: 'invited' });
    });

    it('--no-new-invites lists a recipient still waiting for an owner', async () => {
      const { ctx } = await run(
        {
          users: [msUser('m-olga', 'olga@acme.test')],
          workspaces: [msWorkspace('w1', 'Olga', 'm-olga')],
          projects,
          projectShares: [
            { projectId: 'p1', email: 'friend@outside.test', role: 'viewer' },
          ],
        },
        {
          users: [],
          invites: new FakeInviter(),
          options: { noNewInvites: true },
        },
      );
      expect(
        ctx.report.invited().map((i) => [i.email, i.status]),
      ).toContainEqual(['friend@outside.test', 'would-invite-later']);
    });

    it('an unknown share role grants nothing and is reported', async () => {
      const { writer, ctx } = await run(
        {
          users: [
            msUser('m-ada', 'ada@acme.test'),
            msUser('m-linus', 'linus@acme.test'),
          ],
          members: [{ workspaceId: 'w1', userId: 'm-linus', role: 'viewer' }],
          projects,
          projectShares: [
            { projectId: 'p1', email: 'grace@acme.test', role: 'owner' as any },
            {
              projectId: 'p1',
              email: 'linus@acme.test',
              role: 'constructor' as any,
            },
            {
              projectId: 'p1',
              email: 'linus@acme.test',
              role: 'Editor' as any,
            },
          ],
        },
        { users: [ada, grace, linus] },
      );
      expect(Object.fromEntries(writer.members.get(space))).toEqual({
        'd-ada': 'admin',
        'd-linus': 'reader',
      });
      expect(ctx.report.warningsOf('share-role-unknown')).toEqual([
        {
          projectId: 'p1',
          project: 'Roadmap',
          email: 'grace@acme.test',
          role: 'owner',
        },
        {
          projectId: 'p1',
          project: 'Roadmap',
          email: 'linus@acme.test',
          role: 'constructor',
        },
        {
          projectId: 'p1',
          project: 'Roadmap',
          email: 'linus@acme.test',
          role: 'Editor',
        },
      ]);
      expect(ctx.report.warningsOf('space-member-granted-from-share')).toEqual(
        [],
      );
      expect(ctx.report.get('project-share.skipped.unknown-role')).toBe(3);
      expect(ctx.report.mismatches()).toEqual([]);
    });

    it('two shares to one person in one space: one grant that names both projects', async () => {
      const { ctx } = await run(
        {
          projects: [
            ...projects,
            msProject({
              id: 'p2',
              workspaceId: 'w1',
              name: 'Launch',
              position: 2048,
            }),
          ],
          projectShares: [
            { projectId: 'p1', email: 'grace@acme.test', role: 'viewer' },
            { projectId: 'p2', email: 'grace@acme.test', role: 'viewer' },
          ],
        },
        { users: [ada, grace] },
      );
      expect(ctx.report.warningsOf('space-member-granted-from-share')).toEqual([
        {
          projectId: 'p1',
          project: 'Roadmap',
          projects: ['Roadmap', 'Launch'],
          email: 'grace@acme.test',
          role: 'reader',
          outcome: 'added',
          note: 'the membership covers the whole space, not only this project',
        },
      ]);
      expect(ctx.report.get('project-share.imported')).toBe(1);
      expect(ctx.report.get('project-share.kept')).toBe(1);
    });

    it('a re-run does not undo what an admin changed: a removed or demoted member stays so', async () => {
      const map = new MemoryImportMap();
      const writer = new RecordingWriter(map, WS);
      const data = {
        projects,
        projectShares: [
          {
            projectId: 'p1',
            email: 'grace@acme.test',
            role: 'editor' as const,
          },
          {
            projectId: 'p1',
            email: 'linus@acme.test',
            role: 'viewer' as const,
          },
        ],
      };
      await run(data, { map, writer, users: [ada, grace, linus] });
      // after cut-over a space admin removes linus and demotes grace
      writer.members.get(space).delete('d-linus');
      writer.members.get(space).set('d-grace', 'reader');

      const again = await run(data, {
        map,
        writer,
        users: [ada, grace, linus],
      });
      expect(Object.fromEntries(writer.members.get(space))).toEqual({
        'd-ada': 'admin',
        'd-grace': 'reader',
      });
      expect(again.ctx.report.get('project-share.already-imported')).toBe(2);
      expect(
        again.ctx.report.warningsOf('space-member-granted-from-share'),
      ).toEqual([]);
    });

    it('a share of a workspace that was not migrated grants nothing', async () => {
      const { writer, ctx } = await run(
        {
          users: [msUser('m-olga', 'olga@acme.test')],
          workspaces: [msWorkspace('w1', 'Olga', 'm-olga')],
          projects,
          projectShares: [
            { projectId: 'p1', email: 'grace@acme.test', role: 'editor' },
          ],
        },
        { users: [grace] },
      );
      expect(writer.members.size).toBe(0);
      expect(ctx.report.get('project-share.skipped.owner-unmatched')).toBe(1);
      expect(ctx.report.mismatches()).toEqual([]);
    });

    it('a dry run reports the same grants and grants against members docmost already has', async () => {
      const data = {
        projects,
        projectShares: [
          {
            projectId: 'p1',
            email: 'linus@acme.test',
            role: 'editor' as const,
          },
        ],
      };
      // linus is already a reader of the space in docmost (an earlier real run)
      const map = new MemoryImportMap();
      await map.set('workspace', 'w1', 'space', space);
      const { ctx, writer } = await run(data, {
        map,
        users: [ada, linus],
        members: {
          [space]: [
            { userId: 'd-ada', role: 'admin' },
            { userId: 'd-linus', role: 'reader' },
          ],
        },
      });
      expect(writer.members.get(space).get('d-linus')).toBe('writer');
      expect(
        ctx.report
          .warningsOf('space-member-granted-from-share')
          .map((w) => w.outcome),
      ).toEqual(['raised']);
    });
  });

  it('a second run creates no second share', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const data = {
      projects: [
        msProject({
          id: 'p1',
          workspaceId: 'w1',
          visibility: 'link' as const,
          linkExpiresAt: new Date(now + DAY),
        }),
      ],
    };
    await run(data, { map, writer });
    const before = writer.operations.length;
    const { ctx } = await run(data, { map, writer });
    expect(writer.operations.length).toBe(before);
    expect(ctx.report.get('link.already-imported')).toBe(1);
    expect(ctx.report.links()[0].newUrl).toContain('/share/');
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('a link of a workspace that was not migrated is skipped', async () => {
    const { writer, ctx } = await run({
      users: [msUser('m-olga', 'olga@acme.test')],
      workspaces: [msWorkspace('w1', 'Olga', 'm-olga')],
      projects: [
        msProject({ id: 'p1', workspaceId: 'w1', visibility: 'link' }),
      ],
    });
    expect(writer.shares.size).toBe(0);
    expect(ctx.report.get('link.skipped.owner-unmatched')).toBe(1);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  describe('which address the redirect list gives', () => {
    const past = new Date(Date.now() - 86400_000);
    const future = new Date(Date.now() + 86400_000);
    const linkOf = (ctx: any, id: string) =>
      ctx.report.links().find((l: any) => l.oldUrl.endsWith(`/p/${id}`));

    it('a live link redirects to the share; an expired one to the page', async () => {
      const { ctx, writer } = await run({
        projects: [
          msProject({
            id: 'live',
            workspaceId: 'w1',
            visibility: 'link',
            linkExpiresAt: future,
          }),
          msProject({
            id: 'old',
            workspaceId: 'w1',
            visibility: 'link',
            linkExpiresAt: past,
            position: 2048,
          }),
        ],
      });
      expect(linkOf(ctx, 'live').newUrl).toContain('/share/');
      expect(linkOf(ctx, 'old').newUrl).not.toContain('/share/');
      expect(linkOf(ctx, 'old').newUrl).toContain(
        writer.pages.get(targetId(WS, 'project', 'old')).slugId,
      );
    });

    it('when sharing is off for the space the redirect goes to the page', async () => {
      const { ctx } = await run(
        {
          projects: [
            msProject({ id: 'p1', workspaceId: 'w1', visibility: 'link' }),
          ],
        },
        { sharingOff: true },
      );
      expect(linkOf(ctx, 'p1').newUrl).not.toContain('/share/');
    });
  });
});
