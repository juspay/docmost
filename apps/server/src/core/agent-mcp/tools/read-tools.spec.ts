// the real export path imports an ESM-only package
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

import { buildTools } from '../tool-registry';
import { McpToolError, NOT_FOUND } from '../tool.types';
import {
  ALICE,
  BOB,
  buildWorld,
  COMMENTS,
  PAGES,
  SPACE_MINE,
  SPACE_OTHER,
} from '../testing/tool-fixtures';

const world = buildWorld();
const tools = Object.fromEntries(
  buildTools(world.deps).map((t) => [t.name, t]),
);
const run = (name: string, args: any, user: any = ALICE) =>
  tools[name].run(
    tools[name].input.parse(args),
    world.ctx('read', user),
  ) as Promise<any>;

describe('read tools', () => {
  it("list_spaces returns only the person's spaces", async () => {
    const out = await run('list_spaces', {});
    expect(out.spaces.map((s: any) => s.id)).toEqual([SPACE_MINE]);
    expect(out.spaces[0]).toEqual(
      expect.objectContaining({ name: 'Mine', slug: 'mine', role: 'writer' }),
    );
  });

  it('list_pages returns only pages the person can view', async () => {
    const out = await run('list_pages', { space_id: SPACE_MINE });
    const ids = out.pages.map((p: any) => p.id);
    expect(ids).toEqual([PAGES.open, PAGES.child]);
    expect(ids).not.toContain(PAGES.restricted);
    expect(ids).not.toContain(PAGES.restrictedChild);
    expect(out.pages[0]).toEqual({
      id: PAGES.open,
      slug_id: 'slug1',
      title: 'Open page',
      parent_page_id: null,
      url: 'http://docs.test/p/slug1',
      blocks: [],
    });
    expect(out.next_cursor).toBeNull();
    const bob = await run('list_pages', { space_id: SPACE_MINE }, BOB);
    expect(bob.pages.map((p: any) => p.id)).toContain(PAGES.restricted);
  });

  it('list_pages with parent_page_id lists direct children only', async () => {
    const out = await run('list_pages', {
      space_id: SPACE_MINE,
      parent_page_id: PAGES.open,
    });
    expect(out.pages.map((p: any) => p.id)).toEqual([PAGES.child]);
    await expect(
      run('list_pages', { space_id: SPACE_OTHER, parent_page_id: PAGES.open }),
    ).rejects.toThrow(NOT_FOUND);
  });

  it('get_page_markdown returns markdown, title, url and a lossy_node_types list', async () => {
    const out = await run('get_page_markdown', { page_id: PAGES.open });
    // the title is returned separately, not as a heading in the body
    expect(out.markdown).toBe('body of Open page');
    expect(out.title).toBe('Open page');
    expect(out.url).toBe('http://docs.test/p/slug1');
    expect(Array.isArray(out.lossy_node_types)).toBe(true);
    await expect(
      run('get_page_markdown', { page_id: PAGES.restricted }),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  it('get_page_markdown says so when export is disabled, instead of pretending the page is missing', async () => {
    world.flags.exportDisabled = true;
    try {
      await expect(
        run('get_page_markdown', { page_id: PAGES.open }),
      ).rejects.toThrow(/Export is disabled/);
      await expect(
        run('get_page_markdown', { page_id: PAGES.restricted }),
      ).rejects.toThrow(NOT_FOUND);
    } finally {
      world.flags.exportDisabled = false;
    }
  });

  describe('list_pages and live blocks', () => {
    const BOARD = '0193c7a0-1111-7abc-8def-0000000000b1';
    const SHEET = '0193c7a0-1111-7abc-8def-0000000000b2';
    const WB = '0193c7a0-1111-7abc-8def-0000000000b3';
    let saved: Map<string, unknown>;

    beforeEach(() => {
      saved = new Map(world.pages.map((p) => [p.id, p.content]));
      const page = (id: string) => world.pages.find((p) => p.id === id)!;
      page(PAGES.open).content = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
          { type: 'todoBoard', attrs: { blockId: BOARD, title: 'Tasks' } },
          {
            type: 'columns',
            content: [
              {
                type: 'column',
                content: [
                  { type: 'sheet', attrs: { blockId: SHEET, title: null } },
                ],
              },
            ],
          },
        ],
      };
      page(PAGES.child).content = {
        type: 'doc',
        content: [{ type: 'whiteboard', attrs: { blockId: WB, title: 'Map' } }],
      };
    });

    afterEach(() => {
      for (const p of world.pages) p.content = saved.get(p.id);
    });

    it('list_pages lists the blocks on each page, nested ones included', async () => {
      const out = await run('list_pages', { space_id: SPACE_MINE });
      const blocks = Object.fromEntries(
        out.pages.map((p: any) => [p.id, p.blocks]),
      );
      expect(blocks[PAGES.open]).toEqual([
        { block_id: BOARD, kind: 'todo', title: 'Tasks' },
        { block_id: SHEET, kind: 'sheet', title: null },
      ]);
      expect(blocks[PAGES.child]).toEqual([
        { block_id: WB, kind: 'whiteboard', title: 'Map' },
      ]);
    });

    it('list_pages with block_kind lists only the pages holding a block of that kind', async () => {
      const wb = await run('list_pages', {
        space_id: SPACE_MINE,
        block_kind: 'whiteboard',
      });
      expect(wb.pages.map((p: any) => p.id)).toEqual([PAGES.child]);
      const todo = await run('list_pages', {
        space_id: SPACE_MINE,
        block_kind: 'todo',
      });
      expect(todo.pages.map((p: any) => p.id)).toEqual([PAGES.open]);
      // the other blocks of a matching page are still listed
      expect(todo.pages[0].blocks.map((b: any) => b.kind)).toEqual([
        'todo',
        'sheet',
      ]);
      // the restricted page holds a sheet too (see BLOCKS): Bob sees it,
      // Alice does not
      const alice = await run('list_pages', {
        space_id: SPACE_MINE,
        block_kind: 'sheet',
      });
      expect(alice.pages.map((p: any) => p.id)).toEqual([PAGES.open]);
      const bob = await run(
        'list_pages',
        { space_id: SPACE_MINE, block_kind: 'sheet' },
        BOB,
      );
      expect(bob.pages.map((p: any) => p.id)).toEqual([
        PAGES.open,
        PAGES.restricted,
      ]);
    });

    it('list_pages refuses an unknown block_kind', () => {
      expect(() =>
        tools.list_pages.input.parse({
          space_id: SPACE_MINE,
          block_kind: 'kanban',
        }),
      ).toThrow();
    });
  });

  it('list_pages refuses a cursor that is not an id', () => {
    expect(() =>
      tools.list_pages.input.parse({
        space_id: SPACE_MINE,
        cursor: 'not-a-uuid',
      }),
    ).toThrow();
    expect(() =>
      tools.list_pages.input.parse({
        space_id: SPACE_MINE,
        cursor: PAGES.open,
      }),
    ).not.toThrow();
  });

  it('get_page_comments returns threads with replies and honours state and quote', async () => {
    const all = await run('get_page_comments', { page_id: PAGES.open });
    expect(all.threads.map((t: any) => t.id)).toEqual([
      COMMENTS.rootOpen,
      COMMENTS.rootResolved,
    ]);
    expect(all.threads[0]).toEqual(
      expect.objectContaining({
        selection: 'hello world',
        body: 'Please check',
        author: 'Bob',
        resolved: false,
      }),
    );
    expect(all.threads[0].replies.map((r: any) => r.body)).toEqual(['Done']);
    const open = await run('get_page_comments', {
      page_id: PAGES.open,
      state: 'open',
    });
    expect(open.threads.map((t: any) => t.id)).toEqual([COMMENTS.rootOpen]);
    const resolved = await run('get_page_comments', {
      page_id: PAGES.open,
      state: 'resolved',
    });
    expect(resolved.threads.map((t: any) => t.id)).toEqual([
      COMMENTS.rootResolved,
    ]);
    const quoted = await run('get_page_comments', {
      page_id: PAGES.open,
      quote: 'SECOND',
    });
    expect(quoted.threads.map((t: any) => t.id)).toEqual([
      COMMENTS.rootResolved,
    ]);
  });

  it('get_page_comments on a page the person cannot view says NOT_FOUND', async () => {
    await expect(
      run('get_page_comments', { page_id: PAGES.restricted }),
    ).rejects.toThrow(NOT_FOUND);
    await expect(
      run('get_page_comments', { page_id: PAGES.foreign }),
    ).rejects.toThrow(NOT_FOUND);
  });

  it('get_page_comments with include_child_pages leaves out a restricted child', async () => {
    const without = await run('get_page_comments', { page_id: PAGES.open });
    expect(without.threads.map((t: any) => t.id)).not.toContain(
      COMMENTS.rootOnChild,
    );
    const out = await run('get_page_comments', {
      page_id: PAGES.open,
      include_child_pages: true,
    });
    const ids = out.threads.map((t: any) => t.id);
    expect(ids).toContain(COMMENTS.rootOnChild);
    expect(ids).not.toContain(COMMENTS.rootOnRestrictedChild);
    const bob = await run(
      'get_page_comments',
      { page_id: PAGES.open, include_child_pages: true },
      BOB,
    );
    expect(bob.threads.map((t: any) => t.id)).toContain(
      COMMENTS.rootOnRestrictedChild,
    );
  });
});
