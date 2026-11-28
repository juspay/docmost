import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { LiveBlockInputError, type WhiteboardSnapshot } from '../snapshot';
import { readVersion, saneNonce, type WhiteboardElement } from './reconcile';
import { isFileRef, type WhiteboardFileRef } from './ydoc';
import { canonicalEmbedLink, SAFE_ELEMENT_TYPES, unsafeReason } from './safety';

export const MAX_WHITEBOARD_ELEMENTS = 20_000;
export const MAX_ELEMENT_POINTS = 10_000;
export const MAX_WHITEBOARD_FILES = 2_000;

export const WHITEBOARD_ELEMENT_TYPES = SAFE_ELEMENT_TYPES;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkElement(v: unknown, i: number): WhiteboardElement {
  if (!isObject(v) || typeof v.id !== 'string' || v.id.length === 0) {
    throw new LiveBlockInputError(`Element ${i} has no string id`);
  }
  if (typeof v.type !== 'string' || !WHITEBOARD_ELEMENT_TYPES.has(v.type)) {
    throw new LiveBlockInputError(
      `Element ${v.id} has an unknown type: ${String(v.type)}`,
    );
  }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) {
      throw new LiveBlockInputError(`Element ${v.id} has a non-finite ${key}`);
    }
  }
  const unsafe = unsafeReason(v);
  if (unsafe) {
    throw new LiveBlockInputError(`Element ${v.id} has ${unsafe}`);
  }
  if (Array.isArray(v.points) && v.points.length > MAX_ELEMENT_POINTS) {
    throw new LiveBlockInputError(
      `Element ${v.id} has more than ${MAX_ELEMENT_POINTS} points`,
    );
  }
  return v as WhiteboardElement;
}

function checkFiles(v: unknown): Record<string, WhiteboardFileRef> {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw new LiveBlockInputError('files must be an object');
  const entries = Object.entries(v);
  if (entries.length > MAX_WHITEBOARD_FILES) {
    throw new LiveBlockInputError(
      `A whiteboard holds at most ${MAX_WHITEBOARD_FILES} files`,
    );
  }
  const out: Record<string, WhiteboardFileRef> = {};
  for (const [fileId, ref] of entries) {
    if (fileId === '__proto__') {
      throw new LiveBlockInputError('__proto__ is not a valid file id');
    }
    if (!isFileRef(ref)) {
      throw new LiveBlockInputError(
        `File ${fileId.slice(0, 64)} is not { attachmentId: <attachment uuid>, mimeType }`,
      );
    }
    out[fileId] = { attachmentId: ref.attachmentId, mimeType: ref.mimeType };
  }
  return out;
}

function assignIndexes(elements: WhiteboardElement[]): void {
  let prev: string | null = null;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (typeof el.index === 'string' && (prev === null || el.index > prev)) {
      prev = el.index;
      continue;
    }
    let next: string | null = null;
    for (let j = i + 1; j < elements.length; j++) {
      const candidate = elements[j].index;
      if (
        typeof candidate === 'string' &&
        (prev === null || candidate > prev)
      ) {
        next = candidate;
        break;
      }
    }
    try {
      el.index = generateJitteredKeyBetween(prev, next);
    } catch {
      try {
        el.index = generateJitteredKeyBetween(prev, null);
      } catch {
        throw new LiveBlockInputError(`Element ${el.id} has an invalid index`);
      }
    }
    prev = el.index;
  }
}

/** Untrusted input to a whiteboard snapshot. Throws LiveBlockInputError. */
export function validateScene(input: unknown): WhiteboardSnapshot {
  if (!isObject(input) || !Array.isArray(input.elements)) {
    throw new LiveBlockInputError('A whiteboard needs { elements, files? }');
  }
  if (input.elements.length > MAX_WHITEBOARD_ELEMENTS) {
    throw new LiveBlockInputError(
      `A whiteboard holds at most ${MAX_WHITEBOARD_ELEMENTS} elements`,
    );
  }
  const seen = new Set<string>();
  const elements = input.elements
    .map(checkElement)
    .map((el) => {
      if (seen.has(el.id)) {
        throw new LiveBlockInputError(
          `Duplicate element id: ${el.id.slice(0, 64)}`,
        );
      }
      seen.add(el.id);
      return el;
    })
    .filter((el) => el.isDeleted !== true)
    .map((el) => {
      const copy: WhiteboardElement = JSON.parse(JSON.stringify(el));
      // the app keeps nothing there; Excalidraw would act on some of it
      delete copy.customData;
      // only the canonical form of an embed: nothing else of the typed link survives
      if (copy.type === 'embeddable') copy.link = canonicalEmbedLink(copy.link);
      // a missing, NaN or absurd version would make the element uneditable
      if (readVersion(copy.version) !== copy.version || copy.version === 0) {
        copy.version = 1;
      }
      copy.versionNonce = saneNonce(copy.versionNonce);
      return copy;
    });
  assignIndexes(elements);
  return { kind: 'whiteboard', elements, files: checkFiles(input.files) };
}
