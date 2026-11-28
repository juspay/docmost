import { kindDefinition } from './registry';
import type { LiveBlockSnapshot, StaticRenderContext } from './snapshot';

export function renderStaticNodes(
  snapshot: LiveBlockSnapshot,
  ctx: StaticRenderContext,
): unknown[] {
  return kindDefinition(snapshot.kind).staticNodes(snapshot, ctx);
}
