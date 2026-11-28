import { MemoryImportMap, targetId } from '../import-map';
import { RecordingWriter } from '../recording-writer';
import {
  msProject,
  msUser,
  msWorkspace,
  type FakeData,
} from '../testing/fake-source';
import {
  PNG_DATA_URL,
  tasksBoard,
  whiteboardScene,
  budgetBook,
} from '../testing/synthetic-mindspace';
import { WS, docmostUser, testContext } from '../testing/test-context';
import { sheet } from '@docmost/live-blocks';
import type {
  InlineFile,
  StoreResult,
  WhiteboardFileStore,
} from '../whiteboard-file-store';
import { peopleStep } from './people.step';
import { projectsStep } from './projects.step';
import { FailingWriter } from '../testing/failing-writer';
import { STORE_FAILED_REASON } from '../../core/live-block/whiteboard-files.service';

/** Stores each file as attachment attOf(fileId), except those named in `skip`. */
/** A stored attachment's id: a uuid, as validation requires. */
const attOf = (fileId: string) => targetId(WS, 'attachment', `test:${fileId}`);

class FakeFileStore implements WhiteboardFileStore {
  calls: {
    files: Record<string, InlineFile>;
    pageId: string;
    creatorId: string;
  }[] = [];
  /** The attachment id the step asked for, per call and file. */
  ids: Record<string, string>[] = [];
  constructor(private readonly skip: Record<string, string> = {}) {}
  async store(
    files: Record<string, InlineFile>,
    page: { id: string },
    creatorId: string,
    options?: { attachmentId?: (fileId: string) => string },
  ): Promise<StoreResult> {
    this.calls.push({ files, pageId: page.id, creatorId });
    this.ids.push(
      Object.fromEntries(
        Object.keys(files).map((f) => [f, options?.attachmentId?.(f)]),
      ),
    );
    const out: StoreResult = { refs: {}, skipped: [] };
    for (const fileId of Object.keys(files)) {
      if (this.skip[fileId])
        out.skipped.push({ fileId, reason: this.skip[fileId] });
      else
        out.refs[fileId] = {
          attachmentId: attOf(fileId),
          mimeType: 'image/png',
        };
    }
    return out;
  }
}

const ada = docmostUser('d-ada', 'ada@acme.test', { name: 'Ada' });
const base: FakeData = {
  users: [msUser('m-ada', 'ada@acme.test')],
  workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
};
const pageOf = (projectId: string) => targetId(WS, 'project', projectId);
const blockOf = (projectId: string) => targetId(WS, 'block', projectId);

async function run(data: FakeData, o: Parameters<typeof testContext>[1] = {}) {
  const world = testContext({ ...base, ...data }, { users: [ada], ...o });
  await peopleStep.run(world.ctx);
  await projectsStep.run(world.ctx);
  return world;
}

