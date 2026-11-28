import { z } from 'zod';
import { McpTool, McpToolError } from '../tool.types';
import { loadViewablePage, McpDeps } from '../mcp-deps';
import { ThreadRow } from '../mcp-queries';
import { jsonToText } from 'src/collaboration/collaboration.util';

export const COMMENT_PAGES_PER_CALL = 50;
export const COMMENT_THREADS_PER_CALL = 100;

const input = z.object({
  page_id: z.string().min(1),
  state: z.enum(['open', 'resolved', 'all']).default('all'),
  quote: z.string().min(1).optional(),
  include_child_pages: z.boolean().default(false),
  cursor: z.string().max(200).optional(),
});

// Where the next call starts: page `p` (the page itself, or one below it),
// after the root thread with creation time `c` and id `t` on that page. The
// time is in the cursor so a thread deleted meanwhile still marks the spot.
type Cursor = { p: string; t?: string; c?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(text: string | undefined): Cursor | undefined {
  if (text === undefined) return undefined;
  try {
    const c = JSON.parse(Buffer.from(text, 'base64url').toString());
    const time = c?.c === undefined ? undefined : Date.parse(c.c);
    if (
      UUID.test(c?.p) &&
      (c.t === undefined || UUID.test(c.t)) &&
      // a thread id always comes with its time
      (c.t === undefined) === (time === undefined) &&
      (time === undefined || Number.isFinite(time))
    ) {
      return { p: c.p, t: c.t, c: c.c };
    }
  } catch {
    // fall through
  }
  throw new McpToolError('That cursor is not one this tool returned');
}

const byTime = (a: ThreadRow, b: ThreadRow) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const plain = (content: unknown): string => {
  if (!content) return '';
  try {
    const json = typeof content === 'string' ? JSON.parse(content) : content;
    return jsonToText(json as any).trim();
  } catch {
    return '';
  }
};

export function getPageCommentsTool(
  deps: McpDeps,
): McpTool<z.infer<typeof input>> {
  return {
    name: 'get_page_comments',
    description: `Read comment threads on a page: root id, selection (the highlighted text), body, author, resolved and replies. state is open, resolved or all. quote keeps threads whose selection contains that text. include_child_pages also reads the pages below it that you can view. One call returns at most ${COMMENT_THREADS_PER_CALL} threads from at most ${COMMENT_PAGES_PER_CALL} pages; pass the returned next_cursor as cursor (with the same other arguments) for more.`,
    scope: 'read',
    input,
    async run(args, ctx) {
      const page = await loadViewablePage(deps, ctx, args.page_id);
      const cursor = decodeCursor(args.cursor);

      // The pages this call reads, in order: the page itself, then the pages
      // below it by id. One more id than the cap tells whether more remain.
      const order: string[] = [];
      if (!cursor || cursor.p === page.id) order.push(page.id);
      if (args.include_child_pages) {
        order.push(
          ...(await deps.queries.listDescendantIds(page.id, {
            fromId: cursor && cursor.p !== page.id ? cursor.p : undefined,
            limit: COMMENT_PAGES_PER_CALL + 1 - order.length,
          })),
        );
      }
      const batch = order.slice(0, COMMENT_PAGES_PER_CALL);
      const nextPage = order[COMMENT_PAGES_PER_CALL];

      let pageIds = batch;
      if (args.include_child_pages && batch.length > 0) {
        const allowed = await deps.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: batch,
          userId: ctx.user.id,
          spaceId: page.spaceId,
        });
        pageIds = batch.filter((id) => id === page.id || allowed.includes(id));
      }

      const rows = await deps.queries.listThreadRows(pageIds);
      const replies = new Map<string, ThreadRow[]>();
      for (const r of rows) {
        if (r.parentCommentId) {
          const list = replies.get(r.parentCommentId) ?? [];
          list.push(r);
          replies.set(r.parentCommentId, list);
        }
      }
      const needle = args.quote?.toLowerCase();
      const matches = (r: ThreadRow) =>
        (args.state === 'all'
          ? true
          : args.state === 'resolved'
            ? !!r.resolvedAt
            : !r.resolvedAt) &&
        (!needle || (r.selection ?? '').toLowerCase().includes(needle));
      const rootsByPage = new Map<string, ThreadRow[]>();
      for (const r of rows) {
        if (r.parentCommentId) continue;
        const list = rootsByPage.get(r.pageId) ?? [];
        list.push(r);
        rootsByPage.set(r.pageId, list);
      }

      const picked: ThreadRow[] = [];
      let next: Cursor | undefined;
      outer: for (const pid of pageIds) {
        let roots = (rootsByPage.get(pid) ?? []).sort(byTime);
        if (cursor?.t && pid === cursor.p) {
          const after = {
            createdAt: new Date(cursor.c ?? 0),
            id: cursor.t,
          } as ThreadRow;
          roots = roots.filter((r) => byTime(r, after) > 0);
        }
        for (const r of roots) {
          if (!matches(r)) continue;
          if (picked.length === COMMENT_THREADS_PER_CALL) {
            const last = picked[picked.length - 1];
            next = {
              p: pid,
              t: last.id,
              c: new Date(last.createdAt).toISOString(),
            };
            if (picked[picked.length - 1].pageId !== pid) next = { p: pid };
            break outer;
          }
          picked.push(r);
        }
      }
      if (!next && nextPage) next = { p: nextPage };

      const threads = picked.map((r) => ({
        id: r.id,
        page_id: r.pageId,
        selection: r.selection,
        body: plain(r.content),
        author: r.creatorName,
        created_at: new Date(r.createdAt).toISOString(),
        resolved: !!r.resolvedAt,
        replies: (replies.get(r.id) ?? []).map((x) => ({
          id: x.id,
          body: plain(x.content),
          author: x.creatorName,
          created_at: new Date(x.createdAt).toISOString(),
        })),
      }));

      return {
        threads,
        next_cursor: next ? encodeCursor(next) : null,
      };
    },
  };
}
