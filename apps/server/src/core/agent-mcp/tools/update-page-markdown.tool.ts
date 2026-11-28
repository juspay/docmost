import { z } from 'zod';
import { McpTool, McpToolError } from '../tool.types';
import { loadEditablePage, McpDeps, pageUrl } from '../mcp-deps';
import { AnchorHint, reanchorComments } from '../comment-reanchor.util';
import { LIVE_BLOCK_NODE_KIND } from '../../live-block/page-content.util';
import { liveBlockNodes } from '../live-block-placeholders';

const input = z.object({
  page_id: z.string().min(1),
  content: z.string().max(1_000_000).optional(),
  title: z.string().max(500).optional(),
  allow_lossy: z.boolean().optional(),
  remove_live_block_ids: z.array(z.string().min(1).max(64)).max(500).optional(),
});

function liveBlocksNote(
  r: { kept_in_place: number; appended_at_end: number; removed: number },
  removedIds: string[],
): string {
  const n = (count: number) => `${count} live block${count === 1 ? '' : 's'}`;
  const parts = [`${n(r.kept_in_place)} kept in place`];
  if (r.appended_at_end > 0) {
    parts.push(
      `${n(r.appended_at_end)} had no placeholder in your content and ${r.appended_at_end === 1 ? 'was' : 'were'} added at the end of the page`,
    );
  }
  if (r.removed > 0) {
    parts.push(`${n(r.removed)} removed: ${removedIds.join(', ')}`);
  }
  return parts.join('; ') + '.';
}

const MAX_PLACEHOLDERS = 500;

const plural = (types: string[]) => {
  const names = types.map((t) => `${t}s`);
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : names[0];
};

