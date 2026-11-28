export function claudeCodeCommand(url: string): string {
  return `claude mcp add --transport http docmost ${url} \\\n  --header "Authorization: Bearer dmp_paste_your_token_here"`;
}

export function jsonConfig(url: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        docmost: {
          type: "http",
          url,
          headers: { Authorization: "Bearer dmp_paste_your_token_here" },
        },
      },
    },
    null,
    2,
  );
}

// For people moving prompts over from mindspace.
export const MINDSPACE_TOOL_CHANGES: [string, string][] = [
  ["list_workspaces", "list_spaces"],
  [
    "list_projects, list_documents (which returned content)",
    "list_pages for the list, get_page_markdown for content",
  ],
  ["create_doc_project, upload_markdown", "create_page_from_markdown"],
  ["update_markdown { document_id }", "update_page_markdown { page_id }"],
  [
    "get_document_comments with quote, start, end; get_project_comments",
    "get_page_comments with quote and include_child_pages. start and end are gone: docmost does not store character offsets.",
  ],
  [
    "create_whiteboard_project, create_todo_project, create_sheet_project with workspace_id",
    "create_whiteboard, create_todo_board, create_sheet with space_id or page_id",
  ],
  [
    "get_sheet, set_sheet_cells with project_id",
    "Same names with block_id; sheet_id, sheet_name and create_sheet unchanged",
  ],
  ["reply_to_comment, resolve_comment", "Unchanged"],
];