describe('projects step', () => {
  it('a whiteboard project becomes a page with one whiteboard block holding its elements', async () => {
    const { writer, ctx } = await run(
      {
        projects: [
          msProject({
            id: 'p1',
            workspaceId: 'w1',
            name: 'Roadmap',
            scene: whiteboardScene,
          }),
        ],
      },
      { files: new FakeFileStore() },
    );
    const page = writer.pages.get(pageOf('p1'));
    expect(page).toMatchObject({
      title: 'Roadmap',
      spaceId: targetId(WS, 'workspace', 'w1'),
      creatorId: 'd-ada',
    });
    expect(page.content).toEqual({
      type: 'doc',
      content: [
        {
          type: 'whiteboard',
          attrs: { blockId: blockOf('p1'), title: 'Roadmap' },
        },
      ],
    });
    const block = writer.blocks.get(blockOf('p1'));
    expect(block.pageId).toBe(page.id);
    expect((block.snapshot as any).elements.map((e: any) => e.id)).toEqual([
      'rect-1',
      'ellipse-1',
      'text-1',
      'image-1',
    ]);
    expect(await ctx.map.get('project', 'p1')).toBe(page.id);
    expect(ctx.report.get('project.imported')).toBe(1);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('whiteboard images become attachments and the block references them', async () => {
    const files = new FakeFileStore();
    const { writer } = await run(
      {
        projects: [
          msProject({ id: 'p1', workspaceId: 'w1', scene: whiteboardScene }),
        ],
      },
      { files },
    );
    // stored against the page, after the page exists, as its creator
    expect(files.calls).toEqual([
      {
        files: {
          'file-png-1': { dataURL: PNG_DATA_URL, mimeType: 'image/png' },
        },
        pageId: pageOf('p1'),
        creatorId: 'd-ada',
      },
    ]);
    expect((writer.blocks.get(blockOf('p1')).snapshot as any).files).toEqual({
      'file-png-1': {
        attachmentId: attOf('file-png-1'),
        mimeType: 'image/png',
      },
    });
    expect(writer.operations.indexOf(`page ${pageOf('p1')}`)).toBeLessThan(
      writer.operations.indexOf(`block ${blockOf('p1')}`),
    );
  });

  it('the page gains the block node only after the block row is seeded', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const pageAtSeed: unknown[] = [];
    const createLiveBlock = writer.createLiveBlock.bind(writer);
    jest.spyOn(writer, 'createLiveBlock').mockImplementation(async (input) => {
      pageAtSeed.push(structuredClone(writer.pages.get(input.page.id).content));
      return createLiveBlock(input);
    });
    const files = new FakeFileStore();
    await run(
      {
        projects: [
          msProject({ id: 'p1', workspaceId: 'w1', scene: whiteboardScene }),
        ],
      },
      { map, writer, files },
    );
    // when the block row (with its seed) is written, no node points at it yet
    expect(JSON.stringify(pageAtSeed[0])).not.toContain(blockOf('p1'));
    expect(
      writer.operations.filter(
        (o) => o.endsWith(pageOf('p1')) || o.endsWith(blockOf('p1')),
      ),
    ).toEqual([
      `page ${pageOf('p1')}`,
      `block ${blockOf('p1')}`,
      `content ${pageOf('p1')}`,
    ]);
    expect(JSON.stringify(writer.pages.get(pageOf('p1')).content)).toContain(
      blockOf('p1'),
    );
    // images were stored while the page had no block node
    expect(files.calls).toHaveLength(1);
  });

  it('an image storage could not take is not a loss: the project fails and a re-run stores it', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const data = {
      projects: [
        msProject({ id: 'p1', workspaceId: 'w1', scene: whiteboardScene }),
      ],
    };
    const first = await run(data, {
      map,
      writer,
      files: new FakeFileStore({ 'file-png-1': STORE_FAILED_REASON }),
    });
    expect(first.ctx.report.losses()).toEqual([]);
    expect(first.ctx.report.get('project.failed.error')).toBe(1);
    // not mapped, no block: nothing marks it complete
    expect(await map.get('project', 'p1')).toBeUndefined();
    expect(writer.blocks.has(blockOf('p1'))).toBe(false);

    const files = new FakeFileStore();
    const second = await run(data, { map, writer, files });
    expect(files.calls).toHaveLength(1);
    expect(second.ctx.report.get('project.imported')).toBe(1);
    expect(
      (writer.blocks.get(blockOf('p1')).snapshot as any).files['file-png-1'],
    ).toBeDefined();
    expect(second.ctx.report.mismatches()).toEqual([]);
  });

  it('a project whose block failed after its images were stored asks for the same image ids next time', async () => {
    const map = new MemoryImportMap();
    const inner = new RecordingWriter(map, WS);
    const files = new FakeFileStore();
    const data = {
      projects: [
        msProject({ id: 'p1', workspaceId: 'w1', scene: whiteboardScene }),
      ],
    };
    const broken = new FailingWriter(inner, (call) => call.op === 'block');
    const first = testContext(
      { ...base, ...data },
      { users: [ada], map, writer: inner, files },
    );
    first.ctx.writer = broken;
    await peopleStep.run(first.ctx);
    await projectsStep.run(first.ctx);
    expect(first.ctx.report.get('project.failed.error')).toBe(1);

    await run(data, { map, writer: inner, files });
    expect(files.ids).toEqual([
      { 'file-png-1': targetId(WS, 'attachment', 'p1:file-png-1') },
      { 'file-png-1': targetId(WS, 'attachment', 'p1:file-png-1') },
    ]);
    expect(inner.blocks.has(blockOf('p1'))).toBe(true);
  });

  it('a todo project keeps its cards, nesting, ratings and done state', async () => {
    const board = tasksBoard();
    const { writer } = await run({
      projects: [
        msProject({
          id: 't1',
          workspaceId: 'w1',
          kind: 'todo',
          name: 'Launch',
          scene: board,
        }),
      ],
    });
    const page = writer.pages.get(pageOf('t1'));
    expect((page.content as any).content[0]).toEqual({
      type: 'todoBoard',
      attrs: { blockId: blockOf('t1'), title: 'Launch' },
    });
    const stored = (writer.blocks.get(blockOf('t1')).snapshot as any).board;
    expect(stored.columns.map((c: any) => c.title)).toEqual([
      'Launch',
      'Later',
    ]);
    const [write, ship] = stored.columns[0].nodes;
    expect(write).toMatchObject({
      text: 'Write the announcement',
      effort: 1,
      done: false,
    });
    expect(write.children[0]).toMatchObject({
      text: 'Review the copy',
      done: true,
    });
    expect(ship).toMatchObject({ text: 'Ship it', priority: 2 });
    expect(stored.columns[1].nodes[0]).toMatchObject({
      kind: 'section',
      text: 'Ideas',
    });
  });

  it('a board with an iframe and an image: the iframe is removed and reported, the image is stored', async () => {
    const scene = {
      ...whiteboardScene,
      elements: [
        ...whiteboardScene.elements,
        { id: 'bad', type: 'iframe', x: 0, y: 0, width: 1, height: 1 },
      ],
    };
    const files = new FakeFileStore();
    const { writer, ctx } = await run(
      { projects: [msProject({ id: 'p1', workspaceId: 'w1', scene })] },
      { files },
    );
    const board = writer.blocks.get(blockOf('p1')).snapshot as any;
    expect(board.elements.map((e: any) => e.id)).not.toContain('bad');
    expect(board.files['file-png-1']).toEqual({
      attachmentId: attOf('file-png-1'),
      mimeType: 'image/png',
    });
    expect(ctx.report.warningsOf('whiteboard-element-removed')).toEqual([
      {
        projectId: 'p1',
        name: 'Project p1',
        removed: { iframe: 1 },
        altered: {},
        summary: '1 iframe',
      },
    ]);
    expect(ctx.report.losses()).toEqual([]);
  });

  it('a board page deleted in docmost is warned about and gets no redirect', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const data = { projects: [msProject({ id: 'p1', workspaceId: 'w1' })] };
    await run(data, { map, writer });
    writer.pages.delete(pageOf('p1'));
    const { ctx } = await run(data, { map, writer });
    expect(ctx.report.warningsOf('target-page-missing')).toEqual([
      expect.objectContaining({ kind: 'project', projectId: 'p1' }),
    ]);
    expect(ctx.report.links()).toEqual([]);
  });

  it('a board with more images than a board holds keeps the first 2,000; the rest are losses --accept-loss covers', async () => {
    const many: Record<string, InlineFile> = {};
    const elements = [];
    for (let i = 0; i < 2002; i++) {
      many[`f${i}`] = {
        id: `f${i}`,
        dataURL: PNG_DATA_URL,
        mimeType: 'image/png',
      } as any;
      elements.push({
        id: `i${i}`,
        type: 'image',
        fileId: `f${i}`,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      });
    }
    const files = new FakeFileStore();
    const { ctx, writer } = await run(
      {
        projects: [
          msProject({
            id: 'p1',
            workspaceId: 'w1',
            scene: { elements, files: many },
          }),
        ],
      },
      { files, options: { acceptLoss: ['p1'] } },
    );
    expect(ctx.report.get('project.imported')).toBe(1);
    expect(Object.keys(files.calls[0].files)).toHaveLength(2000);
    expect(
      Object.keys((writer.blocks.get(blockOf('p1')).snapshot as any).files),
    ).toHaveLength(2000);
    expect(
      ctx.report.losses().map((l) => [l.code, (l.detail as any).fileId]),
    ).toEqual([
      ['whiteboard-file-skipped', 'f2000'],
      ['whiteboard-file-skipped', 'f2001'],
    ]);
  });

  describe('sheet projects', () => {
    const budget = () =>
      msProject({
        id: 's1',
        workspaceId: 'w1',
        kind: 'sheet',
        name: 'Budget 2026',
        scene: JSON.stringify(budgetBook()),
      });

    it('a sheet project becomes a page with one sheet block seeded from the full book', async () => {
      const { writer, ctx } = await run({ projects: [budget()] });
      const page = writer.pages.get(pageOf('s1'));
      expect((page.content as any).content).toEqual([
        {
          type: 'sheet',
          attrs: { blockId: blockOf('s1'), title: 'Budget 2026' },
        },
      ]);
      const doc = writer.blockDocs.get(blockOf('s1'));
      const book = sheet.readBook(doc);
      expect(book.sheets.map((t) => t.name)).toEqual(['Budget', 'Rates']);
      const [tab, rates] = book.sheets;
      // inputs as typed, formulas included, across tabs
      expect(tab.cells['1:3'].v).toBe('=SUM(B2:C2)');
      expect(tab.cells['5:3'].v).toBe('=D5*Rates!B1');
      expect(rates.cells['0:1'].v).toBe('0.2');
      // formats, sizes, merges, frozen panes
      expect(tab.cells['0:0'].f).toMatchObject({ bold: true, bg: '#e7f5ff' });
      expect(tab.colWidths).toEqual({ '0': 160 });
      expect(tab.rowHeights).toEqual({ '0': 32 });
      expect(tab.merges).toEqual([{ r1: 6, c1: 0, r2: 6, c2: 2 }]);
      expect([
        tab.frozenRows,
        tab.frozenCols,
        rates.frozenRows,
        rates.frozenCols,
      ]).toEqual([1, 1, 0, 0]);
      // and the formulas compute
      const snapshot = writer.blocks.get(blockOf('s1')).snapshot as any;
      expect(snapshot.display[tab.id]['4:3']).toBe('3920');
      expect(snapshot.display[tab.id]['5:3']).toBe('784');
      expect(ctx.report.get('project.kind.sheet')).toBe(1);
      expect(ctx.report.mismatches()).toEqual([]);
    });

    it('frozen panes are stored as the ids of the last frozen row and column, not as counts', async () => {
      const { writer } = await run({ projects: [budget()] });
      const doc = writer.blockDocs.get(blockOf('s1'));
      const book = sheet.readBook(doc);
      const tab = sheet.sheetTabs(doc).get(book.sheets[0].id) as any;
      const layout = sheet.readLayout(doc, book.sheets[0].id);
      expect(tab.get('frozenRows')).toBe(layout.rows.ids[0]);
      expect(tab.get('frozenCols')).toBe(layout.cols.ids[0]);
      expect(typeof tab.get('frozenRows')).toBe('string');
      const rates = sheet.sheetTabs(doc).get(book.sheets[1].id) as any;
      expect(rates.get('frozenRows')).toBe(0);
    });

    it('a book too big for a full snapshot is still seeded whole: the truncated snapshot is never used to seed', async () => {
      const big = budgetBook();
      // more filled cells than a snapshot keeps
      for (let r = 10; r < 10 + 1100; r++)
        for (let c = 0; c < 50; c++)
          big.sheets[1].cells[`${r}:${c}`] = { v: String(r * c) };
      big.sheets[1].rows = 1200;
      big.sheets[1].cols = 60;
      const { writer, ctx } = await run({
        projects: [
          msProject({ id: 's1', workspaceId: 'w1', kind: 'sheet', scene: big }),
        ],
      });
      const stored = writer.blocks.get(blockOf('s1')).snapshot as any;
      expect(stored.truncated).toBe(true);
      const book = sheet.readBook(writer.blockDocs.get(blockOf('s1')));
      expect(Object.keys(book.sheets[1].cells)).toHaveLength(2 + 1100 * 50);
      expect(ctx.report.losses()).toEqual([]);
      expect(ctx.report.mismatches()).toEqual([]);
    });

    it("a sheet's source fingerprint counts its tabs and filled cells", async () => {
      const { ctx } = await run({ projects: [budget()] });
      expect(ctx.state.fingerprints.get('s1')).toEqual({
        kind: 'sheet',
        tabs: 2,
        cells: 25,
      });
    });

    it('a sheet that fails validation is a loss with an empty sheet block', async () => {
      const { writer, ctx } = await run({
        projects: [
          msProject({
            id: 's1',
            workspaceId: 'w1',
            kind: 'sheet',
            scene: { sheets: [] },
          }),
        ],
      });
      expect(writer.blocks.get(blockOf('s1')).snapshot.kind).toBe('sheet');
      expect(ctx.report.losses()).toEqual([
        {
          code: 'scene-invalid',
          projectId: 's1',
          detail: {
            name: 'Project s1',
            kind: 'sheet',
            reason: 'Not a valid spreadsheet: it has no sheets',
          },
        },
      ]);
    });
  });

  it('projects keep their sidebar order', async () => {
    const { writer } = await run({
      projects: [
        msProject({
          id: 'c',
          workspaceId: 'w1',
          position: null,
          createdAt: new Date('2025-01-01'),
        }),
        msProject({ id: 'b', workspaceId: 'w1', position: 2048 }),
        msProject({
          id: 'a2',
          workspaceId: 'w1',
          position: 1024,
          createdAt: new Date('2025-02-01'),
        }),
        msProject({
          id: 'a1',
          workspaceId: 'w1',
          position: 1024,
          createdAt: new Date('2025-01-01'),
        }),
      ],
    });
    const created = writer.operations
      .filter((o) => o.startsWith('page '))
      .map((o) => o.slice(5));
    expect(created).toEqual(['a1', 'a2', 'b', 'c'].map(pageOf));
  });

  it("a project page keeps mindspace's created and updated dates", async () => {
    const createdAt = new Date('2025-01-02T03:04:05Z');
    const updatedAt = new Date('2025-11-12T13:14:15Z');
    const { writer } = await run({
      projects: [
        msProject({ id: 'p1', workspaceId: 'w1', createdAt, updatedAt }),
      ],
    });
    expect(writer.pages.get(pageOf('p1'))).toMatchObject({
      createdAt,
      updatedAt,
    });
  });

  it('a null scene creates an empty block with no warning', async () => {
    const { writer, ctx } = await run({
      projects: [msProject({ id: 'e', workspaceId: 'w1', scene: null })],
    });
    expect(writer.blocks.get(blockOf('e')).snapshot).toEqual({
      kind: 'whiteboard',
      elements: [],
      files: {},
    });
    expect(ctx.report.losses()).toEqual([]);
    expect(ctx.report.toJSON()).toMatchObject({ warnings: {} });
  });

  it('a corrupt scene still creates the page and is recorded as a loss', async () => {
    const { writer, ctx } = await run({
      projects: [
        msProject({
          id: 'bad',
          workspaceId: 'w1',
          scene: '{"elements":[{"id":"a"',
        }),
      ],
    });
    expect(writer.pages.has(pageOf('bad'))).toBe(true);
    expect(writer.blocks.get(blockOf('bad')).snapshot).toEqual({
      kind: 'whiteboard',
      elements: [],
      files: {},
    });
    expect(ctx.report.losses()).toEqual([
      {
        code: 'scene-invalid',
        projectId: 'bad',
        detail: {
          name: 'Project bad',
          kind: 'whiteboard',
          reason: expect.stringContaining('not valid JSON'),
        },
      },
    ]);
  });

  it('a skipped image is recorded as a loss', async () => {
    const { ctx, writer } = await run(
      {
        projects: [
          msProject({ id: 'p1', workspaceId: 'w1', scene: whiteboardScene }),
        ],
      },
      {
        files: new FakeFileStore({
          'file-png-1': 'not a PNG, JPEG, GIF or WebP image',
        }),
      },
    );
    expect((writer.blocks.get(blockOf('p1')).snapshot as any).files).toEqual(
      {},
    );
    expect(ctx.report.losses()).toEqual([
      {
        code: 'whiteboard-file-skipped',
        projectId: 'p1',
        detail: {
          fileId: 'file-png-1',
          reason: 'not a PNG, JPEG, GIF or WebP image',
        },
      },
    ]);
  });

  it('a later run reports the same losses again: a skipped image and a scene that fails validation', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const data = {
      projects: [
        msProject({ id: 'p1', workspaceId: 'w1', scene: whiteboardScene }),
        msProject({
          id: 'bad',
          workspaceId: 'w1',
          position: 2048,
          scene: {
            elements: [
              {
                id: 'x',
                type: 'rectangle',
                x: 'left',
                y: 0,
                width: 1,
                height: 1,
              },
            ],
          },
        }),
      ],
    };
    const files = new FakeFileStore({
      'file-png-1': 'The file is not a PNG, JPEG, GIF or WebP image',
    });
    await run(data, { map, writer, files });
    const { ctx } = await run(data, { map, writer, files });
    expect(ctx.report.get('project.already-imported')).toBe(2);
    expect(ctx.report.losses()).toEqual([
      {
        code: 'whiteboard-file-skipped',
        projectId: 'p1',
        detail: {
          fileId: 'file-png-1',
          reason: 'not stored by an earlier run',
        },
      },
      {
        code: 'scene-invalid',
        projectId: 'bad',
        detail: {
          name: 'Project bad',
          kind: 'whiteboard',
          reason: 'Element x has a non-finite x',
        },
      },
    ]);
  });

  it("each project's source fingerprint is recorded", async () => {
    const { ctx } = await run({
      projects: [
        msProject({ id: 'w', workspaceId: 'w1', scene: whiteboardScene }),
        msProject({
          id: 't',
          workspaceId: 'w1',
          kind: 'todo',
          scene: tasksBoard(),
        }),
      ],
    });
    expect(ctx.state.fingerprints.get('w')).toEqual({
      kind: 'whiteboard',
      elements: 4,
      images: 1,
    });
    expect(ctx.state.fingerprints.get('t')).toEqual({
      kind: 'todo',
      cards: 2,
      items: 5,
    });
    expect((ctx.report.toJSON() as any).fingerprints).toEqual({
      w: { kind: 'whiteboard', elements: 4, images: 1 },
      t: { kind: 'todo', cards: 2, items: 5 },
    });
  });

  it('a doc project is left for the docs step', async () => {
    const { writer, ctx } = await run({
      projects: [
        msProject({ id: 'd', workspaceId: 'w1', kind: 'doc' }),
        msProject({ id: 'w', workspaceId: 'w1' }),
      ],
    });
    expect(writer.pages.has(pageOf('d'))).toBe(false);
    expect(ctx.report.get('project.source')).toBe(1);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('a second run creates no second page', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const data = {
      projects: [
        msProject({ id: 'p1', workspaceId: 'w1', scene: whiteboardScene }),
      ],
    };
    const files = new FakeFileStore();
    await run(data, { map, writer, files });
    const before = writer.operations.length;
    const { ctx } = await run(data, { map, writer, files });
    expect(writer.operations.length).toBe(before);
    expect(files.calls).toHaveLength(1);
    expect(ctx.report.get('project.already-imported')).toBe(1);
    expect(ctx.report.links()).toHaveLength(1);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('each project yields an old-link to new-link pair', async () => {
    const { ctx, writer } = await run({
      projects: [
        msProject({ id: 'p1', workspaceId: 'w1' }),
        msProject({
          id: 'p2',
          workspaceId: 'w1',
          kind: 'todo',
          position: 2048,
        }),
      ],
    });
    const slug = (id: string) => writer.pages.get(pageOf(id)).slugId;
    expect(ctx.report.links()).toEqual([
      {
        oldUrl: 'https://mind.example.com/p/p1',
        newUrl: `https://docs.example.com/s/${writer.spaces.get(targetId(WS, 'workspace', 'w1')).slug}/p/${slug('p1')}?block=${blockOf('p1')}`,
      },
      {
        oldUrl: 'https://mind.example.com/p/p2',
        newUrl: `https://docs.example.com/s/${writer.spaces.get(targetId(WS, 'workspace', 'w1')).slug}/p/${slug('p2')}?block=${blockOf('p2')}`,
      },
    ]);
  });

  it('a project of a workspace that was not migrated is counted as skipped', async () => {
    const { ctx, writer } = await run({
      users: [
        msUser('m-ada', 'ada@acme.test'),
        msUser('m-olga', 'olga@acme.test'),
      ],
      workspaces: [
        msWorkspace('w1', 'Team', 'm-ada'),
        msWorkspace('w2', 'Olga', 'm-olga'),
      ],
      projects: [msProject({ id: 'o1', workspaceId: 'w2' })],
    });
    expect(writer.pages.size).toBe(0);
    expect(ctx.report.get('project.skipped.owner-unmatched')).toBe(1);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('stops and names the people step when a workspace has no space yet', async () => {
    const { ctx } = testContext(
      { ...base, projects: [msProject({ id: 'p1', workspaceId: 'w1' })] },
      { users: [ada] },
    );
    await expect(projectsStep.run(ctx)).rejects.toThrow(
      'run the "people" step first',
    );
  });
});