export function updatePageMarkdownTool(
  deps: McpDeps,
): McpTool<z.infer<typeof input>> {
  return {
    name: 'update_page_markdown',
    description:
      "Replace a page's content with markdown and/or change its title. Call get_page_markdown first and edit what it returned. Each live block (whiteboard, to-do board, sheet) is a placeholder line <div data-type=... data-block-id=...>: the block stays live wherever its placeholder is; a placeholder for a block that is not on this page is refused. A live block whose placeholder is missing is added at the end of the page (blocks a person added after your read are kept this way). To remove a block, delete its placeholder line AND list its block_id in remove_live_block_ids; an id listed there whose placeholder is still in the content, or that is not a live block of this page, is refused and nothing is written. Comment threads stay attached where their quoted text still occurs exactly once (the rest are reported as orphaned). Content that markdown cannot carry (see lossy_node_types) is refused unless allow_lossy is true. The previous content stays in page history. Returns anchored and orphaned counts, live_blocks (how many were kept in place, added at the end and removed) and live_blocks_note naming the removed ids.",
    scope: 'write',
    input,
    async run(args, ctx) {
      if (args.content === undefined && args.title === undefined) {
        throw new McpToolError('Pass content, title or both');
      }
      const authorised = await loadEditablePage(deps, ctx, args.page_id);
      const result = {
        anchored: 0,
        orphaned: 0,
        live_blocks: { kept_in_place: 0, appended_at_end: 0, removed: 0 },
        live_blocks_note: '',
      };
      const setTitle = (title: string) =>
        deps.pageService.update(
          authorised,
          { pageId: authorised.id, title } as any,
          ctx.user,
        );

      // everything that can refuse the call runs before anything is written
      const prepared =
        args.content !== undefined ? await prepareContent() : undefined;

      // The title goes first: if it fails, nothing has changed. If the
      // content then fails, the old title is put back, so the page never
      // ends up with new content under an old title or the other way round.
      const titleChanged =
        args.title !== undefined && args.title !== authorised.title;
      if (titleChanged) await setTitle(args.title);

      if (args.content !== undefined) {
        try {
          await replaceContent(prepared);
        } catch (err) {
          if (!titleChanged) throw err;
          const said =
            err instanceof McpToolError
              ? err.message
              : 'The content could not be replaced (an internal error); it may or may not have been applied.';
          throw new McpToolError(`${said} ${await undoTitle()}`);
        }
      }

      // Puts the old title back only while the title is still the one this
      // call set, so a rename made meanwhile is kept. Says what happened.
      async function undoTitle(): Promise<string> {
        let restored: boolean;
        try {
          // one conditional update: a rename made meanwhile is never overwritten
          restored = await deps.queries.restoreTitleIfUnchanged(
            authorised.id,
            args.title,
            authorised.title ?? '',
          );
        } catch {
          return `The new title "${args.title}" stayed: putting the old title back failed.`;
        }
        if (restored) return 'The title change was undone.';
        const now = await deps.pageRepo.findById(authorised.id);
        return `The title was not put back: it was changed again meanwhile and is now "${now?.title ?? ''}".`;
      }

      async function prepareContent() {
        const parsed = await deps.pageService.parseProsemirrorContent(
          args.content,
          'markdown',
        );
        // a placeholder may only name a block of this page; one query for all
        const nodes = liveBlockNodes(parsed);
        const distinct = new Set(nodes.map((n) => String(n.attrs?.blockId)));
        if (distinct.size > MAX_PLACEHOLDERS) {
          throw new McpToolError(
            `The content holds ${distinct.size} live block placeholders; a page write takes at most ${MAX_PLACEHOLDERS} live block placeholders.`,
          );
        }
        const kindOf = new Map(
          (await deps.liveBlockRepo.findByPageIds([authorised.id])).map(
            (row) => [row.id, row.kind] as const,
          ),
        );
        const placed = new Set<string>();
        for (const node of nodes) {
          const id = node.attrs?.blockId;
          if (kindOf.get(id) !== LIVE_BLOCK_NODE_KIND[node.type]) {
            throw new McpToolError(
              `The placeholder for block ${String(id)} (${node.type}) names a block that is not on this page. Keep placeholders exactly as get_page_markdown returned them.`,
            );
          }
          placed.add(id);
        }
        // a block is removed only when the agent names it and took it out
        const removeIds = [...new Set(args.remove_live_block_ids ?? [])];
        for (const id of removeIds) {
          if (placed.has(id)) {
            throw new McpToolError(
              `Block ${id} is still in the content, so it cannot be removed. Delete its placeholder line too, or leave it out of remove_live_block_ids.`,
            );
          }
          if (!kindOf.has(id)) {
            throw new McpToolError(
              `Block ${id} is not a live block of this page, so it cannot be removed.`,
            );
          }
        }
        const threads = await deps.queries.listThreadRows([authorised.id]);
        const hints: AnchorHint[] = threads
          .filter((t) => !t.parentCommentId && t.selection)
          .map((t) => ({
            commentId: t.id,
            quote: t.selection!,
            resolved: !!t.resolvedAt,
          }));
        return { ...reanchorComments(parsed, hints), removeIds };
      }

      async function replaceContent(
        ready: Awaited<ReturnType<typeof prepareContent>>,
      ) {
        const documentName = `page.${authorised.id}`;
        const { doc, anchored, orphaned, removeIds } = ready;

        const done = await deps.collaboration.handleYjsEvent(
          'replacePageContentKeepingLiveBlocks',
          documentName,
          {
            prosemirrorJson: doc,
            user: ctx.user,
            allowLossy: !!args.allow_lossy,
            removeBlockIds: removeIds,
          },
        );
        // undefined means collaboration is switched off and nothing was written
        if (!done)
          throw new Error('Collaboration service did not apply the update');

        // refused from inside the live document: nothing was written
        if (done.refusedLossy.length > 0) {
          throw new McpToolError(
            `This page has ${plural(done.refusedLossy)}, which a markdown replace would delete. Pass allow_lossy to replace anyway.`,
          );
        }

        result.anchored = anchored.length;
        result.orphaned = orphaned.length;
        result.live_blocks = {
          kept_in_place: done.keptBlocks,
          appended_at_end: done.appendedBlocks,
          removed: done.removedBlocks,
        };
        result.live_blocks_note = liveBlocksNote(
          result.live_blocks,
          done.removedBlockIds ?? [],
        );
      }

      return {
        page_id: authorised.id,
        url: await pageUrl(deps, ctx, authorised.slugId),
        ...result,
      };
    },
  };
}
