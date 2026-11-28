import type * as Y from 'yjs';
import { LIVE_BLOCK_KINDS, type LiveBlockKind } from './kinds';
import {
  LiveBlockInputError,
  type LiveBlockSnapshot,
  type StaticRenderContext,
} from './snapshot';
import type { LiveBlockOp } from './ops';

export type KindDefinition<S extends LiveBlockSnapshot = LiveBlockSnapshot> = {
  kind: LiveBlockKind;
  empty(): S;
  /** Must not throw on any document a client can produce. */
  /** options.budgetMs bounds the work where a kind has costly parts (sheets). */
  build(doc: Y.Doc, options?: { budgetMs?: number }): S;
  seed(doc: Y.Doc, snapshot: S): void;
  /** Untrusted input (MCP, migration). Throws LiveBlockInputError. */
  validate(input: unknown): S;
  /** ProseMirror JSON nodes the export pipeline already understands. */
  staticNodes(snapshot: S, ctx: StaticRenderContext): unknown[];
  applyOp?(doc: Y.Doc, op: LiveBlockOp): void;
  /** Attachments this block refers to from inside its document. */
  attachmentIds?(doc: Y.Doc): string[];
  remapAttachments?(doc: Y.Doc, map: Map<string, string>): void;
};

const definitions = new Map<LiveBlockKind, KindDefinition<any>>();

export function registerKind<S extends LiveBlockSnapshot>(
  def: KindDefinition<S>,
): void {
  if (definitions.has(def.kind)) {
    throw new Error(`Live block kind "${def.kind}" is already registered`);
  }
  definitions.set(def.kind, def);
}

export function kindDefinition(kind: LiveBlockKind): KindDefinition {
  const def = definitions.get(kind);
  if (!def) {
    throw new LiveBlockInputError(`Unknown live block kind: ${String(kind)}`);
  }
  return def;
}

export function registeredKinds(): LiveBlockKind[] {
  return LIVE_BLOCK_KINDS.filter((k) => definitions.has(k));
}

export function isRegisteredKind(v: unknown): v is LiveBlockKind {
  return typeof v === 'string' && definitions.has(v as LiveBlockKind);
}
