import { McpDeps } from './mcp-deps';
import { McpTool } from './tool.types';
import { listSpacesTool } from './tools/list-spaces.tool';
import { listPagesTool } from './tools/list-pages.tool';
import { getPageMarkdownTool } from './tools/get-page-markdown.tool';
import { getPageCommentsTool } from './tools/get-page-comments.tool';
import { createPageFromMarkdownTool } from './tools/create-page-from-markdown.tool';
import { updatePageMarkdownTool } from './tools/update-page-markdown.tool';
import { replyToCommentTool } from './tools/reply-to-comment.tool';
import { resolveCommentTool } from './tools/resolve-comment.tool';
import { createWhiteboardTool } from './tools/create-whiteboard.tool';
import { createTodoBoardTool } from './tools/create-todo-board.tool';
import { createSheetTool } from './tools/create-sheet.tool';
import { getSheetTool } from './tools/get-sheet.tool';
import { setSheetCellsTool } from './tools/set-sheet-cells.tool';

// Each task that adds tools appends its factory here and its fixture to
// testing/tool-fixtures.ts; tool-registry.spec.ts fails if either is missing.
export function buildTools(deps: McpDeps): McpTool[] {
  return [
    listSpacesTool(deps),
    listPagesTool(deps),
    getPageMarkdownTool(deps),
    getPageCommentsTool(deps),
    createPageFromMarkdownTool(deps),
    updatePageMarkdownTool(deps),
    replyToCommentTool(deps),
    resolveCommentTool(deps),
    createWhiteboardTool(deps),
    createTodoBoardTool(deps),
    createSheetTool(deps),
    getSheetTool(deps),
    setSheetCellsTool(deps),
  ];
}
