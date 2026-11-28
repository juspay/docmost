import { sheet as S } from "@docmost/live-blocks";

export type Range = S.MergeRange;
export type FlagKey = "bold" | "italic" | "underline" | "strike" | "wrap";
export type BorderPreset =
  | "all"
  | "outer"
  | "inner"
  | "innerH"
  | "innerV"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "none";

/**
 * The largest selection formatted in full, empty cells included (a value
 * typed there later has the format, and outer borders are whole). A larger
 * selection is cut to the box of cells in use; if that box is still larger,
 * only the stored cells are formatted. The toolbar tells the user when a
 * selection was cut (formatIsCut).
 */
export const MAX_FORMAT_BOX = 200_000;

/** Stored cells a tab may reach through formatting (the server's MAX_BOOK_CELLS). */
export const MAX_TAB_CELLS = 1_000_000;

/** A format here would take the tab past MAX_TAB_CELLS stored cells. */
export function formatWouldOverflow(sheet: S.Sheet, range: Range): boolean {
  const stored = Object.keys(sheet.cells).length;
  let added = 0;
  for (const { row, col } of formatTargets(sheet, range)) {
    if (!sheet.cells[`${row}:${col}`]) added++;
  }
  return stored + added > MAX_TAB_CELLS;
}

const areaOf = (r: Range) => (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1);

/** The box a format applies to: the selection, or its used part past the cap. */
export function formatRange(sheet: S.Sheet, range: Range): Range {
  if (areaOf(range) <= MAX_FORMAT_BOX) return range;
  let lastRow = range.r1;
  let lastCol = range.c1;
  for (const key of Object.keys(sheet.cells)) {
    const pos = S.parseKey(key);
    if (!pos) continue;
    if (pos.row > lastRow) lastRow = pos.row;
    if (pos.col > lastCol) lastCol = pos.col;
  }
  return {
    r1: range.r1,
    c1: range.c1,
    r2: Math.min(range.r2, lastRow),
    c2: Math.min(range.c2, lastCol),
  };
}

/** A format on this selection does not reach every one of its cells. */
export function formatIsCut(range: Range): boolean {
  return areaOf(range) > MAX_FORMAT_BOX;
}

/**
 * The positions merges cover (not their anchors), built once per action:
 * looking each position up is then O(1) instead of a scan of every merge.
 * Only merges that meet `box` count, so the set is at most the box's size.
 */
function coveredIn(sheet: S.Sheet, box: Range): Set<number> {
  const covered = new Set<number>();
  for (const m of sheet.merges) {
    if (m.r2 < box.r1 || m.r1 > box.r2 || m.c2 < box.c1 || m.c1 > box.c2)
      continue;
    for (
      let row = Math.max(m.r1, box.r1);
      row <= Math.min(m.r2, box.r2);
      row++
    ) {
      for (
        let col = Math.max(m.c1, box.c1);
        col <= Math.min(m.c2, box.c2);
        col++
      ) {
        if (row !== m.r1 || col !== m.c1) covered.add(row * S.MAX_COLS + col);
      }
    }
  }
  return covered;
}

/** The cells a format applies to: merge anchors stand for their merge. */
export function formatTargets(
  sheet: S.Sheet,
  whole: Range,
): { row: number; col: number }[] {
  const range = formatRange(sheet, whole);
  const { r2, c2 } = range;
  const covered = coveredIn(sheet, range);
  const isCovered = (row: number, col: number) =>
    covered.has(row * S.MAX_COLS + col);
  if (areaOf(range) > MAX_FORMAT_BOX) {
    const out: { row: number; col: number }[] = [];
    for (const key of Object.keys(sheet.cells)) {
      const pos = S.parseKey(key);
      if (!pos) continue;
      if (
        pos.row < range.r1 ||
        pos.row > r2 ||
        pos.col < range.c1 ||
        pos.col > c2
      )
        continue;
      if (!isCovered(pos.row, pos.col)) out.push(pos);
    }
    return out.sort((a, b) => a.row - b.row || a.col - b.col);
  }
  const out: { row: number; col: number }[] = [];
  for (let row = range.r1; row <= r2; row++) {
    for (let col = range.c1; col <= c2; col++) {
      if (!isCovered(row, col)) out.push({ row, col });
    }
  }
  return out;
}

