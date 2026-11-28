import * as Y from 'yjs';
import type { LiveBlockKind } from './kinds';
import { kindDefinition } from './registry';
import type { WhiteboardElement } from './whiteboard/reconcile';
import type { WhiteboardFileRef } from './whiteboard/ydoc';
import type { TodoBoard } from './todo/board';
import type { SheetBook } from './sheet/model';

export type WhiteboardSnapshot = {
  kind: 'whiteboard';
  /** No tombstones. */
  elements: WhiteboardElement[];
  files: Record<string, WhiteboardFileRef>;
};

export type TodoSnapshot = { kind: 'todo'; board: TodoBoard };
export type SheetSnapshot = {
  kind: 'sheet';
  book: SheetBook;
  /** tab id → "row:col" → the text the grid shows */
  display: Record<string, Record<string, string>>;
  /** true when display stops at the cap or the time budget */
  truncated: boolean;
};

export const SNAPSHOT_DISPLAY_CELLS = 50000;
export const SNAPSHOT_BUDGET_MS = 2000;
/**
 * The budget when the sync server stores a document: it builds the snapshot
 * on its own event loop, so a slow sheet must not hold up everyone else.
 * A sheet past it is stored truncated. The API server's readers (fresh reads,
 * the snapshot route and export) rebuild such a snapshot from the stored
 * document with SNAPSHOT_BUDGET_MS and save the result.
 */
export const STORE_SNAPSHOT_BUDGET_MS = 250;

export type BuildOptions = { budgetMs?: number };

// Each kind's task widens this union with its own snapshot type.
export type LiveBlockSnapshot =
  | WhiteboardSnapshot
  | TodoSnapshot
  | SheetSnapshot
  | { kind: Exclude<LiveBlockKind, 'whiteboard' | 'todo' | 'sheet'> };

/** An error whose message is safe to show to the caller. */
export class LiveBlockInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveBlockInputError';
  }
}

export type StaticRenderContext = {
  title: string;
  previewSrc?: string;
  openUrl?: string;
};

export function buildSnapshot(
  kind: LiveBlockKind,
  doc: Y.Doc,
  options?: BuildOptions,
): LiveBlockSnapshot {
  return kindDefinition(kind).build(doc, options);
}

export function emptySnapshot(kind: LiveBlockKind): LiveBlockSnapshot {
  return kindDefinition(kind).empty();
}

export function seedYdoc(snapshot: LiveBlockSnapshot): Y.Doc {
  const doc = new Y.Doc();
  kindDefinition(snapshot.kind).seed(doc, snapshot);
  return doc;
}

export function validateSnapshotInput(
  kind: LiveBlockKind,
  input: unknown,
): LiveBlockSnapshot {
  return kindDefinition(kind).validate(input);
}
