import { z } from 'zod';
import { McpTool, McpToolError, NOT_FOUND } from '../tool.types';
import { asVisible, loadViewablePage, McpDeps, pageUrl } from '../mcp-deps';
import { PageRow } from '../mcp-queries';
import { LIVE_BLOCK_KINDS, LiveBlockKind } from '@docmost/live-blocks';
import { findLiveBlocks } from '../../live-block/page-content.util';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';

export const PAGE_LIMIT = 100;
const MAX_SCAN_ROUNDS = 10;

const input = z.object({
  space_id: z.guid(),
  parent_page_id: z.string().min(1).optional(),
  cursor: z.guid().optional(),
  block_kind: z.enum(LIVE_BLOCK_KINDS).optional(),
});

export type ListedPage = {
  id: string;
  slug_id: string;
  title: string;
  parent_page_id: string | null;
  url: string;
  blocks: ListedBlock[];
};

export type ListedBlock = {
  block_id: string;
  kind: LiveBlockKind;
  title: string | null;
};

async function blocksOf(
  deps: McpDeps,
  pageIds: string[],
): Promise<Map<string, ListedBlock[]>> {
  const rows = await deps.queries.listLiveBlockNodes(pageIds);
  return new Map(
    rows.map((row) => [
      row.id,
      findLiveBlocks({ content: row.nodes }).map((b) => ({
        block_id: b.blockId,
        kind: b.kind,
        title: b.title,
      })),
    ]),
  );
}

export function listPagesTool(deps: McpDeps): McpTool<z.infer<typeof input>> {
  return {
    name: 'list_pages',
    description:
      "List up to 100 pages you can view in a space. Without parent_page_id every page in the space is listed (flat); with it, only that page's direct children. Each page lists its live blocks (block_id, kind, title); block_kind (whiteboard, todo or sheet) keeps only pages holding a block of that kind. Pass the returned next_cursor as cursor for more.",
    scope: 'read',
    input,
    async run(args, ctx) {
      await asVisible(async () => {
        const ability = await deps.spaceAbility.createForUser(
          ctx.user,
          args.space_id,
        );
        if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
          throw new McpToolError(NOT_FOUND);
        }
      });

      if (args.parent_page_id) {
        const parent = await loadViewablePage(deps, ctx, args.parent_page_id);
        if (parent.spaceId !== args.space_id) throw new McpToolError(NOT_FOUND);
        args = { ...args, parent_page_id: parent.id };
      }

      // Restricted pages are filtered after the read, so keep reading until the
      // page is full or the space is exhausted.
      const visible: PageRow[] = [];
      const blocks = new Map<string, ListedBlock[]>();
      let after = args.cursor;
      let exhausted = false;
      for (
        let i = 0;
        i < MAX_SCAN_ROUNDS && visible.length <= PAGE_LIMIT;
        i++
      ) {
        const rows = await deps.queries.listPageRows({
          spaceId: args.space_id,
          workspaceId: ctx.workspace.id,
          parentPageId: args.parent_page_id,
          afterId: after,
          limit: PAGE_LIMIT,
        });
        if (rows.length === 0) {
          exhausted = true;
          break;
        }
        after = rows[rows.length - 1].id;
        const allowed = new Set(
          await deps.pagePermissionRepo.filterAccessiblePageIds({
            pageIds: rows.map((r) => r.id),
            userId: ctx.user.id,
            spaceId: args.space_id,
          }),
        );
        let kept = rows.filter((r) => allowed.has(r.id));
        if (args.block_kind) {
          const found = await blocksOf(
            deps,
            kept.map((r) => r.id),
          );
          found.forEach((v, k) => blocks.set(k, v));
          kept = kept.filter((r) =>
            blocks.get(r.id)?.some((b) => b.kind === args.block_kind),
          );
        }
        visible.push(...kept);
        if (rows.length < PAGE_LIMIT) {
          exhausted = true;
          break;
        }
      }

      const hasMore = !exhausted || visible.length > PAGE_LIMIT;
      const slice = visible.slice(0, PAGE_LIMIT);
      const nextCursor = hasMore
        ? visible.length > PAGE_LIMIT
          ? slice[slice.length - 1]?.id
          : after
        : undefined;

      const missing = slice.filter((r) => !blocks.has(r.id)).map((r) => r.id);
      if (missing.length > 0) {
        (await blocksOf(deps, missing)).forEach((v, k) => blocks.set(k, v));
      }

      const pages: ListedPage[] = await Promise.all(
        slice.map(async (r) => ({
          id: r.id,
          slug_id: r.slugId,
          title: r.title ?? '',
          parent_page_id: r.parentPageId,
          url: await pageUrl(deps, ctx, r.slugId),
          blocks: blocks.get(r.id) ?? [],
        })),
      );

      return {
        pages,
        next_cursor: nextCursor ?? null,
      };
    },
  };
}
