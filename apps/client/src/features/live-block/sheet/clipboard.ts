import { sheet as S } from "@docmost/live-blocks";
import type { CellPos } from "./use-grid-selection";

// marks HTML this grid wrote, so a paste can shift the formulas it carries
const MARK = "data-docmost-sheet";

function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let atFieldStart = true;
  while (i < text.length) {
    const ch = text[i];
    if (atFieldStart && ch === '"') {
      // a quoted field (Excel and Sheets quote fields holding tabs, newlines or quotes)
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= text.length) break;
        if (text[j] === '"' && text[j + 1] === '"') {
          value += '"';
          j += 2;
        } else if (text[j] === '"') {
          j++;
          break;
        } else {
          value += text[j++];
        }
      }
      if (
        j >= text.length ||
        text[j] === "\t" ||
        text[j] === "\n" ||
        text[j] === "\r"
      ) {
        field = value;
        i = j;
        atFieldStart = false;
        continue;
      }
      // a stray quote inside a plain field: read it as written
    }
    if (ch === "\t") {
      row.push(field);
      field = "";
      atFieldStart = true;
      i++;
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      atFieldStart = false;
      i++;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function tableOf(html: string): HTMLTableElement | null {
  if (!html.includes("<table") || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector("table");
}

function cellText(td: Element): string {
  const copy = td.cloneNode(true) as Element;
  copy.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return (copy.textContent ?? "").replace(/ /g, " ");
}

/** A pasted table that would expand past MAX_PASTE_CELLS. */
export class PasteTooLarge extends Error {}

/**
 * An HTML table when present (Google Sheets, Excel), else tab-separated
 * text. Throws PasteTooLarge for a table past MAX_PASTE_CELLS cells.
 */
export function parseClipboard(text: string, html?: string): string[][] {
  const table = html ? tableOf(html) : null;
  if (table) {
    // merged cells come as colspan and rowspan: their text goes to the
    // top-left, the cells they cover stay empty
    // spans are bounded by a budget of cells, so a table of huge rowspans and
    // colspans cannot make this loop for millions of positions
    let budget = MAX_PASTE_CELLS;
    const rows: string[][] = [];
    const span = (v: string | null, max: number) =>
      Math.min(max, Math.max(1, Math.floor(Number(v ?? 1)) || 1));
    Array.from(table.querySelectorAll("tr")).forEach((tr, r) => {
      rows[r] ??= [];
      let c = 0;
      for (const td of Array.from(tr.querySelectorAll("td, th"))) {
        while (rows[r][c] !== undefined) c++;
        const across = span(td.getAttribute("colspan"), S.MAX_COLS - c);
        const down = span(td.getAttribute("rowspan"), S.MAX_ROWS - r);
        budget -= across * down;
        // cutting a span would move every cell after it: refuse the paste
        if (budget < 0) throw new PasteTooLarge();
        for (let dr = 0; dr < down; dr++) {
          rows[r + dr] ??= [];
          for (let dc = 0; dc < across; dc++) rows[r + dr][c + dc] = "";
        }
        rows[r][c] = cellText(td);
        c += across;
      }
    });
    if (rows.length > 0) {
      return rows.map((row) => Array.from(row, (v) => v ?? ""));
    }
  }
  return parseTsv(text ?? "");
}

function tsvField(v: string): string {
  return /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** What a copy puts on the clipboard: displayed values, plus raw input in the HTML. */
/** The part of a range that holds cells: a whole-sheet selection copies or clears only that. */
export function usedRange(sheet: S.Sheet, range: S.MergeRange): S.MergeRange {
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

/** Cells a pasted HTML table may expand to (5,000 rows of 100 columns). */
export const MAX_PASTE_CELLS = 500_000;

/** Clipboard text larger than this is refused before it is parsed. */
export const MAX_PASTE_CHARS = 8_000_000;

export function serializeRange(
  book: S.SheetBook,
  sheetId: string,
  whole: S.MergeRange,
): { text: string; html: string } {
  const sheet = book.sheets.find((s) => s.id === sheetId);
  if (!sheet) return { text: "", html: "" };
  const range = usedRange(sheet, whole);
  const engine = new S.Engine(book);
  const lines: string[] = [];
  const rows: string[] = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const shown: string[] = [];
    const tds: string[] = [];
    for (let c = range.c1; c <= range.c2; c++) {
      const raw = S.getRaw(sheet, r, c);
      let text = "";
      try {
        text = raw === "" ? "" : engine.display(sheetId, r, c);
      } catch {
        text = S.ERR_PARSE;
      }
      shown.push(tsvField(text));
      tds.push(`<td data-raw="${escapeHtml(raw)}">${escapeHtml(text)}</td>`);
    }
    lines.push(shown.join("\t"));
    rows.push(`<tr>${tds.join("")}</tr>`);
  }
  const html =
    `<table ${MARK}="1" data-origin="${range.r1}:${range.c1}"><tbody>` +
    rows.join("") +
    "</tbody></table>";
  return { text: lines.join("\n"), html };
}

/**
 * The values a paste writes from `at`. A range copied from a sheet here keeps
 * its formulas, shifted to the new place; anything else is pasted as shown.
 */
export function pasteGrid(
  text: string,
  html: string | undefined,
  at: CellPos,
): string[][] {
  const table = html ? tableOf(html) : null;
  const origin = table?.getAttribute(MARK)
    ? table.getAttribute("data-origin")
    : null;
  const m = origin ? /^(\d+):(\d+)$/.exec(origin) : null;
  if (table && m) {
    const dRow = at.row - Number(m[1]);
    const dCol = at.col - Number(m[2]);
    return Array.from(table.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => {
        const raw = td.getAttribute("data-raw") ?? cellText(td);
        return raw.startsWith("=") ? S.translateFormula(raw, dRow, dCol) : raw;
      }),
    );
  }
  return parseClipboard(text, html);
}

/** Cuts a paste at the sheet limits; `dropped` counts the cells left out. */
export function clampPaste(
  _sheet: S.Sheet,
  at: CellPos,
  data: string[][],
): { data: string[][]; dropped: number } {
  const maxRows = Math.max(0, S.MAX_ROWS - at.row);
  const maxCols = Math.max(0, S.MAX_COLS - at.col);
  let total = 0;
  let kept = 0;
  const out = data.slice(0, maxRows).map((row) => row.slice(0, maxCols));
  for (const row of data) total += row.length;
  for (const row of out) kept += row.length;
  return { data: out, dropped: total - kept };
}
