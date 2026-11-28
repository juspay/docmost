import {
  LiveBlockSnapshot,
  MAX_CELLS_PER_OP,
  sheet,
  SheetSnapshot,
} from '@docmost/live-blocks';

export const MAX_CELLS_PER_CALL = MAX_CELLS_PER_OP;

const TRUNCATED_NOTE =
  'The sheet is too large to compute every display value; cells past the limit are left out or have display null.';

function filledCells(tab: sheet.Sheet, display: Record<string, string>) {
  return Object.entries(tab.cells)
    .map(([key, cell]) => ({ key, pos: sheet.parseKey(key), input: cell.v }))
    .filter((c) => c.pos && c.input !== '')
    .sort((a, b) => a.pos.row - b.pos.row || a.pos.col - b.pos.col)
    .map((c) => ({
      a1: sheet.toA1(c.pos.row, c.pos.col),
      input: c.input,
      display: display[c.key] ?? null,
    }));
}

export function sheetOutput(snapshot: LiveBlockSnapshot) {
  if (snapshot.kind !== 'sheet') {
    throw new Error(`Expected a sheet snapshot, got ${snapshot.kind}`);
  }
  const { book, display, truncated }: SheetSnapshot = snapshot;
  return {
    sheets: book.sheets.map((tab) => ({
      sheet_id: tab.id,
      name: tab.name,
      rows: tab.rows,
      cols: tab.cols,
      cells: filledCells(tab, display[tab.id] ?? {}),
    })),
    truncated,
    ...(truncated ? { note: TRUNCATED_NOTE } : {}),
  };
}
