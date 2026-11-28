import * as Y from 'yjs';
import { sheet } from '@docmost/live-blocks';
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

import { MemoryImportMap, targetId } from './import-map';
import { RecordingWriter } from './recording-writer';
import { linksCsv } from './mindspace-import.service';
import { ALL_STEPS } from './steps';
import {
  msComment,
  msDocument,
  msProject,
  msUser,
  msWorkspace,
  type FakeData,
} from './testing/fake-source';
import {
  overviewMarkdown,
  whiteboardScene,
  budgetBook,
} from './testing/synthetic-mindspace';
import { WS, docmostUser, testContext } from './testing/test-context';
import { verifyImport } from './verify';
import { peopleStep } from './steps/people.step';

const ada = docmostUser('d-ada', 'ada@acme.test', { name: 'Ada' });
const grace = docmostUser('d-grace', 'grace@acme.test', { name: 'Grace' });
const DAY = 86_400_000;

const data = (): FakeData => ({
  users: [
    msUser('m-ada', 'ada@acme.test'),
    msUser('m-grace', 'grace@acme.test'),
  ],
  workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
  members: [{ workspaceId: 'w1', userId: 'm-grace', role: 'editor' }],
  projects: [
    msProject({
      id: 'wb',
      workspaceId: 'w1',
      scene: whiteboardScene,
      visibility: 'link',
      linkExpiresAt: new Date(Date.now() + DAY),
    }),
    msProject({
      id: 'legacy',
      workspaceId: 'w1',
      position: 2048,
      visibility: 'link',
    }),
    msProject({ id: 'dp', workspaceId: 'w1', kind: 'doc', position: 3072 }),
  ],
  documents: [
    msDocument({ id: 'd1', projectId: 'dp', content: overviewMarkdown }),
    msDocument({
      id: 'd2',
      projectId: 'dp',
      position: 1,
      content: 'Short note.',
    }),
  ],
  comments: [
    msComment({ id: 'c1', documentId: 'd1', anchorQuote: 'Read the source' }),
    msComment({ id: 'c2', documentId: 'd1', parentId: 'c1' }),
    msComment({
      id: 'orphan',
      documentId: 'd2',
      anchorQuote: 'not in the text',
    }),
  ],
});

async function imported(d: FakeData = data(), acceptLoss: string[] = []) {
  const world = testContext(d, {
    users: [ada, grace],
    options: { acceptLoss },
  });
  for (const step of ALL_STEPS) await step.run(world.ctx);
  return world;
}

async function verified(world: Awaited<ReturnType<typeof imported>>) {
  await verifyImport(world.ctx, ALL_STEPS);
  return world.ctx.report.mismatches();
}

