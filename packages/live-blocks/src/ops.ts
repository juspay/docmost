import * as Y from 'yjs';
import type { LiveBlockKind } from './kinds';
import { kindDefinition } from './registry';
import { LiveBlockInputError } from './snapshot';

export type SheetSetCellsOp = {
  type: 'sheet.setCells';
  sheetId?: string;
  sheetName?: string;
  createSheet?: boolean;
  cells: { a1: string; value: string }[];
};

export type LiveBlockOp = SheetSetCellsOp | { type: string };

/** Cells in one request, across all its ops. */
export const MAX_CELLS_PER_OP = 5000;
/** Ops in one request. */
export const MAX_OPS_PER_REQUEST = 100;

/** Applies every op in one Yjs transaction. */
export function applyOps(
  kind: LiveBlockKind,
  doc: Y.Doc,
  ops: LiveBlockOp[],
  origin?: unknown,
): void {
  const def = kindDefinition(kind);
  if (!def.applyOp) {
    throw new LiveBlockInputError(
      `Live block kind "${kind}" has no operations`,
    );
  }
  if (!Array.isArray(ops)) {
    throw new LiveBlockInputError('ops must be a list');
  }
  if (ops.length > MAX_OPS_PER_REQUEST) {
    throw new LiveBlockInputError(
      `At most ${MAX_OPS_PER_REQUEST} operations per request; got ${ops.length}`,
    );
  }
  let cells = 0;
  for (const op of ops) {
    if (typeof op !== 'object' || op === null) {
      throw new LiveBlockInputError('Every operation must be an object');
    }
    const list = (op as { cells?: unknown }).cells;
    if (Array.isArray(list)) cells += list.length;
  }
  if (cells > MAX_CELLS_PER_OP) {
    throw new LiveBlockInputError(
      `At most ${MAX_CELLS_PER_OP} cells per request; got ${cells}`,
    );
  }
  // A Yjs transaction cannot be rolled back, so the ops run on a copy first:
  // a request that fails anywhere changes nothing.
  const trial = new Y.Doc();
  Y.applyUpdate(trial, Y.encodeStateAsUpdate(doc));
  trial.transact(() => {
    for (const op of ops) def.applyOp(trial, op);
  });
  trial.destroy();
  doc.transact(() => {
    for (const op of ops) def.applyOp(doc, op);
  }, origin);
}
