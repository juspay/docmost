import { sheet as S } from "@docmost/live-blocks";

/** The ported fill handle: series, repeats and shifted formulas. */
export function applyFill(
  draft: S.Sheet,
  source: S.MergeRange,
  target: S.MergeRange,
): void {
  S.fillRange(draft, source, target);
}

export function mergeRange(draft: S.Sheet, r: S.MergeRange): void {
  S.mergeCells(draft, r.r1, r.c1, r.r2, r.c2);
}

export function unmergeRange(draft: S.Sheet, r: S.MergeRange): void {
  S.unmergeRange(draft, r.r1, r.c1, r.r2, r.c2);
}

/** Freezes the rows and columns before these counts; 0 unfreezes. */
export function freezeTo(draft: S.Sheet, rows: number, cols: number): void {
  draft.frozenRows = Math.min(Math.max(0, rows), draft.rows - 1);
  draft.frozenCols = Math.min(Math.max(0, cols), draft.cols - 1);
}

type SortKey = { num: number | null; text: string; blank: boolean };

function keyOf(value: S.CellValue): SortKey {
  if (typeof value === "number") return { num: value, text: "", blank: false };
  const text = value instanceof S.FormulaError ? value.code : String(value);
  return { num: null, text: text.toLowerCase(), blank: text === "" };
}

/**
 * Sorts the rows of `range` by the values in column `col`, whole rows moving
 * together, as mindspace's sort does. A moved formula's relative references
 * shift with its row, as in a copy, so `=B3*2` keeps reading its own row.
 * Numbers sort before text; blanks go last either way. Cells outside the
 * range are not touched. A range crossing a merge is left alone.
 */
export function applySort(
  draft: S.Sheet,
  range: S.MergeRange,
  col: number,
  ascending: boolean,
  valueAt?: (row: number, col: number) => S.CellValue,
): boolean {
  const crossesMerge = draft.merges.some(
    (m) =>
      m.r1 <= range.r2 &&
      m.r2 >= range.r1 &&
      m.c1 <= range.c2 &&
      m.c2 >= range.c1,
  );
  if (crossesMerge || col < range.c1 || col > range.c2) return false;
  const engine = valueAt
    ? null
    : new S.Engine({ version: 1, sheets: [draft], activeSheetId: draft.id });
  const value =
    valueAt ?? ((r: number, c: number) => engine.getValue(draft.id, r, c));

  type Line = { key: SortKey; from: number; cells: (S.Cell | null)[] };
  const lines: Line[] = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const cells: (S.Cell | null)[] = [];
    for (let c = range.c1; c <= range.c2; c++) {
      const cell = S.getCell(draft, r, c);
      cells.push(cell ? structuredClone(cell) : null);
    }
    lines.push({ key: keyOf(value(r, col)), from: r, cells });
  }
  lines.sort((a, b) => {
    if (a.key.blank !== b.key.blank) return a.key.blank ? 1 : -1;
    let cmp: number;
    if (a.key.num !== null && b.key.num !== null) cmp = a.key.num - b.key.num;
    else if (a.key.num !== null) cmp = -1;
    else if (b.key.num !== null) cmp = 1;
    else cmp = a.key.text < b.key.text ? -1 : a.key.text > b.key.text ? 1 : 0;
    return ascending ? cmp : -cmp;
  });
  lines.forEach((line, i) => {
    line.cells.forEach((cell, j) => {
      const row = range.r1 + i;
      const key = S.cellKey(row, range.c1 + j);
      if (cell?.v.startsWith("=")) {
        cell.v = S.translateFormula(cell.v, row - line.from, 0);
      }
      if (cell) draft.cells[key] = cell;
      else delete draft.cells[key];
    });
  });
  return true;
}

/** The range the sort works on: the selection, or every used cell when one cell is selected. */
export function sortRange(sheet: S.Sheet, range: S.MergeRange): S.MergeRange {
  if (range.r1 !== range.r2 || range.c1 !== range.c2) return range;
  let r2 = 0;
  let c2 = 0;
  for (const key of Object.keys(sheet.cells)) {
    const pos = S.parseKey(key);
    if (!pos) continue;
    r2 = Math.max(r2, pos.row);
    c2 = Math.max(c2, pos.col);
  }
  return { r1: 0, c1: 0, r2, c2 };
}
