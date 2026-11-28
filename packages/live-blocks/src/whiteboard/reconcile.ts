// Ported from sinha-sahil/mindspace @149db12: src/lib/client/modules/whiteboard/collab.svelte.ts

export type WhiteboardElement = {
  id: string;
  version?: number;
  versionNonce?: number;
  index?: string | null;
  isDeleted?: boolean;
  [key: string]: unknown;
};

/**
 * Reconcile a remote element snapshot with the local current scene by element
 * id + version. Elements with a higher version (or higher versionNonce on a
 * tie) win; elements present on only one side are kept. Local ordering is
 * preserved, with remote-only elements appended.
 */
export function reconcileElements<
  T extends { id: string; version?: number; versionNonce?: number },
>(local: readonly T[], remote: readonly T[]): T[] {
  const remoteById = new Map<string, T>();
  for (const el of remote) {
    remoteById.set(el.id, el);
  }
  const result: T[] = [];
  const seen = new Set<string>();

  for (const localEl of local) {
    const remoteEl = remoteById.get(localEl.id);
    result.push(remoteEl && beats(remoteEl, localEl) ? remoteEl : localEl);
    seen.add(localEl.id);
  }
  for (const remoteEl of remote) {
    if (!seen.has(remoteEl.id)) {
      result.push(remoteEl);
    }
  }
  return result;
}

/** Above this a version is a hostile or broken write: +1 would no longer change it. */
export const MAX_ELEMENT_VERSION = 1_000_000_000;

/**
 * A stored version above this is read as 1. Honest edits add 1 at a time, so
 * only a hostile or broken write gets here; the gap up to MAX_ELEMENT_VERSION
 * leaves room for the edits made from such a value to still count.
 */
export const MAX_READ_VERSION = 900_000_000;

/** The version an element is read with: a stored version near or past the bound restarts at 1. */
export function readVersion(v: unknown): number {
  const sane = saneVersion(v);
  return sane === v && sane <= MAX_READ_VERSION ? sane : 1;
}

/** A version a client wrote, or 0 when it is not a sane non-negative integer. */
export function saneVersion(v: unknown): number {
  return typeof v === 'number' &&
    Number.isSafeInteger(v) &&
    v >= 0 &&
    v <= MAX_ELEMENT_VERSION
    ? v
    : 0;
}

/** A nonce a client wrote, or 0 when it is not a safe integer. */
export function saneNonce(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : 0;
}

/**
 * True when `a` should replace `b`: a higher version, or a higher versionNonce
 * on a tie. Missing values count as 0. (mindspace calls this `isNewer`.)
 * Changed from mindspace: a version that is not a sane integer counts as 0,
 * so NaN or 1e308 cannot make an element impossible to edit.
 */
export function beats(
  a: { version?: number; versionNonce?: number },
  b: { version?: number; versionNonce?: number },
): boolean {
  const va = saneVersion(a.version);
  const vb = saneVersion(b.version);
  if (va !== vb) {
    return va > vb;
  }
  return saneNonce(a.versionNonce) > saneNonce(b.versionNonce);
}
