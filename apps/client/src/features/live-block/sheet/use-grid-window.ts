import { useMemo } from "react";
import { sheet as S } from "@docmost/live-blocks";

export type Viewport = {
  scrollTop: number;
  scrollLeft: number;
  width: number;
  height: number;
};

export type GridWindow = {
  /** inclusive range of scrolled rows drawn, after the frozen ones */
  rows: [number, number];
  cols: [number, number];
  offsetTop: number;
  offsetLeft: number;
  totalHeight: number;
  totalWidth: number;
  frozenHeight: number;
  frozenWidth: number;
  rowTop(row: number): number;
  colLeft(col: number): number;
  rowHeight(row: number): number;
  colWidth(col: number): number;
  /** the row or column under a body pixel (content coordinates) */
  rowAt(y: number): number;
  colAt(x: number): number;
};

const OVERSCAN_ROWS = 3;
const OVERSCAN_COLS = 2;

/** offsets[i] is where index i starts; offsets[count] is the total. */
function offsets(
  count: number,
  sizes: Record<string, number>,
  fallback: number,
): Float64Array {
  const out = new Float64Array(count + 1);
  for (let i = 0; i < count; i++)
    out[i + 1] = out[i] + (sizes[String(i)] ?? fallback);
  return out;
}

/** The last index whose start is at or before `pos`. */
function indexAt(starts: Float64Array, pos: number): number {
  let lo = 0;
  let hi = starts.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The frozen indexes followed by the window's range. */
export function windowIndexes(
  range: [number, number],
  frozen: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < frozen; i++) out.push(i);
  for (let i = Math.max(range[0], frozen); i <= range[1]; i++) out.push(i);
  return out;
}

/** Which rows and columns are on screen; honours sizes and frozen panes. */
export function useGridWindow(sheet: S.Sheet, viewport: Viewport): GridWindow {
  const rowStarts = useMemo(
    () => offsets(sheet.rows, sheet.rowHeights, S.DEFAULT_ROW_HEIGHT),
    [sheet.rows, sheet.rowHeights],
  );
  const colStarts = useMemo(
    () => offsets(sheet.cols, sheet.colWidths, S.DEFAULT_COL_WIDTH),
    [sheet.cols, sheet.colWidths],
  );
  const frozenRows = Math.min(sheet.frozenRows, sheet.rows);
  const frozenCols = Math.min(sheet.frozenCols, sheet.cols);

  return useMemo(() => {
    const frozenHeight = rowStarts[frozenRows];
    const frozenWidth = colStarts[frozenCols];
    const span = (
      starts: Float64Array,
      count: number,
      frozen: number,
      scroll: number,
      size: number,
      frozenSize: number,
      overscan: number,
    ): [number, number] => {
      const first = indexAt(starts, scroll + frozenSize);
      const last = indexAt(starts, scroll + Math.max(size, frozenSize + 1));
      return [
        Math.min(count - 1, Math.max(frozen, first - overscan)),
        Math.min(count - 1, Math.max(frozen, last + overscan)),
      ];
    };
    const rows = span(
      rowStarts,
      sheet.rows,
      frozenRows,
      viewport.scrollTop,
      viewport.height,
      frozenHeight,
      OVERSCAN_ROWS,
    );
    const cols = span(
      colStarts,
      sheet.cols,
      frozenCols,
      viewport.scrollLeft,
      viewport.width,
      frozenWidth,
      OVERSCAN_COLS,
    );
    return {
      rows,
      cols,
      offsetTop: rowStarts[rows[0]],
      offsetLeft: colStarts[cols[0]],
      totalHeight: rowStarts[sheet.rows],
      totalWidth: colStarts[sheet.cols],
      frozenHeight,
      frozenWidth,
      rowTop: (r) => rowStarts[Math.min(Math.max(0, r), sheet.rows)],
      colLeft: (c) => colStarts[Math.min(Math.max(0, c), sheet.cols)],
      rowHeight: (r) => rowStarts[r + 1] - rowStarts[r],
      colWidth: (c) => colStarts[c + 1] - colStarts[c],
      rowAt: (y) => indexAt(rowStarts, y),
      colAt: (x) => indexAt(colStarts, x),
    };
  }, [
    rowStarts,
    colStarts,
    sheet.rows,
    sheet.cols,
    frozenRows,
    frozenCols,
    viewport.scrollTop,
    viewport.scrollLeft,
    viewport.width,
    viewport.height,
  ]);
}
