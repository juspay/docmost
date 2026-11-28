import type { TodoBoard, TodoNode } from './board';

const textContent = (s: string) =>
  s ? [{ type: 'text', text: s }] : undefined;

function paragraph(text: string, bold = false): Record<string, unknown> {
  const content = textContent(text);
  if (!content) return { type: 'paragraph' };
  return {
    type: 'paragraph',
    content: bold ? [{ ...content[0], marks: [{ type: 'bold' }] }] : content,
  };
}

/**
 * A sibling list as blocks: consecutive tasks share one task list, and a
 * section is a bold paragraph that ends it, with its own children after it.
 */
function blocks(nodes: TodoNode[]): unknown[] {
  const out: unknown[] = [];
  let list: unknown[] | null = null;
  for (const node of nodes) {
    if (node.kind === 'section') {
      list = null;
      out.push(paragraph(node.text, true), ...blocks(node.children));
      continue;
    }
    if (!list) {
      list = [];
      out.push({ type: 'taskList', content: list });
    }
    list.push({
      type: 'taskItem',
      attrs: { checked: node.done },
      content: [paragraph(node.text), ...blocks(node.children)],
    });
  }
  return out;
}

/** The board as ProseMirror nodes the page export already understands. */
export function boardToTaskListNodes(board: TodoBoard): unknown[] {
  return board.columns.flatMap((column) => [
    {
      type: 'heading',
      attrs: { level: 3 },
      content: textContent(column.title),
    },
    ...blocks(column.nodes),
  ]);
}
