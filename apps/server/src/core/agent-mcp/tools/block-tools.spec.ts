import * as Y from 'yjs';
import {
  applyOps,
  readElements,
  readFiles,
  sheet,
  SNAPSHOT_DISPLAY_CELLS,
} from '@docmost/live-blocks';
import { buildTools } from '../tool-registry';
import { handleRpc } from '../json-rpc';
import { McpToolError, NOT_FOUND } from '../tool.types';
import {
  ALICE,
  BOB,
  buildWorld,
  PAGES,
  SPACE_MINE,
} from '../testing/tool-fixtures';

// 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const rect = (id: string) => ({
  id,
  type: 'rectangle',
  x: 10,
  y: 20,
  width: 100,
  height: 50,
});
const image = (id: string, fileId: string) => ({
  id,
  type: 'image',
  x: 0,
  y: 0,
  width: 64,
  height: 64,
  fileId,
});

const SHEET_ON_OPEN = '0193c7a0-3333-7abc-8def-000000000001';
const WB_ON_OPEN = '0193c7a0-3333-7abc-8def-000000000002';
const SHEET_ON_RESTRICTED = '0193c7a0-3333-7abc-8def-000000000003';

let world: ReturnType<typeof buildWorld>;
let tools: Record<string, ReturnType<typeof buildTools>[number]>;

beforeEach(() => {
  world = buildWorld();
  tools = Object.fromEntries(buildTools(world.deps).map((t) => [t.name, t]));
});

const run = (
  name: string,
  args: any,
  user: any = ALICE,
  scope: 'read' | 'write' = 'write',
) =>
  tools[name].run(
    tools[name].input.parse(args),
    world.ctx(scope, user),
  ) as Promise<any>;

const pageOf = (id: string) => world.pages.find((p) => p.id === id)!;

// the elements of the page's open Yjs document, as the sync server holds it
function pageFragmentNodes(pageId: string) {
  const fragment = world.ydocFor(`page.${pageId}`).getXmlFragment('default');
  return fragment
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement)
    .map((n) => ({ type: n.nodeName, attrs: n.getAttributes() }));
}

function storedDoc(blockId: string) {
  const row = world.blocks.rows.get(blockId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.ydoc));
  return doc;
}

