import type { Editor } from '@tiptap/core';

/** What this session did to live blocks. Held in memory only, never in the document. */
export type LiveBlockOrigin = {
  /** Ids this person inserted: nothing is stored under them yet. */
  created: Set<string>;
  /** New id → id it was copied from. `id → id` marks a block this person pasted here. */
  copies: Map<string, string>;
};

const fallback = new WeakMap<object, LiveBlockOrigin>();

export function liveBlockOrigin(editor: Editor): LiveBlockOrigin {
  const stored = (editor.storage as any)?.liveBlockIdentity?.origin;
  if (stored) return stored;
  let origin = fallback.get(editor);
  if (!origin) {
    origin = { created: new Set(), copies: new Map() };
    fallback.set(editor, origin);
  }
  return origin;
}

export const LIVE_BLOCK_NODE_NAMES = ['whiteboard', 'todoBoard', 'sheet'];

export function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * A block's attributes under a new id. Anything that points at a file of the
 * old block (a whiteboard's preview) is dropped, so a copy gets its own file
 * and never overwrites the original's.
 */
export function withNewBlockId(
  attrs: Record<string, any>,
  blockId: string,
): Record<string, any> {
  const next: Record<string, any> = { ...attrs, blockId };
  if ('attachmentId' in next) next.attachmentId = null;
  if ('src' in next) next.src = null;
  return next;
}
