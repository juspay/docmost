import { z } from 'zod';
import { McpTool, McpToolError } from '../tool.types';
import { mcpAuditMeta, McpDeps } from '../mcp-deps';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { plainTextToCommentDoc } from '../comment-text';
import { loadCommentForCommenting } from './comment-access';

const input = z.object({
  comment_id: z.guid(),
  body: z.string().trim().min(1).max(10_000),
});

export function replyToCommentTool(
  deps: McpDeps,
): McpTool<z.infer<typeof input>> {
  return {
    name: 'reply_to_comment',
    description:
      "Reply to a comment thread. comment_id is the id of the thread's first comment (the id get_page_comments returns as a thread id), not of a reply. body is plain text. Needs permission to comment on the page.",
    scope: 'write',
    input,
    async run(args, ctx) {
      const { comment, page } = await loadCommentForCommenting(
        deps,
        ctx,
        args.comment_id,
      );
      if (comment.parentCommentId) {
        throw new McpToolError(
          'That comment is a reply. Reply to the first comment of the thread instead.',
        );
      }
      const reply = await deps.commentService.create(
        { page, workspaceId: ctx.workspace.id, user: ctx.user },
        {
          pageId: page.id,
          content: JSON.stringify(plainTextToCommentDoc(args.body)),
          parentCommentId: comment.id,
        } as any,
      );
      deps.audit.log({
        event: AuditEvent.COMMENT_CREATED,
        resourceType: AuditResource.COMMENT,
        resourceId: reply.id,
        spaceId: page.spaceId,
        metadata: { pageId: page.id, ...mcpAuditMeta(ctx) },
      });
      return { comment_id: reply.id, thread_id: comment.id };
    },
  };
}
