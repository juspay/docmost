import { describe, expect, it } from 'vitest';
import { mapReferences } from './engine';
import { decodeFormula, encodeFormula, type RefContext } from './refs';

type Tab = { name: string; rows: string[]; cols: string[] };

function fakeContext(sheetId: string, tabs: Record<string, Tab>): RefContext {
  const tab = (id: string) => tabs[id] ?? null;
  return {
    sheetId,
    rowId: (id, row) => tab(id)?.rows[row] ?? null,
    colId: (id, col) => tab(id)?.cols[col] ?? null,
    rowIndex: (id, rowId) => {
      const i = tab(id)?.rows.indexOf(rowId) ?? -1;
      return i < 0 ? null : i;
    },
    colIndex: (id, colId) => {
      const i = tab(id)?.cols.indexOf(colId) ?? -1;
      return i < 0 ? null : i;
    },
    sheetIdByName: (name) =>
      Object.keys(tabs).find(
        (id) => tabs[id].name.toLowerCase() === name.toLowerCase(),
      ) ?? null,
    sheetName: (id) => tab(id)?.name ?? null,
  };
}

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function twoTabs() {
  return {
    t1: { name: 'Sheet1', rows: ids('r', 10), cols: ids('c', 5) },
    t2: { name: 'Sheet2', rows: ids('s', 10), cols: ids('d', 5) },
    t3: { name: 'My Sheet', rows: ids('q', 10), cols: ids('e', 5) },
  };
}

describe('formula anchors', () => {
  it('encode then decode returns the input for A1, $A$1, A1:B2, Sheet2!A1 and a string literal containing "A1"', () => {
    const ctx = fakeContext('t1', twoTabs());
    for (const input of [
      '=A1',
      '=$A$1',
      '=$A1+B$2',
      '=SUM(A1:B2)',
      '=Sheet2!A1',
      '=SUM(Sheet2!A1:B3)*2',
      "='My Sheet'!C4",
      '="A1"&A1',
      '=LOG10(A1)',
      'A1 is just text',
    ]) {
      const stored = encodeFormula(input, ctx);
      expect(decodeFormula(stored, ctx)).toBe(input);
    }
  });

  it('stores anchors, not positions', () => {
    const tabs = twoTabs();
    const ctx = fakeContext('t1', tabs);
    const stored = encodeFormula('=A2+Sheet2!B3+"A2"', ctx);
    expect(stored).not.toMatch(/(^|[^"])A2/);
    expect(stored).not.toContain('Sheet2');
    // a row inserted above row 2 moves the reference with its cell
    tabs.t1.rows.splice(1, 0, 'new');
    tabs.t2.name = 'Renamed';
    expect(decodeFormula(stored, ctx)).toBe('=A3+Renamed!B3+"A2"');
  });

  it('an anchor whose row, column or tab is gone decodes to #REF!', () => {
    const tabs = twoTabs();
    const ctx = fakeContext('t1', tabs);
    const stored = encodeFormula('=A2+B1+Sheet2!A1', ctx);
    tabs.t1.rows.splice(1, 1);
    tabs.t1.cols.splice(1, 1);
    delete (tabs as any).t2;
    expect(decodeFormula(stored, ctx)).toBe('=#REF!+#REF!+#REF!');
  });

  it('a reference to an unknown tab or past the ids is kept as typed', () => {
    const ctx = fakeContext('t1', twoTabs());
    expect(decodeFormula(encodeFormula('=Nope!A1+A99', ctx), ctx)).toBe(
      '=Nope!A1+A99',
    );
  });

  it('quotes a decoded tab name that needs it', () => {
    const tabs = twoTabs();
    const ctx = fakeContext('t1', tabs);
    const stored = encodeFormula('=Sheet2!A1', ctx);
    tabs.t2.name = "Bob's 2024";
    expect(decodeFormula(stored, ctx)).toBe("='Bob''s 2024'!A1");
    expect(encodeFormula("='Bob''s 2024'!A1", ctx)).toBe(stored);
  });
});

describe('mapReferences', () => {
  it('mapReferences leaves function names and string literals alone', () => {
    const seen: string[] = [];
    const out = mapReferences(
      '=LOG10(A1)&"B2 and C3"&SUM(C3:$D$4)&TRUE&Sheet2!E5',
      (ref) => {
        seen.push(`${ref.sheetName ?? ''}:${ref.row}:${ref.col}`);
        return 'X';
      },
    );
    expect(out).toBe('=LOG10(X)&"B2 and C3"&SUM(X:X)&TRUE&X');
    expect(seen).toEqual([':0:0', ':2:2', ':3:3', 'Sheet2:4:4']);
  });

  it('gives both ends of a qualified range their tab', () => {
    const seen: (string | undefined)[] = [];
    mapReferences("='My Sheet'!A1:B2", (ref) => {
      seen.push(ref.sheetName);
      return '';
    });
    expect(seen).toEqual(['My Sheet', 'My Sheet']);
  });
});