describe('create tools', () => {
  it('create_whiteboard with page_id appends the block to that page through the sync server', async () => {
    const out = await run('create_whiteboard', {
      page_id: PAGES.open,
      title: 'Plan',
      scene: { elements: [rect('r1')] },
    });

    expect(out).toEqual({
      page_id: PAGES.open,
      block_id: expect.any(String),
      url: 'http://docs.test/p/slug1',
      created_page: false,
      skipped_files: [],
    });
    // no new page
    expect(world.calls.created).toEqual([]);
    // the open document received the node, at the end
    const nodes = pageFragmentNodes(PAGES.open);
    expect(nodes[nodes.length - 1]).toEqual({
      type: 'whiteboard',
      attrs: expect.objectContaining({ blockId: out.block_id, title: 'Plan' }),
    });
    // the row is seeded with the scene, before the node appeared
    const row = world.blocks.rows.get(out.block_id);
    expect(row).toEqual(
      expect.objectContaining({ kind: 'whiteboard', pageId: PAGES.open }),
    );
    expect(readElements(storedDoc(out.block_id)).map((e) => e.id)).toEqual([
      'r1',
    ]);
    expect(row.snapshot.elements.map((e: any) => e.id)).toEqual(['r1']);
    // no audit entry: no page was created
    expect(world.calls.audit).toEqual([]);
  });

  it('create_whiteboard with an inline image on a new page leaves a files entry that points at a real attachment of that page', async () => {
    const out = await run('create_whiteboard', {
      space_id: SPACE_MINE,
      title: 'Logo board',
      scene: {
        elements: [image('i1', 'file-1')],
        files: {
          'file-1': {
            id: 'file-1',
            dataURL: `data:image/png;base64,${PNG_B64}`,
            mimeType: 'image/png',
            created: 1,
          },
        },
      },
    });

    expect(out.created_page).toBe(true);
    expect(out.skipped_files).toEqual([]);
    // the page was created empty; the node was appended afterwards
    expect(world.calls.created).toHaveLength(1);
    expect(world.calls.created[0]).toEqual(
      expect.objectContaining({
        spaceId: SPACE_MINE,
        title: 'Logo board',
        format: 'json',
        content: { type: 'doc', content: [] },
      }),
    );
    expect(pageOf(out.page_id).content.content).toEqual([
      {
        type: 'whiteboard',
        attrs: { blockId: out.block_id, title: 'Logo board' },
      },
    ]);
    expect(pageFragmentNodes(out.page_id).map((n) => n.attrs.blockId)).toEqual([
      out.block_id,
    ]);

    // one attachment, of the new page, holding the PNG
    expect(world.blocks.attachments).toHaveLength(1);
    const attachment = world.blocks.attachments[0];
    expect(attachment).toEqual(
      expect.objectContaining({
        pageId: out.page_id,
        spaceId: SPACE_MINE,
        workspaceId: 'ws-1',
        creatorId: ALICE.id,
        mimeType: 'image/png',
      }),
    );
    expect(
      world.blocks.uploads
        .get(attachment.filePath)
        ?.equals(Buffer.from(PNG_B64, 'base64')),
    ).toBe(true);

    // both the document and the snapshot point at it
    const ref = { attachmentId: attachment.id, mimeType: 'image/png' };
    expect(readFiles(storedDoc(out.block_id))).toEqual({ 'file-1': ref });
    expect(world.blocks.rows.get(out.block_id).snapshot.files).toEqual({
      'file-1': ref,
    });
    expect(world.calls.audit).toEqual([
      expect.objectContaining({
        event: 'page.created',
        resourceId: out.page_id,
        metadata: expect.objectContaining({ source: 'mcp' }),
      }),
    ]);
  });

  it('create_whiteboard reports a refused file and still creates the board', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const out = await run('create_whiteboard', {
      page_id: PAGES.open,
      title: 'Board',
      scene: {
        elements: [image('i1', 'svg-1')],
        files: {
          'svg-1': {
            dataURL: `data:image/png;base64,${svg.toString('base64')}`,
            mimeType: 'image/png',
          },
        },
      },
    });
    expect(out.skipped_files).toEqual([
      { fileId: 'svg-1', reason: expect.stringMatching(/not a PNG/) },
    ]);
    expect(world.blocks.attachments).toEqual([]);
    expect(world.blocks.rows.get(out.block_id).snapshot.files).toEqual({});
  });

  it('create_whiteboard stores at most 50 images per call and reports the rest', async () => {
    const files: Record<string, any> = {};
    for (let i = 0; i < 53; i++) {
      files[`f${String(i).padStart(2, '0')}`] = {
        dataURL: `data:image/png;base64,${PNG_B64}`,
      };
    }
    const out = await run('create_whiteboard', {
      page_id: PAGES.open,
      title: 'Many images',
      scene: { elements: [rect('r1')], files },
    });
    expect(world.blocks.attachments).toHaveLength(50);
    expect(out.skipped_files).toEqual(
      ['f50', 'f51', 'f52'].map((fileId) => ({
        fileId,
        reason: 'At most 50 images are stored per call',
      })),
    );
    expect(
      Object.keys(world.blocks.rows.get(out.block_id).snapshot.files),
    ).toHaveLength(50);
    expect(tools.create_whiteboard.description).toMatch(/at most 50 images/i);
  });

  it('create_whiteboard refuses a malformed scene before creating anything', async () => {
    const before = world.blocks.rows.size;
    for (const scene of [
      {
        elements: [
          { id: 'x', type: 'teapot', x: 0, y: 0, width: 1, height: 1 },
        ],
      },
      { elements: [{ type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }] },
      {
        elements: [
          { id: 'x', type: 'rectangle', x: 'left', y: 0, width: 1, height: 1 },
        ],
      },
    ]) {
      for (const target of [
        { space_id: SPACE_MINE },
        { page_id: PAGES.open },
      ]) {
        const err = await run('create_whiteboard', {
          ...target,
          title: 'Bad',
          scene: {
            ...scene,
            files: {
              f: { dataURL: `data:image/png;base64,${PNG_B64}` },
            },
          },
        }).catch((e) => e);
        expect(err).toBeInstanceOf(McpToolError);
        expect(err.message).toMatch(/^Element /);
      }
    }
    expect(world.calls.created).toEqual([]);
    expect(world.blocks.rows.size).toBe(before);
    expect(world.blocks.attachments).toEqual([]);
    expect(pageFragmentNodes(PAGES.open)).toEqual([]);
  });

  it('createOnPage seeds a row that a client created empty a moment earlier', async () => {
    // a client calls ensure for the id (it makes the empty row) just before
    // createOnPage inserts it
    world.blocks.hooks.beforeInsertBlock = (row) => {
      world.blocks.rows.set(row.id, {
        ...row,
        creatorId: BOB.id,
        ydoc: null,
        snapshot: null,
        deletedAt: null,
      });
    };
    const out = await run('create_whiteboard', {
      space_id: SPACE_MINE,
      title: 'Race',
      scene: { elements: [rect('r1'), rect('r2')] },
    });

    const row = world.blocks.rows.get(out.block_id);
    // the client's row was kept (its creator) and seeded with the scene
    expect(row.creatorId).toBe(BOB.id);
    expect(readElements(storedDoc(out.block_id)).map((e) => e.id)).toEqual([
      'r1',
      'r2',
    ]);
    expect(row.snapshot.elements).toHaveLength(2);
  });

  it.each([
    ['a new page', { space_id: SPACE_MINE }],
    ['an existing page', { page_id: PAGES.open }],
  ])(
    'on %s, no client can open the block before its seed is stored',
    async (_label, target) => {
      // A browser opens every block it finds in a page as soon as it sees it
      // (the bridge loads the stored document) and later stores what it holds.
      const openIn = (content: any) =>
        (content?.content ?? [])
          .filter((n: any) => n.attrs?.blockId)
          .forEach((n: any) => world.blocks.openDoc(n.attrs.blockId));
      const seenAtAppend: { seeded: boolean }[] = [];
      world.blocks.hooks.afterPageCreate = (page) => openIn(page.content);
      world.blocks.hooks.beforeAppend = (_pageId, content) => {
        for (const n of content.content) {
          seenAtAppend.push({
            seeded: !!world.blocks.rows.get(n.attrs.blockId)?.ydoc,
          });
        }
      };

      const out = await run('create_whiteboard', {
        ...target,
        title: 'Seeded',
        scene: {
          elements: [rect('r1'), image('i1', 'f1')],
          files: { f1: { dataURL: `data:image/png;base64,${PNG_B64}` } },
        },
      });

      // the browser now sees the node and opens the block, then stores it
      openIn(pageOf(out.page_id).content);
      await world.blocks.bridge.flush([out.block_id]);
      const stored = storedDoc(out.block_id);
      expect(readElements(stored).map((e) => e.id)).toEqual(['r1', 'i1']);
      expect(Object.keys(readFiles(stored))).toEqual(['f1']);

      // the node reached a page only once, after the seed was stored
      expect(seenAtAppend).toEqual([{ seeded: true }]);
      if (out.created_page) {
        expect(world.calls.created[0].content).toEqual({
          type: 'doc',
          content: [],
        });
      }
    },
  );

  it('a failed append leaves no block row behind', async () => {
    world.blocks.hooks.beforeAppend = () => {
      throw new Error('sync server down');
    };
    const before = new Set(world.blocks.rows.keys());
    await expect(
      run('create_whiteboard', {
        page_id: PAGES.open,
        title: 'Lost',
        scene: { elements: [rect('r1')] },
      }),
    ).rejects.toThrow('sync server down');
    const added = [...world.blocks.rows.values()].filter(
      (r) => !before.has(r.id),
    );
    expect(added).toHaveLength(1);
    expect(added[0].deletedAt).toBeInstanceOf(Date);
    expect(
      await world.deps.liveBlockRepo.findById(added[0].id),
    ).toBeUndefined();
    expect(pageFragmentNodes(PAGES.open)).toEqual([]);
  });

  it('a row of another kind under the new id is refused', async () => {
    world.blocks.hooks.beforeInsertBlock = (row) => {
      world.blocks.rows.set(row.id, {
        ...row,
        kind: 'todo',
        ydoc: null,
        snapshot: null,
        deletedAt: null,
      });
    };
    await expect(
      run('create_whiteboard', { page_id: PAGES.open, title: 'Clash' }),
    ).rejects.toThrow(/another kind/);
    expect(pageFragmentNodes(PAGES.open)).toEqual([]);
  });

  it('create_todo_board makes a board with one empty card', async () => {
    const out = await run('create_todo_board', {
      space_id: SPACE_MINE,
      title: 'Tasks',
    });
    const row = world.blocks.rows.get(out.block_id);
    expect(row.kind).toBe('todo');
    expect(row.snapshot.board.columns).toHaveLength(1);
    // the card's starter row is empty, as on a new board in the browser
    expect(row.snapshot.board.columns[0].nodes.map((n: any) => n.text)).toEqual(
      [''],
    );
    expect(pageOf(out.page_id).content.content).toEqual([
      { type: 'todoBoard', attrs: { blockId: out.block_id, title: 'Tasks' } },
    ]);

    const onPage = await run('create_todo_board', {
      page_id: PAGES.open,
      title: 'More',
    });
    expect(pageFragmentNodes(PAGES.open).map((n) => n.attrs.blockId)).toEqual([
      onPage.block_id,
    ]);
  });

  it('create_* is refused without edit access to the target', async () => {
    world.roles[`${ALICE.id}:${SPACE_MINE}`] = 'reader';
    for (const name of [
      'create_whiteboard',
      'create_todo_board',
      'create_sheet',
    ]) {
      for (const target of [
        { space_id: SPACE_MINE },
        { page_id: PAGES.open },
        { space_id: SPACE_MINE, parent_page_id: PAGES.open },
      ]) {
        await expect(run(name, { ...target, title: 'No' })).rejects.toThrow(
          NOT_FOUND,
        );
      }
    }
    // a writer cannot reach a page restricted away from them either
    delete world.roles[`${ALICE.id}:${SPACE_MINE}`];
    await expect(
      run('create_whiteboard', { page_id: PAGES.restricted, title: 'No' }),
    ).rejects.toThrow(NOT_FOUND);
    await expect(
      run('create_whiteboard', {
        space_id: SPACE_MINE,
        parent_page_id: PAGES.restricted,
        title: 'No',
      }),
    ).rejects.toThrow(NOT_FOUND);

    expect(world.calls.created).toEqual([]);
    expect(world.blocks.rows.size).toBe(2); // only the world's own rows
  });

  it('create_* takes exactly one of space_id and page_id', () => {
    const parse = (args: any) => tools.create_todo_board.input.parse(args);
    expect(() => parse({ title: 'T' })).toThrow(/exactly one/);
    expect(() =>
      parse({ title: 'T', space_id: SPACE_MINE, page_id: PAGES.open }),
    ).toThrow(/exactly one/);
    expect(() =>
      parse({ title: 'T', page_id: PAGES.open, parent_page_id: PAGES.child }),
    ).toThrow(/parent_page_id/);
    expect(() => parse({ title: 'T', page_id: PAGES.open })).not.toThrow();
  });

  it('create_whiteboard describes the request limit and the accepted image types', () => {
    const d = tools.create_whiteboard.description;
    expect(d).toContain('1 MiB');
    expect(d).toMatch(/PNG, JPEG, GIF and WebP/);
  });
});

