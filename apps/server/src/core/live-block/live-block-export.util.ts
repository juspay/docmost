import {
  emptySnapshot,
  isRegisteredKind,
  LiveBlockSnapshot,
  renderStaticNodes,
  StaticRenderContext,
} from '@docmost/live-blocks';
import { LIVE_BLOCK_NODE_KIND } from './page-content.util';

type JsonNode = {
  type?: unknown;
  attrs?: Record<string, any>;
  content?: unknown;
};

const isNode = (v: unknown): v is JsonNode =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A copy of the content with each live block node replaced by its static nodes. */
export function inlineLiveBlocks(
  content: unknown,
  snapshots: Map<string, LiveBlockSnapshot>,
  ctxFor: (blockId: string, attrs: Record<string, any>) => StaticRenderContext,
): unknown {
  const render = (node: JsonNode): unknown[] => {
    const kind =
      typeof node.type === 'string' ? LIVE_BLOCK_NODE_KIND[node.type] : null;
    const blockId = node.attrs?.blockId;
    if (!kind || typeof blockId !== 'string' || !blockId) {
      return [visit(node)];
    }
    const ctx = ctxFor(blockId, node.attrs ?? {});
    if (!isRegisteredKind(kind)) {
      return [
        {
          type: 'paragraph',
          content: ctx.title ? [{ type: 'text', text: ctx.title }] : [],
        },
      ];
    }
    return renderStaticNodes(
      snapshots.get(blockId) ?? emptySnapshot(kind),
      ctx,
    );
  };

  const visit = (node: unknown): unknown => {
    if (!isNode(node)) return node;
    if (!Array.isArray(node.content)) return { ...node };
    return {
      ...node,
      content: node.content.flatMap((child) =>
        isNode(child) ? render(child) : [child],
      ),
    };
  };

  return visit(JSON.parse(JSON.stringify(content ?? null)));
}
