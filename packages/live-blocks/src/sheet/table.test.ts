import { describe, expect, it } from 'vitest';
import type { SheetSnapshot } from '../snapshot';
import { createEmptyBook, mergeCells, setCellRaw } from './model';
import {
  sheetToTableNodes,
  STATIC_TABLE_COLS,
  STATIC_TABLE_ROWS,
} from './table';

type PMNode = { type: string; attrs?: any; content?: PMNode[]; text?: string };

function snapshotWith(cells: [number, number, string][]): SheetSnapshot {
  const book = createEmptyBook();
  const sheet = book.sheets[0];
  sheet.rows = 5000;
  sheet.cols = 702;
  const display: Record<string, string> = {};
  for (const [r, c, v] of cells) {
    setCellRaw(sheet, r, c, v);
    display[`${r}:${c}`] = `d:${v}`;
  }
  return {
    kind: 'sheet',
    book,
    display: { [sheet.id]: display },
    truncated: false,
  };
}

const textOf = (cell: PMNode) =>
  (cell.content?.[0]?.content ?? []).map((t) => t.text).join('');

describe('sheetToTableNodes', () => {
  it('sheetToTableNodes covers the used range, respects merges, and adds the "more rows" line past the cap', () => {
    const small = snapshotWith([
      [0, 0, 'a'],
      [1, 2, 'b'],
      [2, 0, 'merged'],
    ]);
    mergeCells(small.book.sheets[0], 2, 0, 2, 1);
    const [table, ...rest] = sheetToTableNodes(
      small,
      small.book.sheets[0].id,
    ) as PMNode[];
    expect(rest).toEqual([]);
    expect(table.type).toBe('table');
    expect(table.content).toHaveLength(3);
    const rows = table.content;
    expect(rows.every((r) => r.type === 'tableRow')).toBe(true);
    expect(rows[0].content.map(textOf)).toEqual(['d:a', '', '']);
    expect(rows[1].content.map(textOf)).toEqual(['', '', 'd:b']);
    // the merged anchor spans two columns; the covered cell is not drawn
    expect(rows[2].content).toHaveLength(2);
    expect(rows[2].content[0].attrs).toMatchObject({ colspan: 2, rowspan: 1 });
    expect(textOf(rows[2].content[0])).toBe('d:merged');
    for (const cell of rows.flatMap((r) => r.content)) {
      expect(cell.type).toBe('tableCell');
      expect(cell.content[0].type).toBe('paragraph');
    }

    const big = snapshotWith([
      [0, 0, 'top'],
      [STATIC_TABLE_ROWS + 9, STATIC_TABLE_COLS + 2, 'far'],
    ]);
    const nodes = sheetToTableNodes(big, big.book.sheets[0].id) as PMNode[];
    expect(nodes).toHaveLength(2);
    expect(nodes[0].content).toHaveLength(STATIC_TABLE_ROWS);
    expect(nodes[0].content[0].content).toHaveLength(STATIC_TABLE_COLS);
    expect(nodes[1]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '… and 10 more rows, 3 more columns' }],
    });
  });

  it('an empty tab gives no table', () => {
    const empty = snapshotWith([]);
    expect(sheetToTableNodes(empty, empty.book.sheets[0].id)).toEqual([]);
  });
});