describe('sheet tools: access', () => {
  it('get_sheet is refused without view access', async () => {
    world.blocks.add({
      id: SHEET_ON_RESTRICTED,
      kind: 'sheet',
      pageId: PAGES.restricted,
    });
    await expect(
      run('get_sheet', { block_id: SHEET_ON_RESTRICTED }, ALICE, 'read'),
    ).rejects.toThrow(NOT_FOUND);
    expect(world.blocks.bridge.flushed).toEqual([]);
  });

  it('set_sheet_cells is refused with a read token', async () => {
    world.blocks.add({ id: SHEET_ON_OPEN, kind: 'sheet', pageId: PAGES.open });
    const res: any = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'set_sheet_cells',
          arguments: {
            block_id: SHEET_ON_OPEN,
            cells: [{ a1: 'A1', value: '1' }],
          },
        },
      },
      Object.values(tools),
      world.ctx('read'),
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('This token is read-only');
    expect(world.blocks.bridge.applied).toEqual([]);
  });

  it('set_sheet_cells is refused for a write token whose user can only view the page', async () => {
    world.blocks.add({ id: SHEET_ON_OPEN, kind: 'sheet', pageId: PAGES.open });
    world.roles[`${ALICE.id}:${SPACE_MINE}`] = 'reader';
    await expect(
      run('set_sheet_cells', {
        block_id: SHEET_ON_OPEN,
        cells: [{ a1: 'A1', value: '1' }],
      }),
    ).rejects.toThrow(NOT_FOUND);
    expect(world.blocks.bridge.applied).toEqual([]);
  });

  it('set_sheet_cells on a whiteboard block id says NOT_FOUND', async () => {
    world.blocks.add({
      id: WB_ON_OPEN,
      kind: 'whiteboard',
      pageId: PAGES.open,
    });
    await expect(
      run('set_sheet_cells', {
        block_id: WB_ON_OPEN,
        cells: [{ a1: 'A1', value: '1' }],
      }),
    ).rejects.toThrow(NOT_FOUND);
    await expect(
      run('get_sheet', { block_id: WB_ON_OPEN }, ALICE, 'read'),
    ).rejects.toThrow(NOT_FOUND);
    expect(world.blocks.bridge.applied).toEqual([]);
  });

  it('a block that is no longer in its page content is NOT_FOUND', async () => {
    world.blocks.add({
      id: SHEET_ON_OPEN,
      kind: 'sheet',
      pageId: PAGES.open,
      inContent: false,
    });
    await expect(
      run('get_sheet', { block_id: SHEET_ON_OPEN }, ALICE, 'read'),
    ).rejects.toThrow(NOT_FOUND);
  });
});

