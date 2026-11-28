import type { SheetSnapshot } from '../snapshot';
import { findMerge, isCovered } from './model';

export const STATIC_TABLE_ROWS = 200;
export const STATIC_TABLE_COLS = 50;

function plural(n: number, word: string): string {
  return `${n} more ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Table nodes of display values for a tab's used range (from A1 to the last
 * filled cell), capped, then a line saying how much was left out.
 */
export function sheetToTableNodes(
  snapshot: SheetSnapshot,
  tab: string | SheetSnapshot['book']['sheets'][number],
): unknown[] {
  // a caller looping over the tabs passes the tab itself (no find per tab)
  const sheet =
    typeof tab === 'string'
      ? snapshot.book.sheets.find((s) => s.id === tab)
      : tab;
  if (!sheet) return [];
  const sheetId = sheet.id;
  const display = snapshot.display?.[sheetId] ?? {};
  let lastRow = -1;
  let lastCol = -1;
  for (const [key, cell] of Object.entries(sheet.cells)) {
    if (!cell?.v) continue;
    const [r, c] = key.split(':').map(Number);
    if (r > lastRow) lastRow = r;
    if (c > lastCol) lastCol = c;
  }
  if (lastRow < 0) return [];

  const rows = Math.min(lastRow + 1, STATIC_TABLE_ROWS);
  const cols = Math.min(lastCol + 1, STATIC_TABLE_COLS);
  const tableRows: unknown[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: unknown[] = [];
    for (let c = 0; c < cols; c++) {
      if (isCovered(sheet, r, c)) continue;
      const merge = findMerge(sheet, r, c);
      const text = display[`${r}:${c}`] ?? '';
      cells.push({
        type: 'tableCell',
        attrs: {
          colspan: merge ? Math.min(merge.c2, cols - 1) - c + 1 : 1,
          rowspan: merge ? Math.min(merge.r2, rows - 1) - r + 1 : 1,
          colwidth: null,
        },
        content: [
          {
            type: 'paragraph',
            content: text ? [{ type: 'text', text }] : [],
          },
        ],
      });
    }
    tableRows.push({ type: 'tableRow', content: cells });
  }

  const nodes: unknown[] = [{ type: 'table', content: tableRows }];
  const moreRows = lastRow + 1 - rows;
  const moreCols = lastCol + 1 - cols;
  if (moreRows > 0 || moreCols > 0) {
    const parts = [];
    if (moreRows > 0) parts.push(plural(moreRows, 'row'));
    if (moreCols > 0) parts.push(plural(moreCols, 'column'));
    nodes.push({
      type: 'paragraph',
      content: [{ type: 'text', text: `… and ${parts.join(', ')}` }],
    });
  }
  return nodes;
}
