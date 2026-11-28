import { z } from 'zod';
import { ForbiddenException, Logger } from '@nestjs/common';
import { McpTool, McpToolError } from '../tool.types';
import { lossyNodeTypes } from '../markdown-loss';
import { loadViewablePage, McpDeps, pageUrl } from '../mcp-deps';
import { withLiveBlockPlaceholders } from '../live-block-placeholders';

const input = z.object({ page_id: z.string().min(1) });

const logger = new Logger('AgentMcp');

const STALE_NOTE =
  'The page may have unsaved changes that are not shown: the live document could not be reached, so this is the last saved version.';

export function getPageMarkdownTool(
  deps: McpDeps,
): McpTool<z.infer<typeof input>> {
  return {
    name: 'get_page_markdown',
    description:
      'Read a page as markdown, with its title, url and lossy_node_types: kinds of content (mentions, attachments, ...) that markdown cannot carry. Read this before rewriting a page with update_page_markdown. Each live block (whiteboard, to-do board, sheet) appears as one line <div data-type="..." data-block-id="..." data-title="...">...</div>: keep that line where the block should stay and do not change it; to remove a block, delete its line and name its block id in the remove_live_block_ids of update_page_markdown. Read a sheet with get_sheet. A note in the result says when the live document could not be reached and the last saved version is shown.',
    scope: 'read',
    input,
    async run(args, ctx) {
      const visible = await loadViewablePage(deps, ctx, args.page_id);
      // Store the open document first, so this read sees what
      // update_page_markdown will compare against. Only an open page needs it
      // (otherwise the stored content is current), and a read never fails
      // because the sync server is away: it serves the last saved version.
      let note: string | undefined;
      try {
        await deps.collaboration.handleYjsEvent(
          'flushDocument',
          `page.${visible.id}`,
          {},
          true,
        );
      } catch (e) {
        // any failure serves the saved version; logged so a fault that is not
        // "sync server away" does not hide behind the note
        logger.warn(
          `get_page_markdown could not flush page ${visible.id}, serving the saved version: ${e instanceof Error ? e.message : String(e)}`,
        );
        note = STALE_NOTE;
      }
      const page = await loadViewablePage(deps, ctx, visible.id, {
        includeContent: true,
      });
      // The page is visible, so a refusal here can say what is wrong
      try {
        await deps.pageAccess.validateCanExport(page.spaceId, page.workspaceId);
      } catch (e) {
        if (e instanceof ForbiddenException) {
          throw new McpToolError(
            'Export is disabled for this workspace or space, so pages cannot be read as markdown.',
          );
        }
        throw e;
      }
      // The export prepends the title as a "# Title" line when the page has one.
      // The title is returned on its own, and update_page_markdown takes a body
      // only, so leaving the line in would add a second title on every round trip.
      // Live blocks go out as placeholders that update_page_markdown maps back
      // to the same block, not as the static copy an export makes.
      const markdown = await withLiveBlockPlaceholders(
        page.content,
        (content) =>
          deps.exportService.exportPage('markdown', {
            ...page,
            content,
            title: null,
          } as typeof page),
      );
      return {
        page_id: page.id,
        title: page.title ?? '',
        url: await pageUrl(deps, ctx, page.slugId),
        markdown,
        lossy_node_types: lossyNodeTypes(page.content),
        ...(note ? { note } : {}),
      };
    },
  };
}
