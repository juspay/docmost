import type { LiveBlockKind } from '@docmost/live-blocks';

/** Editor node type → live block kind. */
export const LIVE_BLOCK_NODE_KIND: Record<string, LiveBlockKind> = {
  whiteboard: 'whiteboard',
  todoBoard: 'todo',
  sheet: 'sheet',
};

export function isLiveBlockNodeType(type: unknown): type is string {
  return (
    typeof type === 'string' &&
    Object.prototype.hasOwnProperty.call(LIVE_BLOCK_NODE_KIND, type)
  );
}

type JsonNode = {
  type?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown;
};

function isNode(v: unknown): v is JsonNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function liveBlockOf(node: JsonNode) {
  if (!isLiveBlockNodeType(node.type)) return null;
  const kind = LIVE_BLOCK_NODE_KIND[node.type];
  const blockId = node.attrs?.blockId;
  if (!kind || typeof blockId !== 'string' || !blockId) return null;
  const title = node.attrs?.title;
  return { blockId, kind, title: typeof title === 'string' ? title : null };
}

function walk(node: unknown, visit: (node: JsonNode) => void) {
  if (!isNode(node)) return;
  visit(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) walk(child, visit);
  }
}

export function findLiveBlocks(
  content: unknown,
): { blockId: string; kind: LiveBlockKind; title: string | null }[] {
  const found: {
    blockId: string;
    kind: LiveBlockKind;
    title: string | null;
  }[] = [];
  walk(content, (node) => {
    const block = liveBlockOf(node);
    if (block) found.push(block);
  });
  return found;
}

export function pageContainsBlock(content: unknown, blockId: string): boolean {
  return findLiveBlocks(content).some((b) => b.blockId === blockId);
}

/** Returns a copy with each mapped blockId replaced. */
export function replaceLiveBlockIds(
  content: unknown,
  map: Map<string, string>,
): unknown {
  if (content === null || content === undefined) return content;
  const copy = JSON.parse(JSON.stringify(content));
  if (map.size === 0) return copy;
  walk(copy, (node) => {
    const block = liveBlockOf(node);
    if (block && map.has(block.blockId)) {
      node.attrs.blockId = map.get(block.blockId);
    }
  });
  return copy;
}
