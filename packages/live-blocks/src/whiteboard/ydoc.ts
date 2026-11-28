import * as Y from 'yjs';
import {
  beats,
  readVersion,
  saneNonce,
  type WhiteboardElement,
} from './reconcile';
import { dropReferences, sanitizeElement } from './safety';
import { LOWER_UUID } from '../document-name';

/** Mirrors the input limit in schema.ts (imported from there would make a cycle). */
const MAX_WHITEBOARD_FILES = 2_000;

export type WhiteboardFileRef = { attachmentId: string; mimeType: string };

const ELEMENTS = 'elements';
const FILES = 'files';

function elementsMap(doc: Y.Doc): Y.Map<WhiteboardElement> {
  return doc.getMap<WhiteboardElement>(ELEMENTS);
}

function filesMap(doc: Y.Doc): Y.Map<WhiteboardFileRef> {
  return doc.getMap<WhiteboardFileRef>(FILES);
}

function isElement(v: unknown): v is WhiteboardElement {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as WhiteboardElement).id === 'string'
  );
}

/** A reference to one of the page's attachments: the id goes into copies and URLs, so only a uuid. */
export function isFileRef(v: unknown): v is WhiteboardFileRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as WhiteboardFileRef).attachmentId === 'string' &&
    LOWER_UUID.test((v as WhiteboardFileRef).attachmentId) &&
    typeof (v as WhiteboardFileRef).mimeType === 'string'
  );
}

/**
 * Writes, in one transaction, each local element that is absent or beats the
 * stored copy. Never deletes a key. Returns how many were written.
 */
export function pushElements(
  doc: Y.Doc,
  local: readonly WhiteboardElement[],
  origin?: unknown,
): number {
  const map = elementsMap(doc);
  const changed = local.filter((el) => {
    const stored = map.get(el.id);
    if (!isElement(stored)) return true;
    // an unchanged copy (same version and nonce as stored) is not written again
    if (
      el.version === stored.version &&
      (el.versionNonce ?? 0) === (stored.versionNonce ?? 0)
    ) {
      return false;
    }
    // compared with the stored copy as everyone reads it, so an edit made from
    // a repaired version always wins
    return beats(el, {
      version: readVersion(stored.version),
      versionNonce: saneNonce(stored.versionNonce),
    });
  });
  if (changed.length === 0) return 0;
  doc.transact(() => {
    // plain copies: Excalidraw elements may be frozen or carry prototypes
    for (const el of changed) map.set(el.id, JSON.parse(JSON.stringify(el)));
  }, origin);
  return changed.length;
}

/** A stored version that is not a sane integer is read as 1, so the next edit wins. */
function repairVersion(el: WhiteboardElement): WhiteboardElement {
  const version = readVersion(el.version);
  const versionNonce = saneNonce(el.versionNonce);
  if (version === el.version && versionNonce === (el.versionNonce ?? 0)) {
    return el;
  }
  return { ...el, version, versionNonce };
}

function compareIndex(a: WhiteboardElement, b: WhiteboardElement): number {
  const ia = typeof a.index === 'string' ? a.index : null;
  const ib = typeof b.index === 'string' ? b.index : null;
  if (ia !== ib) {
    if (ia === null) return 1;
    if (ib === null) return -1;
    return ia < ib ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every element, tombstones included, sorted by index then id. */
export function readElements(doc: Y.Doc): WhiteboardElement[] {
  const out: WhiteboardElement[] = [];
  const removed = new Set<string>();
  elementsMap(doc).forEach((v, key) => {
    // written by any editor: only what a viewer may see leaves the document
    const safe = isElement(v) ? sanitizeElement(v) : null;
    if (safe) out.push(repairVersion(safe));
    else removed.add(isElement(v) ? v.id : key);
  });
  // nothing kept may point at what was left out
  return dropReferences(out, removed).elements.sort(compareIndex);
}

export function setFile(
  doc: Y.Doc,
  fileId: string,
  ref: WhiteboardFileRef,
  origin?: unknown,
): void {
  doc.transact(() => {
    filesMap(doc).set(fileId, {
      attachmentId: ref.attachmentId,
      mimeType: ref.mimeType,
    });
  }, origin);
}

export function readFiles(doc: Y.Doc): Record<string, WhiteboardFileRef> {
  const out: Record<string, WhiteboardFileRef> = {};
  let count = 0;
  filesMap(doc).forEach((v, k) => {
    // assigning this key would replace the object's prototype
    if (k === '__proto__') return;
    // every reference is fetched by every viewer: a board holds a bounded number
    if (count >= MAX_WHITEBOARD_FILES) return;
    if (isFileRef(v)) count++;
    if (isFileRef(v))
      out[k] = { attachmentId: v.attachmentId, mimeType: v.mimeType };
  });
  return out;
}
