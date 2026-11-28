import { McpDeps, asVisible } from '../mcp-deps';
import { McpContext, McpToolError, NOT_FOUND } from '../tool.types';

// The comment and its page, if the person may comment there. A missing,
// deleted, foreign-workspace or forbidden comment all answer NOT_FOUND.
export function loadCommentForCommenting(
  deps: McpDeps,
  ctx: McpContext,
  commentId: string,
) {
  return asVisible(async () => {
    const comment = await deps.commentRepo.findById(commentId);
    if (
      !comment ||
      comment.deletedAt ||
      comment.workspaceId !== ctx.workspace.id
    ) {
      throw new McpToolError(NOT_FOUND);
    }
    const page = await deps.pageRepo.findById(comment.pageId);
    if (!page || page.deletedAt || page.workspaceId !== ctx.workspace.id) {
      throw new McpToolError(NOT_FOUND);
    }
    await deps.pageAccess.validateCanComment(page, ctx.user, ctx.workspace.id);
    return { comment, page };
  });
}
