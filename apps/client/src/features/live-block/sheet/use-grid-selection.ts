import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sheet as S } from "@docmost/live-blocks";

export type CellPos = { row: number; col: number };
export type GridSelection = { anchor: CellPos; focus: CellPos };

function clampPos(sheet: S.Sheet, pos: CellPos): CellPos {
  return {
    row: Math.min(sheet.rows - 1, Math.max(0, pos.row)),
    col: Math.min(sheet.cols - 1, Math.max(0, pos.col)),
  };
}

/** A position inside a merge stands for the merge's top-left cell. */
export function snapToMerge(sheet: S.Sheet, pos: CellPos): CellPos {
  const m = S.findMerge(sheet, pos.row, pos.col);
  return m ? { row: m.r1, col: m.c1 } : pos;
}

/** One step from `pos`; a merge is crossed whole. */
export function stepFrom(
  sheet: S.Sheet,
  pos: CellPos,
  dRow: number,
  dCol: number,
): CellPos {
  const m = S.findMerge(sheet, pos.row, pos.col);
  let row = pos.row + dRow;
  let col = pos.col + dCol;
  if (m) {
    if (dRow > 0) row = m.r2 + dRow;
    else if (dRow < 0) row = m.r1 + dRow;
    if (dCol > 0) col = m.c2 + dCol;
    else if (dCol < 0) col = m.c1 + dCol;
  }
  return clampPos(sheet, { row, col });
}

/** Ctrl+arrow: to the edge of the current block of data, or the next one. */
export function dataEdge(
  sheet: S.Sheet,
  pos: CellPos,
  dRow: number,
  dCol: number,
): CellPos {
  const inside = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < sheet.rows && c < sheet.cols;
  const filled = (r: number, c: number) => S.getRaw(sheet, r, c).trim() !== "";
  let { row, col } = pos;
  if (!inside(row + dRow, col + dCol)) return pos;
  if (filled(row, col) && filled(row + dRow, col + dCol)) {
    while (inside(row + dRow, col + dCol) && filled(row + dRow, col + dCol)) {
      row += dRow;
      col += dCol;
    }
  } else {
    row += dRow;
    col += dCol;
    while (inside(row + dRow, col + dCol) && !filled(row, col)) {
      row += dRow;
      col += dCol;
    }
  }
  return { row, col };
}

/** The selected rectangle, grown until no merge sticks out of it. */
export function selectionRange(
  sheet: S.Sheet,
  sel: GridSelection,
): S.MergeRange {
  const range = {
    r1: Math.min(sel.anchor.row, sel.focus.row),
    c1: Math.min(sel.anchor.col, sel.focus.col),
    r2: Math.max(sel.anchor.row, sel.focus.row),
    c2: Math.max(sel.anchor.col, sel.focus.col),
  };
  for (let grown = true; grown; ) {
    grown = false;
    for (const m of sheet.merges) {
      const overlaps =
        m.r1 <= range.r2 &&
        m.r2 >= range.r1 &&
        m.c1 <= range.c2 &&
        m.c2 >= range.c1;
      if (!overlaps) continue;
      if (
        m.r1 < range.r1 ||
        m.c1 < range.c1 ||
        m.r2 > range.r2 ||
        m.c2 > range.c2
      ) {
        range.r1 = Math.min(range.r1, m.r1);
        range.c1 = Math.min(range.c1, m.c1);
        range.r2 = Math.max(range.r2, m.r2);
        range.c2 = Math.max(range.c2, m.c2);
        grown = true;
      }
    }
  }
  return range;
}

const START: GridSelection = {
  anchor: { row: 0, col: 0 },
  focus: { row: 0, col: 0 },
};

/**
 * Selection as in Google Sheets: the anchor is the active cell, Shift moves
 * the focus. Positions always stay inside the tab.
 */
export function useGridSelection(sheet: S.Sheet) {
  const [selection, setSelectionState] = useState<GridSelection>(START);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;

  useEffect(() => {
    setSelectionState((sel) => {
      const anchor = clampPos(sheet, sel.anchor);
      const focus = clampPos(sheet, sel.focus);
      if (
        anchor.row === sel.anchor.row &&
        anchor.col === sel.anchor.col &&
        focus.row === sel.focus.row &&
        focus.col === sel.focus.col
      ) {
        return sel;
      }
      return { anchor, focus };
    });
  }, [sheet, sheet.rows, sheet.cols]);

  const place = useCallback((pos: CellPos, extend: boolean) => {
    const s = sheetRef.current;
    setSelectionState((sel) => {
      if (extend) return { anchor: sel.anchor, focus: clampPos(s, pos) };
      const at = snapToMerge(s, clampPos(s, pos));
      return { anchor: at, focus: at };
    });
  }, []);

  const move = useCallback((dRow: number, dCol: number, extend: boolean) => {
    const s = sheetRef.current;
    setSelectionState((sel) => {
      const from = extend ? sel.focus : sel.anchor;
      const to = stepFrom(s, from, dRow, dCol);
      if (extend) return { anchor: sel.anchor, focus: to };
      const at = snapToMerge(s, to);
      return { anchor: at, focus: at };
    });
  }, []);

  const select = useCallback(
    (row: number, col: number, extend: boolean) => place({ row, col }, extend),
    [place],
  );

  const jump = useCallback((dRow: number, dCol: number, extend: boolean) => {
    const s = sheetRef.current;
    setSelectionState((sel) => {
      const to = dataEdge(s, extend ? sel.focus : sel.anchor, dRow, dCol);
      if (extend) return { anchor: sel.anchor, focus: to };
      const at = snapToMerge(s, to);
      return { anchor: at, focus: at };
    });
  }, []);

  const edge = useCallback((which: "home" | "end", extend: boolean) => {
    const s = sheetRef.current;
    setSelectionState((sel) => {
      const from = extend ? sel.focus : sel.anchor;
      const to = { row: from.row, col: which === "home" ? 0 : s.cols - 1 };
      if (extend) return { anchor: sel.anchor, focus: to };
      const at = snapToMerge(s, to);
      return { anchor: at, focus: at };
    });
  }, []);

  const setSelection = useCallback((next: GridSelection) => {
    const s = sheetRef.current;
    setSelectionState({
      anchor: clampPos(s, next.anchor),
      focus: clampPos(s, next.focus),
    });
  }, []);

  const range = useCallback(
    () => selectionRange(sheetRef.current, selection),
    [selection],
  );

  return useMemo(
    () => ({ selection, move, select, jump, edge, setSelection, range }),
    [selection, move, select, jump, edge, setSelection, range],
  );
}

export type GridSelectionApi = ReturnType<typeof useGridSelection>;
