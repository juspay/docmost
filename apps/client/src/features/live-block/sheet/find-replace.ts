import { sheet as S } from "@docmost/live-blocks";
import type { CellPos } from "./use-grid-selection";

export type FindOptions = { matchCase: boolean; inFormulas: boolean };

/** Cells whose value holds the query, row by row; formula text only when asked. */
export function findMatches(
  sheet: S.Sheet,
  query: string,
  opts: FindOptions,
): CellPos[] {
  if (!query) return [];
  const needle = opts.matchCase ? query : query.toLowerCase();
  const out: CellPos[] = [];
  for (const [key, cell] of Object.entries(sheet.cells)) {
    const raw = cell?.v ?? "";
    if (!raw || (raw.startsWith("=") && !opts.inFormulas)) continue;
    const hay = opts.matchCase ? raw : raw.toLowerCase();
    if (!hay.includes(needle)) continue;
    const pos = S.parseKey(key);
    if (pos) out.push(pos);
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceInText(
  text: string,
  query: string,
  replacement: string,
  matchCase: boolean,
): string {
  if (!query) return text;
  return text.replace(
    new RegExp(escapeRegExp(query), matchCase ? "g" : "gi"),
    () => replacement,
  );
}

/** Replaces in every matched cell of a draft tab; one write, so one undo step. */
export function replaceAll(
  draft: S.Sheet,
  matches: CellPos[],
  query: string,
  replacement: string,
  matchCase: boolean,
): number {
  let count = 0;
  for (const { row, col } of matches) {
    const raw = S.getRaw(draft, row, col);
    const next = replaceInText(raw, query, replacement, matchCase);
    if (next !== raw) {
      S.setCellRaw(draft, row, col, next);
      count++;
    }
  }
  return count;
}
