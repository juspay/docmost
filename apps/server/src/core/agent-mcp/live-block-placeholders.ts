import { randomBytes } from 'node:crypto';
import { isLiveBlockNodeType } from '../live-block/page-content.util';

// A live block in markdown: one raw HTML line the editor schema parses back
// into the same node (the block nodes parse `div[data-type=...]` and read
// data-block-id and data-title).

const escapeAttr = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeText = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const KIND_NAME: Record<string, string> = {
  whiteboard: 'Whiteboard',
  todoBoard: 'To-do board',
  sheet: 'Spreadsheet',
};

export function liveBlockPlaceholder(node: {
  type: string;
  attrs?: Record<string, unknown>;
}): string {
  const blockId = String(node.attrs?.blockId ?? '');
  // one line, whatever the title holds: a blank line would end the HTML
  // block and a pipe would split a table row; the live copy's title wins anyway
  const title =
    typeof node.attrs?.title === 'string'
      ? node.attrs.title.replace(/\s+/g, ' ')
      : null;
  const hint = `${KIND_NAME[node.type] ?? 'Live block'}: a live block, kept as it is. Move or delete this line; do not edit it.`;
  return `<div data-type="${node.type}" data-block-id="${escapeAttr(blockId)}"${title !== null ? ` data-title="${escapeAttr(title).replace(/\|/g, '&#124;')}"` : ''}>${escapeText(hint)}</div>`;
}

/**
 * Exports `content` with each live block replaced by its placeholder line.
 * The blocks are swapped for marker paragraphs before the export (so the
 * export has nothing to inline) and the markers for placeholders after.
 */
export async function withLiveBlockPlaceholders(
  content: unknown,
  exportMarkdown: (content: unknown) => Promise<string>,
): Promise<string> {
  const nonce = randomBytes(6).toString('hex');
  const placeholders: string[] = [];
  const swap = (node: any): any => {
    if (!node || typeof node !== 'object') return node;
    if (isLiveBlockNodeType(node.type) && node.attrs?.blockId) {
      const marker = `LIVEBLOCK${nonce}X${placeholders.length}`;
      placeholders.push(liveBlockPlaceholder(node));
      return { type: 'paragraph', content: [{ type: 'text', text: marker }] };
    }
    if (!Array.isArray(node.content)) return node;
    return { ...node, content: node.content.map(swap) };
  };
  const swapped = swap(content);
  const markdown = await exportMarkdown(swapped);
  if (placeholders.length === 0) return markdown;
  return markdown.replace(
    new RegExp(`LIVEBLOCK${nonce}X(\\d+)`, 'g'),
    (_m, i) => placeholders[Number(i)],
  );
}

/** Every live block node in parsed content, at any depth. */
export function liveBlockNodes(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (isLiveBlockNodeType(node.type)) out.push(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) liveBlockNodes(child, out);
  }
  return out;
}
