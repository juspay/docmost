import {
  sheet,
  emptySnapshot,
  isRegisteredKind,
  LiveBlockInputError,
  validateSnapshotInput,
  cleanElements as packageCleanElements,
  MAX_WHITEBOARD_FILES,
  type LiveBlockSnapshot,
} from '@docmost/live-blocks';
import type { Fingerprint } from '../runner';

export type BlockKind = 'whiteboard' | 'todo' | 'sheet';

export type SceneResult = {
  snapshot: LiveBlockSnapshot;
  /** Inline whiteboard images by Excalidraw file id, still to be stored. */
  files?: Record<string, { dataURL: string; mimeType: string }>;
  /**
   * A sheet's whole workbook. The block is seeded from this, never from the
   * snapshot, which keeps only what fits its display cap (truncated).
   */
  book?: sheet.SheetBook;
  /** whiteboard elements left out, by reason (iframe, unsafe-embed, duplicate-id, …) */
  removed?: Record<string, number>;
  /** whiteboard elements kept with an unsafe part removed, by reason */
  altered?: Record<string, number>;
  /** images past the cap a board holds, in document order: not stored */
  overCap?: string[];
  warnings: string[];
};

/** A scene that would not reach docmost intact. The message is the reason. */
export class SceneInvalidError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The column is jsonb: an object, or a string for old rows. */
function parse(scene: unknown): unknown {
  if (typeof scene !== 'string') return scene;
  if (scene.trim() === '') return null;
  try {
    return JSON.parse(scene);
  } catch (err) {
    throw new SceneInvalidError(
      `the scene is not valid JSON (${(err as Error).message})`,
    );
  }
}

/** A short report key for one of the package's cleaning reasons. */
function reasonKey(reason: string): {
  kind: 'removed' | 'altered';
  key: string;
} {
  if (reason.startsWith('dropped: repeated element id'))
    return { kind: 'removed', key: 'duplicate-id' };
  const type = /^dropped: element type (.+) is not allowed$/.exec(reason);
  if (type) return { kind: 'removed', key: type[1] };
  if (reason.startsWith('dropped:'))
    return { kind: 'removed', key: 'not-an-element' };
  if (reason.startsWith('embed replaced'))
    return { kind: 'altered', key: 'unsafe-embed' };
  if (reason.startsWith('link removed'))
    return { kind: 'altered', key: 'unsafe-link' };
  if (reason.startsWith('binding to a removed element'))
    return { kind: 'altered', key: 'binding-cleared' };
  if (reason.startsWith('container was removed'))
    return { kind: 'altered', key: 'container-cleared' };
  if (reason.startsWith('frame was removed'))
    return { kind: 'altered', key: 'frame-cleared' };
  return { kind: 'altered', key: 'other' };
}

/**
 * The live elements a board may hold, cleaned by the package's own
 * cleanElements (never throws): disallowed or unknown types and repeated ids
 * are left out, unsafe links removed, foreign embeds made plain rectangles.
 * Mindspace boards were never checked, so cleaning replaces refusing; every
 * change is counted for the report.
 */
export function cleanElements(scene: Record<string, unknown>): {
  elements: Record<string, unknown>[];
  removed: Record<string, number>;
  altered: Record<string, number>;
} {
  // tombstones first: the package keeps them, and validation refuses some
  const cleaned = packageCleanElements(liveElements(scene));
  const removed: Record<string, number> = {};
  const altered: Record<string, number> = {};
  // the package also reports the references it cleared to removed elements
  const changes = [
    ...cleaned.removed,
    ...((cleaned as { altered?: { reason: string }[] }).altered ?? []),
  ];
  for (const r of changes) {
    const { kind, key } = reasonKey(r.reason);
    const m = kind === 'removed' ? removed : altered;
    m[key] = (m[key] ?? 0) + 1;
  }
  return {
    elements: cleaned.elements as unknown as Record<string, unknown>[],
    removed,
    altered,
  };
}

function liveElements(
  scene: Record<string, unknown>,
): Record<string, unknown>[] {
  const elements = Array.isArray(scene.elements) ? scene.elements : [];
  return elements.filter(
    (e): e is Record<string, unknown> => isObject(e) && e.isDeleted !== true,
  );
}

/** Files of the scene that a live image element points at. */
function usedFiles(scene: Record<string, unknown>) {
  // in document order: the first MAX_WHITEBOARD_FILES images a board holds
  const used = new Set(
    liveElements(scene)
      .filter((e) => e.type === 'image' && typeof e.fileId === 'string')
      .map((e) => e.fileId as string),
  );
  const all = isObject(scene.files) ? scene.files : {};
  const files: Record<string, { dataURL: string; mimeType: string }> = {};
  const unused: string[] = [];
  const overCap: string[] = [];
  const order = [...used].filter((id) =>
    Object.prototype.hasOwnProperty.call(all, id),
  );
  for (const id of Object.keys(all)) if (!used.has(id)) unused.push(id);
  for (const fileId of order) {
    const file = all[fileId];
    if (Object.keys(files).length >= MAX_WHITEBOARD_FILES) {
      overCap.push(fileId);
      continue;
    }
    if (isObject(file) && typeof file.dataURL === 'string') {
      files[fileId] = {
        dataURL: file.dataURL,
        mimeType: typeof file.mimeType === 'string' ? file.mimeType : '',
      };
    }
  }
  return { files, unused, overCap };
}

