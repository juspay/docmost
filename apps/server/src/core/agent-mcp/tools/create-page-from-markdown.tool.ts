import { z } from 'zod';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { getPageTitle } from '../../../common/helpers';
import { McpTool, McpToolError, NOT_FOUND } from '../tool.types';
import { liveBlockNodes } from '../live-block-placeholders';
import {
  asVisible,
  loadEditablePage,
  mcpAuditMeta,
  McpDeps,
  pageUrl,
} from '../mcp-deps';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';

const input = z.object({
  space_id: z.guid(),
  title: z.string().max(500),
  content: z.string().max(1_000_000),
  parent_page_id: z.string().min(1).optional(),
});

export function createPageFromMarkdownTool(
  deps: McpDeps,
): McpTool<z.infer<typeof input>> {
  return {
    name: 'create_page_from_markdown',
    description:
      'Create a page from markdown in a space, optionally under a parent page. Needs permission to create pages in the space, and edit access on the parent when one is given. Live block placeholder lines from get_page_markdown are refused: a block belongs to its page; add new blocks with create_whiteboard, create_todo_board or create_sheet. Returns page_id and url.',
    scope: 'write',
    input,
    async run(args, ctx) {
      // a placeholder would put another page's block on the new page, dead
      const parsed = await deps.pageService.parseProsemirrorContent(
        args.content,
        'markdown',
      );
      if (liveBlockNodes(parsed).length > 0) {
        throw new McpToolError(
          "The content holds a live block placeholder (a <div data-type=... data-block-id=...> line). A new page cannot take another page's live blocks: remove those lines, and add new blocks with create_whiteboard, create_todo_board or create_sheet.",
        );
      }
      // like the create_* block tools: create in the space AND edit on the parent
      await asVisible(async () => {
        const ability = await deps.spaceAbility.createForUser(
          ctx.user,
          args.space_id,
        );
        if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
          throw new McpToolError(NOT_FOUND);
        }
      });

      let parentPageId: string | undefined;
      if (args.parent_page_id) {
        const parent = await loadEditablePage(deps, ctx, args.parent_page_id);
        if (parent.spaceId !== args.space_id) throw new McpToolError(NOT_FOUND);
        parentPageId = parent.id;
      }

      const page = await deps.pageService.create(
        ctx.user.id,
        ctx.workspace.id,
        {
          spaceId: args.space_id,
          title: args.title,
          parentPageId,
          content: args.content,
          format: 'markdown',
        },
      );

      deps.audit.log({
        event: AuditEvent.PAGE_CREATED,
        resourceType: AuditResource.PAGE,
        resourceId: page.id,
        spaceId: args.space_id,
        changes: {
          after: { title: getPageTitle(args.title), spaceId: args.space_id },
        },
        metadata: mcpAuditMeta(ctx),
      });

      return {
        page_id: page.id,
        url: await pageUrl(deps, ctx, page.slugId),
      };
    },
  };
}
