import { z } from 'zod';
import { McpTool, McpToolError } from '../tool.types';
import { mcpAuditMeta, McpDeps } from '../mcp-deps';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { loadCommentForCommenting } from './comment-access';

const input = z.object({
  comment_id: z.guid(),
  resolved: z.boolean().default(true),
});

export function resolveCommentTool(
  deps: McpDeps,
): McpTool<z.infer<typeof input>> {
  return {
    name: 'resolve_comment',
    description:
      "Resolve a comment thread, or reopen it with resolved: false. comment_id is the id of the thread's first comment. The highlight on the page is updated too. Needs permission to comment on the page.",
    scope: 'write',
    input,
    async run(args, ctx) {
      const { comment } = await loadCommentForCommenting(
        deps,
        ctx,
        args.comment_id,
      );
      if (comment.parentCommentId) {
        throw new McpToolError(
          'That comment is a reply. Use the id of the first comment of the thread.',
        );
      }
      // no browser is open to update the highlight for us, so the server does
      const updated = await deps.commentService.resolve(
        comment,
        args.resolved,
        ctx.user,
        { updateYjsMark: true },
      );
      deps.audit.log({
        event: args.resolved
          ? AuditEvent.COMMENT_RESOLVED
          : AuditEvent.COMMENT_REOPENED,
        resourceType: AuditResource.COMMENT,
        resourceId: comment.id,
        spaceId: comment.spaceId,
        metadata: { pageId: comment.pageId, ...mcpAuditMeta(ctx) },
      });
      return { comment_id: updated.id, resolved: !!updated.resolvedAt };
    },
  };
}
