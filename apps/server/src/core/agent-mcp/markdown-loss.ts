import { LIVE_BLOCK_NODE_KIND } from '../live-block/page-content.util';

// Node and mark types proven by markdown-loss.spec.ts to come back unchanged
// after export to markdown and import. Do not add a type without a sample there.
export const MARKDOWN_SAFE_NODE_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'callout',
  'details',
  'detailsSummary',
  'detailsContent',
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'superscript',
  'subscript',
]);

// Not lossy even though markdown drops them: the structure is text, the
// comment mark is put back by reanchorComments, and live blocks are kept by the
// page replace itself.
const HANDLED_ELSEWHERE: ReadonlySet<string> = new Set([
  'doc',
  'text',
  'comment',
  ...Object.keys(LIVE_BLOCK_NODE_KIND),
]);

/** Node and mark types in the content that a markdown replace would lose. */
export function lossyNodeTypes(content: unknown): string[] {
  const found = new Set<string>();
  const seen = (type: unknown) => {
    if (
      typeof type === 'string' &&
      !MARKDOWN_SAFE_NODE_TYPES.has(type) &&
      !HANDLED_ELSEWHERE.has(type)
    ) {
      found.add(type);
    }
  };
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    seen(node.type);
    for (const mark of node.marks ?? []) seen(mark?.type);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(content);
  return [...found].sort();
}