describe('verify', () => {
  it('verify passes when every source row is accounted for', async () => {
    const world = await imported();
    expect(await verified(world)).toEqual([]);
  });

  it('an orphaned comment does not fail verify', async () => {
    const world = await imported();
    expect(world.ctx.report.get('comment.orphaned')).toBe(1);
    expect(await verified(world)).toEqual([]);
  });

  it('verify fails when a project has no page', async () => {
    const world = await imported();
    world.writer.pages.delete(targetId(WS, 'project', 'wb'));
    expect(await verified(world)).toEqual([
      `project wb ("Project wb") has no page in docmost`,
    ]);
  });

  it('verify fails when a page exists but its block has fewer elements than the source', async () => {
    const world = await imported();
    const block = world.writer.blocks.get(targetId(WS, 'block', 'wb'));
    (block.snapshot as any).elements = (block.snapshot as any).elements.slice(
      0,
      1,
    );
    expect(await verified(world)).toEqual([
      'project wb ("Project wb") is emptier in docmost than in mindspace: elements 1 of 4',
    ]);
  });

  it('a content mismatch passes once that project is in --accept-loss', async () => {
    const world = await imported(data(), ['wb']);
    const block = world.writer.blocks.get(targetId(WS, 'block', 'wb'));
    (block.snapshot as any).elements = [];
    (block.snapshot as any).files = {};
    expect(await verified(world)).toEqual([]);
    expect(world.ctx.report.warningsOf('accepted-loss')).toEqual([
      {
        projectId: 'wb',
        what: 'project wb ("Project wb") is emptier in docmost than in mindspace: elements 0 of 4, images 0 of 1',
      },
    ]);
  });

  it('verify fails on a scene-invalid loss, and passes once that project is in --accept-loss', async () => {
    const broken = data();
    broken.projects.push(
      msProject({
        id: 'bad',
        workspaceId: 'w1',
        scene: '{"elements": [',
        position: 9000,
      }),
    );
    const failing = await imported(broken);
    expect(await verified(failing)).toEqual([
      expect.stringMatching(
        /^unaccepted loss in project bad: scene-invalid \{.*"reason":"the scene is not valid JSON/,
      ),
    ]);
    const accepted = await imported(broken, ['bad']);
    expect(await verified(accepted)).toEqual([]);
  });

  it('verify fails when a comment is neither imported nor counted as skipped', async () => {
    const world = await imported();
    // a comment the steps never saw, as if a reader had dropped it
    world.ctx.report.count('comment.source');
    expect(await verified(world)).toEqual([
      'comment: 4 in mindspace, but 3 imported, already imported, skipped or failed',
    ]);
  });

  it('verify fails when a document has fewer comment replies than its source', async () => {
    const world = await imported();
    world.writer.comments.delete(targetId(WS, 'comment', 'c2'));
    expect(await verified(world)).toEqual([
      'document d1 ("d1.md") has 1 thread(s) and 0 reply(ies) in docmost, 1 and 1 in mindspace',
    ]);
  });

  it('verify fails when an imported link that had an expiry has no expiry row', async () => {
    const world = await imported();
    world.writer.shares.get(targetId(WS, 'share', 'wb')).expiresAt = null;
    expect(await verified(world)).toEqual([
      'the link of project wb had an expiry in mindspace but its share has no expiry',
    ]);
  });

  it('verify fails when a share has an expiry its source link did not have', async () => {
    const world = await imported();
    world.writer.shares.get(targetId(WS, 'share', 'legacy')).expiresAt =
      new Date();
    expect(await verified(world)).toEqual([
      'the link of project legacy had no expiry in mindspace but its share expires',
    ]);
  });

  it('the links CSV has exactly one line per project and none per document', async () => {
    const world = await imported();
    const lines = linksCsv(world.ctx.report).trim().split('\n');
    expect(lines[0]).toBe('old_url,new_url');
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual([
      'https://mind.example.com/p/wb',
      'https://mind.example.com/p/legacy',
      'https://mind.example.com/p/dp',
    ]);
  });

  it('verify fails when a project page has no block', async () => {
    const world = await imported();
    world.writer.blocks.delete(targetId(WS, 'block', 'wb'));
    expect(await verified(world)).toEqual([
      'project wb ("Project wb") has no block on its page',
    ]);
  });

  it('verify fails when a document has no page, and a page in the trash counts as missing', async () => {
    const gone = await imported();
    gone.writer.pages.delete(targetId(WS, 'document', 'd2'));
    expect(await verified(gone)).toEqual([
      'document d2 ("d2.md") has no page in docmost',
    ]);

    const trashed = await imported();
    (
      trashed.writer.pages.get(targetId(WS, 'document', 'd2')) as any
    ).deletedAt = new Date();
    (trashed.writer.pages.get(targetId(WS, 'project', 'dp')) as any).deletedAt =
      new Date();
    expect(await verified(trashed)).toEqual([
      'project dp ("Project dp") has no page in docmost',
    ]);
  });

  it('verify fails when a link has no share', async () => {
    const world = await imported();
    world.writer.shares.delete(targetId(WS, 'share', 'legacy'));
    expect(await verified(world)).toEqual([
      'the link of project legacy has no share in docmost',
    ]);
  });

  it('verify fails when a space has a member who was not in mindspace, lacks one, or has another role', async () => {
    const space = targetId(WS, 'workspace', 'w1');
    const extra = await imported();
    extra.writer.members.get(space).set('d-intruder', 'reader');
    expect(await verified(extra)).toEqual([
      'space of workspace w1 ("Team") has a member who was not in mindspace: d-intruder (reader)',
    ]);

    const missing = await imported();
    missing.writer.members.get(space).delete('d-grace');
    expect(await verified(missing)).toEqual([
      'space of workspace w1 ("Team") is missing member d-grace (writer)',
    ]);

    const role = await imported();
    role.writer.members.get(space).set('d-grace', 'admin');
    expect(await verified(role)).toEqual([
      'space of workspace w1 ("Team") gives d-grace the role admin, not writer',
    ]);
  });

  it('a space made for the fallback owner passes once the real owner has an account, with both as admins', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const d: FakeData = {
      users: [
        msUser('m-olga', 'olga@acme.test'),
        msUser('m-ada', 'ada@acme.test'),
      ],
      workspaces: [msWorkspace('w9', 'Olga', 'm-olga')],
      members: [{ workspaceId: 'w9', userId: 'm-ada', role: 'viewer' }],
      projects: [msProject({ id: 'o1', workspaceId: 'w9' })],
    };
    const run = async (users: ReturnType<typeof docmostUser>[]) => {
      const world = testContext(d, {
        users,
        map,
        writer,
        options: { grantFallbackAdmin: true },
      });
      for (const step of ALL_STEPS) await step.run(world.ctx);
      await verifyImport(world.ctx, ALL_STEPS);
      return world.ctx.report;
    };
    // olga has no docmost account: the fallback owner is the space's admin
    expect((await run([ada])).mismatches()).toEqual([]);
    // later olga signs up and the import runs again
    const olga = docmostUser('d-olga', 'olga@acme.test', { name: 'Olga' });
    const again = await run([ada, olga]);
    expect(again.mismatches()).toEqual([]);
    expect(
      Object.fromEntries(writer.members.get(targetId(WS, 'workspace', 'w9'))),
    ).toEqual({
      'fallback-user': 'admin',
      'd-ada': 'reader',
      'd-olga': 'admin',
    });
    expect(again.warningsOf('space-owner-added')).toEqual([
      { workspaceId: 'w9', name: 'Olga', ownerEmail: 'olga@acme.test' },
    ]);
  });

  it('a member granted from a project share passes the member check with its role', async () => {
    const d = data();
    d.users.push(msUser('m-linus', 'linus@acme.test'));
    d.projectShares = [
      { projectId: 'wb', email: 'linus@acme.test', role: 'viewer' },
      // grace is an editor member already: a viewer share keeps her writer role
      { projectId: 'wb', email: 'grace@acme.test', role: 'viewer' },
    ];
    const world = testContext(d, {
      users: [ada, grace, docmostUser('d-linus', 'linus@acme.test')],
    });
    for (const step of ALL_STEPS) await step.run(world.ctx);
    await verifyImport(world.ctx, ALL_STEPS);
    expect(world.ctx.report.mismatches()).toEqual([]);
    expect(
      world.writer.members.get(targetId(WS, 'workspace', 'w1')).get('d-linus'),
    ).toBe('reader');
  });

  describe('sheets are checked against the seeded workbook', () => {
    const withSheet = (scene: unknown) => {
      const d = data();
      d.projects.push(
        msProject({
          id: 'sh',
          workspaceId: 'w1',
          kind: 'sheet',
          scene,
          position: 9000,
        }),
      );
      return d;
    };

    it('a book bigger than a snapshot keeps passes: the document holds every cell', async () => {
      const big = budgetBook();
      for (let r = 10; r < 1110; r++)
        for (let c = 0; c < 50; c++)
          big.sheets[1].cells[`${r}:${c}`] = { v: String(r + c) };
      big.sheets[1].rows = 1200;
      big.sheets[1].cols = 60;
      const world = await imported(withSheet(big));
      expect(
        (world.writer.blocks.get(targetId(WS, 'block', 'sh')).snapshot as any)
          .truncated,
      ).toBe(true);
      expect(await verified(world)).toEqual([]);
    });

    it('a book wrapped as { book } is seeded whole, not empty', async () => {
      const world = await imported(withSheet({ book: budgetBook() }));
      const doc = world.writer.blockDocs.get(targetId(WS, 'block', 'sh'));
      expect(sheet.readBook(doc).sheets.map((t) => t.name)).toEqual([
        'Budget',
        'Rates',
      ]);
      expect(await verified(world)).toEqual([]);
    });

    it('an empty seeded document fails verify', async () => {
      const world = await imported(withSheet(budgetBook()));
      const blockId = targetId(WS, 'block', 'sh');
      // the document lost its tabs; the snapshot still looks complete
      world.writer.blockDocs.set(blockId, new Y.Doc());
      expect(await verified(world)).toEqual([
        'project sh ("Project sh") is emptier in docmost than in mindspace: tabs 0 of 2, cells 0 of 25',
      ]);
    });
  });

  describe('document content', () => {
    it('a document page holding less text than its markdown fails verify with a per-document loss', async () => {
      const world = await imported();
      const pageId = targetId(WS, 'document', 'd2');
      const page = world.writer.pages.get(pageId) as any;
      page.content = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Short' }] },
        ],
      };
      await verifyImport(world.ctx, ALL_STEPS);
      expect(world.ctx.report.losses()).toEqual([
        expect.objectContaining({
          code: 'document-content-shorter',
          projectId: 'dp',
          detail: expect.objectContaining({ documentId: 'd2' }),
        }),
      ]);
      expect(world.ctx.report.mismatches()).toEqual([
        expect.stringMatching(
          /^unaccepted loss in project dp: document-content-shorter/,
        ),
      ]);
    });

    it('--accept-loss for the project accepts it', async () => {
      const world = await imported(data(), ['dp']);
      (world.writer.pages.get(targetId(WS, 'document', 'd2')) as any).content =
        { type: 'doc', content: [] };
      expect(await verified(world)).toEqual([]);
    });

    it('a converted document passes: markdown syntax is not counted as text', async () => {
      const d = data();
      d.documents.push(
        msDocument({
          id: 'rich',
          projectId: 'dp',
          content:
            '# Title\n\n- **bold** item\n- [a link](https://x.test)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n> quoted',
        }),
      );
      expect(await verified(await imported(d))).toEqual([]);
    });
  });

  describe('items an earlier run imported', () => {
    it('changes made in docmost since are drift warnings, never failures', async () => {
      const map = new MemoryImportMap();
      const writer = new RecordingWriter(map, WS);
      const run = async () => {
        const world = testContext(data(), { users: [ada, grace], map, writer });
        for (const step of ALL_STEPS) await step.run(world.ctx);
        await verifyImport(world.ctx, ALL_STEPS);
        return world.ctx.report;
      };
      expect((await run()).mismatches()).toEqual([]);

      // a week of ordinary use
      const block = writer.blocks.get(targetId(WS, 'block', 'wb'));
      (block.snapshot as any).elements = [];
      writer.shares.delete(targetId(WS, 'share', 'legacy'));
      (writer.pages.get(targetId(WS, 'document', 'd2')) as any).content = {
        type: 'doc',
        content: [],
      };
      writer.members
        .get(targetId(WS, 'workspace', 'w1'))
        .set('d-newcomer', 'reader');

      const report = await run();
      expect(report.mismatches()).toEqual([]);
      const drift = report.warningsOf('drift').map((w: any) => w.what);
      expect(drift).toEqual(
        expect.arrayContaining([
          expect.stringContaining('is emptier in docmost than in mindspace'),
          'the link of project legacy has no share in docmost',
          expect.stringContaining('document-content-shorter'),
          expect.stringContaining('d-newcomer'),
        ]),
      );
    });

    it('the same differences on items this run imported still fail', async () => {
      const world = await imported();
      (
        world.writer.blocks.get(targetId(WS, 'block', 'wb')).snapshot as any
      ).elements = [];
      expect(await verified(world)).toEqual([
        expect.stringContaining('is emptier in docmost than in mindspace'),
      ]);
    });
  });

  it('removed unsafe elements are explained; a missing element for any other reason still fails', async () => {
    const d = data();
    const wb = d.projects.find((p) => p.id === 'wb');
    wb.scene = {
      ...(whiteboardScene as any),
      elements: [
        ...(whiteboardScene as any).elements,
        { id: 'bad', type: 'iframe', x: 0, y: 0, width: 1, height: 1 },
      ],
    };
    expect(await verified(await imported(d))).toEqual([]);
    // the same board, short one element the cleaning did not report
    const world = testContext(d, { users: [ada, grace] });
    for (const step of ALL_STEPS) await step.run(world.ctx);
    (
      world.writer.blocks.get(targetId(WS, 'block', 'wb')).snapshot as any
    ).elements.pop();
    expect(await verified(world)).toEqual([
      expect.stringContaining('is emptier in docmost than in mindspace'),
    ]);
  });

  describe('a run that never reached verify', () => {
    const shared = () => {
      const map = new MemoryImportMap();
      return { map, writer: new RecordingWriter(map, WS) };
    };
    // one source for every run of a test, as a frozen mindspace is
    let source: FakeData;
    beforeEach(() => (source = data()));
    const runOnce = async (w: ReturnType<typeof shared>, verify: boolean) => {
      const world = testContext(source, { users: [ada, grace], ...w });
      for (const step of ALL_STEPS) await step.run(world.ctx);
      if (verify) await verifyImport(world.ctx, ALL_STEPS);
      return world.ctx.report;
    };

    it('its items are still held to the source by the next run: a difference fails, it is not drift', async () => {
      const w = shared();
      await runOnce(w, false); // killed before verify
      (
        w.writer.blocks.get(targetId(WS, 'block', 'wb')).snapshot as any
      ).elements = [];
      const report = await runOnce(w, true);
      expect(report.mismatches()).toEqual([
        expect.stringContaining('is emptier in docmost than in mindspace'),
      ]);
      expect(report.warningsOf('drift')).toEqual([]);
    });

    it('a run that failed verify leaves its items held too; once they pass, later changes are drift', async () => {
      const w = shared();
      await runOnce(w, false);
      const block = w.writer.blocks.get(targetId(WS, 'block', 'wb'))
        .snapshot as any;
      const saved = block.elements;
      block.elements = [];
      expect((await runOnce(w, true)).mismatches()).toHaveLength(1);
      expect((await runOnce(w, true)).mismatches()).toHaveLength(1);
      block.elements = saved;
      expect((await runOnce(w, true)).mismatches()).toEqual([]);
      block.elements = [];
      const after = await runOnce(w, true);
      expect(after.mismatches()).toEqual([]);
      expect(after.warningsOf('drift')).toHaveLength(1);
    });
  });

  it('a member skipped for an unknown role is explained, named, and does not fail verify', async () => {
    const d = data();
    d.members = [
      { workspaceId: 'w1', userId: 'm-grace', role: 'owner' as any },
    ];
    const world = await imported(d);
    expect(await verified(world)).toEqual([]);
    expect(world.ctx.report.warningsOf('member-role-unknown')).toEqual([
      { workspace: 'Team', email: 'grace@acme.test', role: 'owner' },
    ]);
  });

  describe('document words', () => {
    const passes = async (content: string) => {
      const d = data();
      d.documents.push(msDocument({ id: 'x', projectId: 'dp', content }));
      return verified(await imported(d));
    };

    it.each([
      ['image alt text', 'Before ![Q3 chart](https://x.test/c.png) after'],
      ['HTML entities', 'Fish &amp; chips&nbsp;today, it&#39;s fine'],
      [
        'reference-style link definitions',
        'See [the spec][1].\n\n[1]: https://x.test "Spec title"',
      ],
      ['footnote definitions', 'A claim[^1].\n\n[^1]: The source.'],
      ['comparison signs in prose', 'a < b and c > d hold'],
      [
        'inline and block math',
        'Area $x^2 + y$ here.\n\n$$\n\\int_0^1 f\n$$\n\nDone.',
      ],
    ])('a correct import passes with %s', async (_what, content) => {
      expect(await passes(content)).toEqual([]);
    });

    it('a word really missing still fails, also between two comparison signs', async () => {
      const world = await imported(
        (() => {
          const d = data();
          d.documents.push(
            msDocument({
              id: 'x',
              projectId: 'dp',
              content: 'a < b\n\nimportant paragraph\n\nc > d',
            }),
          );
          return d;
        })(),
      );
      const page = world.writer.pages.get(targetId(WS, 'document', 'x')) as any;
      page.content = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'a < b' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'c > d' }] },
        ],
      };
      await verifyImport(world.ctx, ALL_STEPS);
      expect(world.ctx.report.losses()).toEqual([
        expect.objectContaining({
          code: 'document-content-shorter',
          detail: expect.objectContaining({
            documentId: 'x',
            sample: ['important', 'paragraph'],
          }),
        }),
      ]);
    });
  });

  describe('an item a later run writes to', () => {
    it('a space verified on day 0 is held to the source again when day 3 grants in it', async () => {
      const map = new MemoryImportMap();
      const writer = new RecordingWriter(map, WS);
      const linus = docmostUser('d-linus', 'linus@acme.test');
      const day0 = data();
      const runWith = async (d: FakeData, users = [ada, grace]) => {
        const world = testContext(d, { users, map, writer });
        for (const step of ALL_STEPS) await step.run(world.ctx);
        await verifyImport(world.ctx, ALL_STEPS);
        return world.ctx.report;
      };
      expect((await runWith(day0)).mismatches()).toEqual([]);
      expect(await map.verified('workspace', 'w1')).toBe(true);

      // day 3: linus signed up; his viewer share is granted, but wrongly as writer
      const day3: FakeData = {
        ...day0,
        projectShares: [
          { projectId: 'wb', email: 'linus@acme.test', role: 'viewer' },
        ],
      };
      const grant = writer.grantSpaceRole.bind(writer);
      writer.grantSpaceRole = (spaceId, userId, _role, m) =>
        grant(spaceId, userId, 'writer', m);
      const report = await runWith(day3, [ada, grace, linus]);
      expect(report.mismatches()).toEqual([
        expect.stringContaining('the role writer, not reader'),
      ]);
      expect(report.warningsOf('drift')).toEqual([]);
    });

    it('a run with --only people does not mark a workspace passed for its share grants', async () => {
      const map = new MemoryImportMap();
      const writer = new RecordingWriter(map, WS);
      const d = data();
      d.users.push(msUser('m-linus', 'linus@acme.test'));
      d.projectShares = [
        { projectId: 'wb', email: 'linus@acme.test', role: 'viewer' },
      ];
      const users = [ada, grace, docmostUser('d-linus', 'linus@acme.test')];
      const world = testContext(d, { users, map, writer });
      await peopleStep.run(world.ctx);
      await verifyImport(world.ctx, [peopleStep]);
      expect(world.ctx.report.mismatches()).toEqual([]);
      expect(await map.verified('workspace', 'w1')).toBe(false);
    });
  });

  describe('strict per written thing', () => {
    const linus = docmostUser('d-linus', 'linus@acme.test');
    const setup = async () => {
      const map = new MemoryImportMap();
      const writer = new RecordingWriter(map, WS);
      const day0 = data();
      const runWith = async (d: FakeData, users = [ada, grace]) => {
        const world = testContext(d, { users, map, writer });
        for (const step of ALL_STEPS) await step.run(world.ctx);
        await verifyImport(world.ctx, ALL_STEPS);
        return world.ctx.report;
      };
      expect((await runWith(day0)).mismatches()).toEqual([]);
      // day 2: an admin makes grace a space admin
      writer.members
        .get(targetId(WS, 'workspace', 'w1'))
        .set('d-grace', 'admin');
      const day3: FakeData = {
        ...day0,
        projectShares: [
          { projectId: 'wb', email: 'linus@acme.test', role: 'viewer' },
        ],
      };
      return { map, writer, run3: () => runWith(day3, [ada, grace, linus]) };
    };

    it("a day-3 grant is checked strictly; another member's later change is drift", async () => {
      const { map, run3 } = await setup();
      const report = await run3();
      expect(report.mismatches()).toEqual([]);
      expect(report.warningsOf('drift')).toEqual([
        expect.objectContaining({
          what: expect.stringContaining(
            'gives d-grace the role admin, not writer',
          ),
        }),
      ]);
      expect(await map.verified('grant', 'wb:linus@acme.test')).toBe(true);
    });

    it('the same run with the new grant given a wrong role fails', async () => {
      const { writer, run3 } = await setup();
      const grant = writer.grantSpaceRole.bind(writer);
      writer.grantSpaceRole = (spaceId, userId, _role, m) =>
        grant(spaceId, userId, 'writer', m);
      const report = await run3();
      expect(report.mismatches()).toEqual([
        expect.stringContaining('gives d-linus the role writer, not reader'),
      ]);
      expect(report.warningsOf('drift')).toEqual([
        expect.objectContaining({ what: expect.stringContaining('d-grace') }),
      ]);
    });

    it('a late comment is checked strictly; text deleted from the passed document is drift', async () => {
      const map = new MemoryImportMap();
      const writer = new RecordingWriter(map, WS);
      const d = data();
      const runWith = async (x: FakeData) => {
        const world = testContext(x, { users: [ada, grace], map, writer });
        for (const step of ALL_STEPS) await step.run(world.ctx);
        await verifyImport(world.ctx, ALL_STEPS);
        return world.ctx.report;
      };
      expect((await runWith(d)).mismatches()).toEqual([]);
      (writer.pages.get(targetId(WS, 'document', 'd2')) as any).content = {
        type: 'doc',
        content: [],
      };
      const later: FakeData = {
        ...d,
        comments: [...d.comments, msComment({ id: 'late', documentId: 'd2' })],
      };
      const report = await runWith(later);
      expect(report.mismatches()).toEqual([]);
      expect(report.warningsOf('drift')).toEqual([
        expect.objectContaining({
          what: expect.stringContaining('document-content-shorter'),
        }),
      ]);
      expect(await map.verified('comment', 'late')).toBe(true);
    });
  });
});