export function setFormat(
  draft: S.Sheet,
  range: Range,
  patch: Partial<S.CellFormat>,
): void {
  for (const { row, col } of formatTargets(draft, range)) {
    S.updateCellFormat(draft, row, col, patch);
  }
}

/** Every target already has the flag. */
export function allHave(sheet: S.Sheet, range: Range, key: FlagKey): boolean {
  return formatTargets(sheet, range).every(
    ({ row, col }) => S.getCell(sheet, row, col)?.f?.[key] === true,
  );
}

/** On when any selected cell lacks it, off when all have it. */
export function toggleFlag(draft: S.Sheet, range: Range, key: FlagKey): void {
  setFormat(draft, range, { [key]: !allHave(draft, range, key) });
}

export function setNumberFormat(
  draft: S.Sheet,
  range: Range,
  numFmt: S.NumberFormat,
): void {
  setFormat(draft, range, { numFmt, decimals: undefined });
}

function fractionDigits(text: string): number {
  const m = /\.(\d+)/.exec(text);
  return m ? m[1].length : 0;
}

/**
 * One more or one fewer decimal on each number. A cell back at the number of
 * decimals its format shows anyway loses the override, so +1 then -1 leaves
 * the cell as it was.
 */
export function bumpDecimals(
  draft: S.Sheet,
  range: Range,
  delta: number,
  valueAt: (row: number, col: number) => S.CellValue,
): void {
  for (const { row, col } of formatTargets(draft, range)) {
    const value = valueAt(row, col);
    if (typeof value !== "number") continue;
    const f = S.getCell(draft, row, col)?.f;
    const natural = fractionDigits(
      S.formatValue(value, f?.numFmt ?? null, null),
    );
    const current = typeof f?.decimals === "number" ? f.decimals : natural;
    const next = Math.min(10, Math.max(0, current + delta));
    S.updateCellFormat(draft, row, col, {
      decimals: next === natural ? undefined : next,
    });
  }
}

export function clearFormatting(draft: S.Sheet, range: Range): void {
  for (const { row, col } of formatTargets(draft, range)) {
    const key = S.cellKey(row, col);
    const cell = draft.cells[key];
    if (!cell) continue;
    if (cell.v === "") delete draft.cells[key];
    else delete cell.f;
  }
}

function sidesFor(
  preset: BorderPreset,
  range: Range,
  row: number,
  col: number,
): (keyof S.Borders)[] {
  const top = row === range.r1;
  const bottom = row === range.r2;
  const left = col === range.c1;
  const right = col === range.c2;
  const pick: [boolean, keyof S.Borders][] = {
    all: [
      [true, "top"],
      [true, "right"],
      [true, "bottom"],
      [true, "left"],
    ],
    outer: [
      [top, "top"],
      [right, "right"],
      [bottom, "bottom"],
      [left, "left"],
    ],
    inner: [
      [!right, "right"],
      [!bottom, "bottom"],
    ],
    innerH: [[!bottom, "bottom"]],
    innerV: [[!right, "right"]],
    top: [[top, "top"]],
    bottom: [[bottom, "bottom"]],
    left: [[left, "left"]],
    right: [[right, "right"]],
    none: [],
  }[preset] as [boolean, keyof S.Borders][];
  return pick.filter(([on]) => on).map(([, side]) => side);
}

export function applyBorders(
  draft: S.Sheet,
  range: Range,
  preset: BorderPreset,
  border: S.Border,
): void {
  // the outline follows the formatted box, so its edges are whole
  const box = formatRange(draft, range);
  for (const { row, col } of formatTargets(draft, range)) {
    const existing = S.getCell(draft, row, col)?.f?.borders;
    if (preset === "none") {
      if (existing) S.updateCellFormat(draft, row, col, { borders: {} });
      continue;
    }
    const sides = sidesFor(preset, box, row, col);
    if (sides.length === 0) continue;
    const next: S.Borders = { ...(existing ?? {}) };
    for (const side of sides) next[side] = { ...border };
    S.updateCellFormat(draft, row, col, { borders: next });
  }
}

/** The format the toolbar shows: the active cell's. */
export function activeFormat(
  sheet: S.Sheet,
  row: number,
  col: number,
): S.CellFormat {
  return S.getCell(sheet, row, col)?.f ?? {};
}