export function sceneToSnapshot(kind: BlockKind, scene: unknown): SceneResult {
  const parsed = parse(scene);
  if (parsed === null || parsed === undefined) {
    return { snapshot: emptySnapshot(kind), files: {}, warnings: [] };
  }
  if (!isRegisteredKind(kind)) {
    throw new SceneInvalidError(
      `${kind} blocks are not available in this build`,
    );
  }
  try {
    if (kind === 'whiteboard') {
      if (!isObject(parsed))
        throw new LiveBlockInputError(
          'A whiteboard needs { elements, files? }',
        );
      const { elements, removed, altered } = cleanElements(parsed);
      const { files, unused, overCap } = usedFiles({ ...parsed, elements });
      // appState is dropped; files are filled in with attachment uuids once
      // stored, after validation, so mindspace's own file ids never reach it
      const snapshot = validateSnapshotInput('whiteboard', {
        elements,
        files: {},
      });
      return {
        snapshot,
        files,
        removed,
        altered,
        overCap,
        warnings: unused.map(
          (id) => `file ${id} is not used by any element and was dropped`,
        ),
      };
    }
    if (kind === 'sheet') {
      // the book itself, whether stored bare or as { book }; the snapshot and
      // the seeded document both come from this one value
      const raw = isObject(parsed) && 'book' in parsed ? parsed.book : parsed;
      // validation refuses a malformed book instead of cutting it down
      const snapshot = validateSnapshotInput('sheet', raw);
      return {
        snapshot,
        book: sheet.parseBook(JSON.stringify(raw)),
        warnings: [],
      };
    }
    return { snapshot: validateSnapshotInput(kind, parsed), warnings: [] };
  } catch (err) {
    if (err instanceof LiveBlockInputError)
      throw new SceneInvalidError(err.message);
    throw err;
  }
}

function countNodes(nodes: unknown): number {
  if (!Array.isArray(nodes)) return 0;
  return nodes
    .filter(isObject)
    .reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

/** What the source holds, counted from the raw scene, for verify to compare. */
export function sourceFingerprint(
  kind: BlockKind,
  scene: unknown,
): Fingerprint {
  let parsed: unknown;
  try {
    parsed = parse(scene);
  } catch (err) {
    return { kind: 'invalid', reason: (err as Error).message };
  }
  const raw = isObject(parsed) ? parsed : {};
  if (kind === 'whiteboard') {
    return {
      kind,
      // what the cleaned board can hold: removed unsafe elements are explained
      elements: cleanElements(raw).elements.length,
      images: Object.keys(
        usedFiles({ ...raw, elements: cleanElements(raw).elements }).files,
      ).length,
    };
  }
  if (kind === 'todo') {
    const board = isObject(raw.board) ? raw.board : raw;
    const columns = Array.isArray(board.columns)
      ? board.columns.filter(isObject)
      : [];
    return {
      kind,
      cards: columns.length,
      items: columns.reduce((n, c) => n + countNodes(c.nodes), 0),
    };
  }
  const book = isObject(raw.book) ? raw.book : raw;
  const sheets = Array.isArray(book.sheets) ? book.sheets.filter(isObject) : [];
  return {
    kind: 'sheet',
    tabs: sheets.length,
    cells: sheets.reduce((n, t) => n + filledCells(t.cells), 0),
  };
}

/** Cells with a value; a cell that only carries a format is not counted. */
function filledCells(cells: unknown): number {
  if (!isObject(cells)) return 0;
  return Object.values(cells).filter(
    (c) => isObject(c) && typeof c.v === 'string' && c.v !== '',
  ).length;
}

/** The counts of a workbook (a sheet block's whole document, read back). */
export function bookFingerprint(book: sheet.SheetBook): Fingerprint {
  return {
    kind: 'sheet',
    tabs: book.sheets.length,
    cells: book.sheets.reduce((n, t) => n + filledCells(t.cells), 0),
  };
}

/** The same counts, from a snapshot stored in docmost. */
export function snapshotFingerprint(
  snapshot: LiveBlockSnapshot | null,
): Fingerprint {
  if (!snapshot)
    return { kind: 'invalid', reason: 'the block has no snapshot' };
  if (snapshot.kind === 'whiteboard') {
    return {
      kind: 'whiteboard',
      elements: (snapshot.elements ?? []).length,
      images: Object.keys(snapshot.files ?? {}).length,
    };
  }
  if (snapshot.kind === 'todo') {
    const columns = snapshot.board?.columns ?? [];
    return {
      kind: 'todo',
      cards: columns.length,
      items: columns.reduce((n, c) => n + countNodes(c.nodes), 0),
    };
  }
  if (snapshot.kind === 'sheet') return bookFingerprint(snapshot.book);
  return {
    kind: 'invalid',
    reason: `${(snapshot as { kind: string }).kind} fingerprints are not available in this build`,
  };
}

export const BLOCK_NODE_TYPE: Record<BlockKind, string> = {
  whiteboard: 'whiteboard',
  todo: 'todoBoard',
  sheet: 'sheet',
};

export const EMPTY_PAGE_CONTENT = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

/** A page body holding exactly one live block. */
export function blockPageContent(
  kind: BlockKind,
  blockId: string,
  title: string,
) {
  return {
    type: 'doc',
    content: [{ type: BLOCK_NODE_TYPE[kind], attrs: { blockId, title } }],
  };
}
