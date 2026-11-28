import { buildTools } from '../tool-registry';
import { McpToolError } from '../tool.types';
import {
  ALICE,
  BOB,
  buildWorld,
  COMMENTS,
  pageId,
  PAGES,
  SPACE_MINE,
  WS,
} from '../testing/tool-fixtures';
import {
  COMMENT_PAGES_PER_CALL,
  COMMENT_THREADS_PER_CALL,
} from './get-page-comments.tool';

let world: ReturnType<typeof buildWorld>;
let tools: Record<string, ReturnType<typeof buildTools>[number]>;

beforeEach(() => {
  world = buildWorld();
  tools = Object.fromEntries(buildTools(world.deps).map((t) => [t.name, t]));
});

const run = (args: any, user: any = ALICE) =>
  tools.get_page_comments.run(
    tools.get_page_comments.input.parse(args),
    world.ctx('read', user),
  ) as Promise<any>;

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function addThread(n: number, page: string, at: number) {
  world.comments.push({
    id: pageId(5000 + n),
    pageId: page,
    parentCommentId: null,
    selection: `quote ${n}`,
    content: doc(`thread ${n}`),
    creatorName: 'Bob',
    createdAt: new Date(2026, 1, 1, 0, 0, at),
    resolvedAt: null,
  });
}

function addChild(n: number, parent: string, allowed?: string[]) {
  world.pages.push({
    id: pageId(3000 + n),
    slugId: `slug${3000 + n}`,
    title: `Child ${n}`,
    spaceId: SPACE_MINE,
    workspaceId: WS,
    parentPageId: parent,
    deletedAt: null,
    content: doc(`child ${n}`),
    allowed,
  });
  return pageId(3000 + n);
}

// follows next_cursor to the end; returns every thread id, in order
async function readAll(args: any, user: any = ALICE) {
  const ids: string[] = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const out = await run({ ...args, cursor }, user);
    ids.push(...out.threads.map((t: any) => t.id));
    sizes.push(out.threads.length);
    if (!out.next_cursor) return { ids, sizes };
    cursor = out.next_cursor;
  }
  throw new Error('the cursor never ended');
}

describe('get_page_comments paging', () => {
  it('returns at most a fixed number of threads per call and a cursor for the rest', async () => {
    for (let i = 0; i < COMMENT_THREADS_PER_CALL + 20; i++) {
      addThread(i, PAGES.open, i + 10);
    }
    const first = await run({ page_id: PAGES.open });
    expect(first.threads).toHaveLength(COMMENT_THREADS_PER_CALL);
    expect(first.next_cursor).toEqual(expect.any(String));

    const { ids, sizes } = await readAll({ page_id: PAGES.open });
    // the two fixture threads plus the added ones, each exactly once
    expect(ids).toHaveLength(COMMENT_THREADS_PER_CALL + 22);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sizes).toEqual([COMMENT_THREADS_PER_CALL, 22]);
    // the filters still apply across calls
    const quoted = await readAll({ page_id: PAGES.open, quote: 'quote 11' });
    // "quote 11" and "quote 110" to "quote 119"
    expect(quoted.ids).toEqual(
      [11, ...Array.from({ length: 10 }, (_, i) => 110 + i)].map((n) =>
        pageId(5000 + n),
      ),
    );
  });

  it('reads a large tree a bounded number of pages per call, skipping pages the person cannot view', async () => {
    const total = COMMENT_PAGES_PER_CALL * 2 + 5;
    const hidden = new Set<number>([3, 70]);
    for (let i = 0; i < total; i++) {
      const id = addChild(i, PAGES.child, hidden.has(i) ? [BOB.id] : undefined);
      addThread(i, id, i);
    }
    const pagesRead: number[] = [];
    const listThreadRows = world.raw.queries.listThreadRows;
    world.raw.queries.listThreadRows = async (ids: string[]) => {
      pagesRead.push(ids.length);
      return listThreadRows(ids);
    };

    const { ids } = await readAll({
      page_id: PAGES.child,
      include_child_pages: true,
    });
    // the child page's own thread, then one per visible grandchild
    expect(ids[0]).toBe(COMMENTS.rootOnChild);
    const expected = [...Array(total).keys()]
      .filter((i) => !hidden.has(i))
      .map((i) => pageId(5000 + i));
    expect(ids.slice(1).sort()).toEqual(expected.sort());
    expect(new Set(ids).size).toBe(ids.length);
    // no call read more than the cap of pages
    expect(Math.max(...pagesRead)).toBeLessThanOrEqual(COMMENT_PAGES_PER_CALL);

    // Bob sees the restricted ones too
    const bob = await readAll(
      { page_id: PAGES.child, include_child_pages: true },
      BOB,
    );
    expect(bob.ids).toHaveLength(total + 1);
  });

  it('refuses a cursor it did not make', async () => {
    await expect(
      run({ page_id: PAGES.open, cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  it('a thread deleted between calls does not make the next call repeat threads', async () => {
    for (let i = 0; i < COMMENT_THREADS_PER_CALL + 20; i++) {
      addThread(i, PAGES.open, i + 10);
    }
    const first = await run({ page_id: PAGES.open });
    const lastId = first.threads[first.threads.length - 1].id;
    // the thread the cursor points at is deleted before the next call
    world.comments.splice(
      world.comments.findIndex((c) => c.id === lastId),
      1,
    );
    const second = await run({
      page_id: PAGES.open,
      cursor: first.next_cursor,
    });
    const seen = new Set(first.threads.map((t: any) => t.id));
    expect(second.threads.filter((t: any) => seen.has(t.id))).toEqual([]);
    expect(second.threads).toHaveLength(22);
  });

  it('refuses a cursor that names a thread without its time', async () => {
    const old = Buffer.from(
      JSON.stringify({ p: PAGES.open, t: COMMENTS.rootOpen }),
    ).toString('base64url');
    await expect(run({ page_id: PAGES.open, cursor: old })).rejects.toThrow(
      'That cursor is not one this tool returned',
    );
  });
});