describe('sheet tools: content', () => {
  it('create_sheet with space_id makes a page holding one sheet block', async () => {
    const out = await run('create_sheet', {
      space_id: SPACE_MINE,
      title: 'Budget',
    });
    expect(out.created_page).toBe(true);
    const content = pageOf(out.page_id).content;
    expect(content.content).toEqual([
      { type: 'sheet', attrs: { blockId: out.block_id, title: 'Budget' } },
    ]);
    const row = world.blocks.rows.get(out.block_id);
    expect(row.kind).toBe('sheet');
    expect(row.snapshot.book.sheets).toHaveLength(1);

    const read = await run(
      'get_sheet',
      { block_id: out.block_id },
      ALICE,
      'read',
    );
    expect(read.sheets).toHaveLength(1);
    expect(read.sheets[0].cells).toEqual([]);
  });

  it('get_sheet returns tab ids, raw input and display value by A1 address', async () => {
    const { block_id } = await run('create_sheet', {
      page_id: PAGES.open,
      title: 'Numbers',
    });
    await run('set_sheet_cells', {
      block_id,
      cells: [
        { a1: 'A1', value: '2' },
        { a1: 'B3', value: 'hello' },
        { a1: 'C1', value: '=A1*10' },
      ],
    });
    const out = await run('get_sheet', { block_id }, ALICE, 'read');
    const tab = out.sheets[0];
    expect(tab.sheet_id).toEqual(expect.any(String));
    expect(tab.name).toEqual(expect.any(String));
    expect(tab.rows).toBeGreaterThan(0);
    expect(tab.cols).toBeGreaterThan(0);
    expect(tab.cells).toEqual([
      { a1: 'A1', input: '2', display: '2' },
      { a1: 'C1', input: '=A1*10', display: '20' },
      { a1: 'B3', input: 'hello', display: 'hello' },
    ]);
    expect(out.truncated).toBe(false);
  });

  it('get_sheet flushes an open document before reading', async () => {
    const { block_id } = await run('create_sheet', {
      page_id: PAGES.open,
      title: 'Live',
    });
    // someone typed into the open sheet; the sync server has not stored it
    applyOps('sheet', world.blocks.openDoc(block_id), [
      { type: 'sheet.setCells', cells: [{ a1: 'A1', value: 'typed' }] } as any,
    ]);
    expect(
      JSON.stringify(world.blocks.rows.get(block_id).snapshot),
    ).not.toContain('typed');

    const out = await run('get_sheet', { block_id }, ALICE, 'read');
    expect(world.blocks.bridge.flushed).toContain(block_id);
    expect(out.sheets[0].cells).toEqual([
      { a1: 'A1', input: 'typed', display: 'typed' },
    ]);
  });

  it('set_sheet_cells writes a formula and returns its computed value', async () => {
    const { block_id } = await run('create_sheet', {
      page_id: PAGES.open,
      title: 'Sum',
    });
    const out = await run('set_sheet_cells', {
      block_id,
      cells: [
        { a1: 'A1', value: '1' },
        { a1: 'A2', value: '2' },
        { a1: 'A3', value: '3' },
        { a1: 'A4', value: '=SUM(A1:A3)' },
      ],
    });
    // through the sync server, so open sheets see it
    expect(world.blocks.bridge.applied).toEqual([
      expect.objectContaining({ blockId: block_id }),
    ]);
    expect(out.sheets[0].cells).toContainEqual({
      a1: 'A4',
      input: '=SUM(A1:A3)',
      display: '6',
    });

    const named = await run('set_sheet_cells', {
      block_id,
      sheet_name: 'Totals',
      create_sheet: true,
      cells: [{ a1: 'B2', value: '=Sheet1!A4*2' }],
    });
    const totals = named.sheets.find((s: any) => s.name === 'Totals');
    expect(totals.cells).toEqual([
      { a1: 'B2', input: expect.any(String), display: '12' },
    ]);

    await expect(
      run('set_sheet_cells', {
        block_id,
        sheet_name: 'Nope',
        cells: [{ a1: 'A1', value: 'x' }],
      }),
    ).rejects.toThrow(/No tab named Nope/);
  });

  // the stored snapshot the store path leaves when its build stops early
  function storeTruncated(blockId: string, book: any) {
    const doc = new Y.Doc();
    sheet.seedSheet(doc, book);
    const row = world.blocks.rows.get(blockId);
    row.ydoc = Buffer.from(Y.encodeStateAsUpdate(doc));
    row.snapshot = {
      kind: 'sheet',
      book,
      display: { [book.sheets[0].id]: { '0:0': '1' } },
      truncated: true,
    };
    row.updatedAt = new Date();
    world.blocks.open.delete(blockId);
    return row;
  }

  it('get_sheet rebuilds a cut-short snapshot and returns every value when the rebuild completes', async () => {
    const { block_id } = await run('create_sheet', {
      page_id: PAGES.open,
      title: 'Cut short',
    });
    const book = sheet.createEmptyBook();
    book.sheets[0].cells['0:0'] = { v: '1' };
    book.sheets[0].cells['1:0'] = { v: '=A1+1' };
    const row = storeTruncated(block_id, book);

    const out = await run('get_sheet', { block_id }, ALICE, 'read');
    expect(out.truncated).toBe(false);
    expect(out.note).toBeUndefined();
    expect(out.sheets[0].cells).toEqual([
      { a1: 'A1', input: '1', display: '1' },
      { a1: 'A2', input: '=A1+1', display: '2' },
    ]);
    // the rebuilt snapshot was saved over the cut-short one
    expect(row.snapshot.truncated).toBe(false);
  });

  it('get_sheet says so when even the rebuild stops at the display cap', async () => {
    const { block_id } = await run('create_sheet', {
      page_id: PAGES.open,
      title: 'Huge',
    });
    // more filled cells than SNAPSHOT_DISPLAY_CELLS
    const book = sheet.createEmptyBook();
    const tab = book.sheets[0];
    const rows = Math.ceil((SNAPSHOT_DISPLAY_CELLS + 1000) / 100);
    tab.rows = rows;
    tab.cols = 100;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 100; c++) tab.cells[`${r}:${c}`] = { v: '7' };
    }
    storeTruncated(block_id, book);

    const out = await run('get_sheet', { block_id }, ALICE, 'read');
    expect(out.truncated).toBe(true);
    expect(out.note).toMatch(/too large/);
    // the rebuilt snapshot stops at the cap too: the cells past it are not
    // listed, and the note tells the agent so
    const cells = out.sheets[0].cells;
    expect(cells.length).toBeLessThan(rows * 100);
    expect(cells.filter((c: any) => c.display !== null).length).toBe(
      SNAPSHOT_DISPLAY_CELLS,
    );
  }, 120_000);

  it('set_sheet_cells refuses a write outside the limits, with a count, and writes nothing', async () => {
    const { block_id } = await run('create_sheet', {
      page_id: PAGES.open,
      title: 'Limits',
    });
    await expect(
      run('set_sheet_cells', {
        block_id,
        cells: [
          { a1: 'A1', value: 'kept out' },
          { a1: 'A6000', value: 'x' },
          { a1: 'B7000', value: 'y' },
        ],
      }),
    ).rejects.toThrow(/^2 cells are outside 5000 rows and 702 columns$/);
    const out = await run('get_sheet', { block_id }, ALICE, 'read');
    expect(out.sheets[0].cells).toEqual([]);

    // more than one op may carry is refused by the schema, before anything is
    // sent to the sync server (the refused op above was sent, and refused there)
    const sent = world.blocks.bridge.applied.length;
    expect(() =>
      tools.set_sheet_cells.input.parse({
        block_id,
        cells: Array.from({ length: 5001 }, (_, i) => ({
          a1: `A${i + 1}`,
          value: '1',
        })),
      }),
    ).toThrow();
    expect(world.blocks.bridge.applied).toHaveLength(sent);
  });
});
