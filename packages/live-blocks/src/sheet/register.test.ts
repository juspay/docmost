import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import '../index';
import { applyOps, MAX_CELLS_PER_OP } from '../ops';
import { kindDefinition } from '../registry';
import {
  buildSnapshot,
  emptySnapshot,
  LiveBlockInputError,
  seedYdoc,
  SNAPSHOT_DISPLAY_CELLS,
  STORE_SNAPSHOT_BUDGET_MS,
  validateSnapshotInput,
  type SheetSnapshot,
} from '../snapshot';
import { renderStaticNodes } from '../static-render';
import { TRUNCATED_TABLE_NOTICE } from './register';
import { addSheet, createEmptyBook, parseA1, setCellRaw } from './model';
import { FIRST_TAB_ID, readBook, seedSheet, setCell } from './ydoc';

function docOf(cells: Record<string, string> = {}, extraTabs: string[] = []) {
  const book = createEmptyBook();
  for (const [a1, v] of Object.entries(cells)) {
    const ref = parseA1(a1)!;
    setCellRaw(book.sheets[0], ref.row, ref.col, v);
  }
  for (const name of extraTabs) addSheet(book, name);
  book.activeSheetId = book.sheets[0].id;
  const doc = new Y.Doc();
  seedSheet(doc, book);
  return doc;
}

function rawAt(doc: Y.Doc, a1: string, tab = 0) {
  const ref = parseA1(a1)!;
  return readBook(doc).sheets[tab].cells[`${ref.row}:${ref.col}`]?.v;
}

const setCells = (cells: { a1: string; value: string }[], extra = {}) => ({
  type: 'sheet.setCells' as const,
  cells,
  ...extra,
});

describe('sheet kind', () => {
  afterEach(() => vi.restoreAllMocks());
  it('the snapshot carries computed display values', () => {
    const doc = docOf({ A1: '2', A2: '3', A3: '=SUM(A1:A2)' });
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    const id = snapshot.book.sheets[0].id;
    expect(snapshot.kind).toBe('sheet');
    expect(snapshot.display[id]['2:0']).toBe('5');
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.book.sheets[0].cells['2:0'].v).toBe('=SUM(A1:A2)');
  });

  it('build stops at the cell cap and sets truncated', () => {
    // a stopped clock: the 2 s time budget cannot decide this on a slow machine
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const book = createEmptyBook();
    const sheet = book.sheets[0];
    sheet.rows = 5000;
    sheet.cols = 11;
    for (let r = 0; r < 5000; r++) {
      for (let c = 0; c < 11; c++) setCellRaw(sheet, r, c, String(r + c));
    }
    const doc = new Y.Doc();
    seedSheet(doc, book);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    const shown = Object.keys(snapshot.display[sheet.id]).length;
    expect(shown).toBe(SNAPSHOT_DISPLAY_CELLS);
    expect(snapshot.truncated).toBe(true);
    // row-major: the top of the sheet is what is kept
    expect(snapshot.display[sheet.id]['0:0']).toBe('0');
  });

  it('build stops at the time budget and sets truncated', () => {
    const doc = docOf({ A1: '1', A2: '2', A3: '3' });
    let now = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1500));
    try {
      const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
      expect(snapshot.truncated).toBe(true);
      const id = snapshot.book.sheets[0].id;
      // the clock passes the budget after the first cell
      expect(Object.keys(snapshot.display[id])).toEqual(['0:0']);
    } finally {
      spy.mockRestore();
    }
  });

  it('build honours a shorter budget when one is given', () => {
    const doc = docOf({ A1: '1', A2: '2', A3: '3' });
    let now = 0;
    // 300 ms per tick: past a 250 ms budget after one cell, inside 2000 ms for all three
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (now += 300));
    try {
      const short = buildSnapshot('sheet', doc, {
        budgetMs: STORE_SNAPSHOT_BUDGET_MS,
      }) as SheetSnapshot;
      expect(short.truncated).toBe(true);
      now = 0;
      const full = buildSnapshot('sheet', doc) as SheetSnapshot;
      expect(full.truncated).toBe(false);
      expect(Object.keys(full.display[full.book.sheets[0].id])).toHaveLength(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('build survives a cell whose evaluation throws', () => {
    const doc = docOf({ A1: '1' });
    const id = readBook(doc).sheets[0].id;
    // toFixed(500) would throw; formats are normalised, so decimals become 10
    setCell(doc, id, 0, 1, { v: '5', f: { numFmt: 'number', decimals: 500 } });
    const tab = doc.getMap<Y.Map<any>>('sheets').get(id);
    const cells = tab.get('cells') as Y.Map<any>;
    // a client can still store anything: write the raw format past the writer
    for (const [key, value] of [...cells.entries()]) {
      if (value.v === '5')
        cells.set(key, { v: '5', f: { numFmt: 'number', decimals: 500 } });
    }
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    expect(snapshot.display[id]['0:1']).toBe('5.0000000000');
    expect(snapshot.display[id]['0:0']).toBe('1');
  });

  it('an empty document builds the empty book', () => {
    const snapshot = buildSnapshot('sheet', new Y.Doc()) as SheetSnapshot;
    expect(snapshot.book.sheets).toHaveLength(1);
    expect(emptySnapshot('sheet')).toMatchObject({
      kind: 'sheet',
      truncated: false,
    });
  });

  it('seed then build returns the same book', () => {
    const doc = docOf({ A1: '=B1*2', B1: '4' }, ['Two']);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    const copy = buildSnapshot('sheet', seedYdoc(snapshot)) as SheetSnapshot;
    expect(copy.book).toEqual(snapshot.book);
    expect(copy.display).toEqual(snapshot.display);
  });

  it('validate refuses a book over 5,000 rows', () => {
    const book = createEmptyBook();
    book.sheets[0].rows = 5001;
    expect(() => validateSnapshotInput('sheet', book)).toThrow(
      LiveBlockInputError,
    );
    const wide = createEmptyBook();
    wide.sheets[0].cells['0:702'] = { v: 'x' };
    expect(() => validateSnapshotInput('sheet', wide)).toThrow(/702 columns/);
    expect(() => validateSnapshotInput('sheet', 'nonsense')).toThrow(
      LiveBlockInputError,
    );

    const ok = createEmptyBook();
    setCellRaw(ok.sheets[0], 0, 0, '=1+1');
    const snapshot = validateSnapshotInput('sheet', {
      kind: 'sheet',
      book: ok,
    }) as SheetSnapshot;
    expect(snapshot.display[ok.sheets[0].id]['0:0']).toBe('2');
  });

  it('applyOps sheet.setCells writes literals and formulas by A1 address', () => {
    const doc = docOf();
    applyOps('sheet', doc, [
      setCells([
        { a1: 'A1', value: '10' },
        { a1: 'A2', value: '32' },
        { a1: 'B1', value: '=A1+A2' },
        { a1: 'C1', value: 'label' },
      ]),
    ]);
    expect(rawAt(doc, 'B1')).toBe('=A1+A2');
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    expect(snapshot.display[snapshot.book.sheets[0].id]['0:1']).toBe('42');
    // stored anchored: an insert above keeps the formula on its cells
    const stored = doc
      .getMap<Y.Map<any>>('sheets')
      .get(snapshot.book.sheets[0].id);
    const values = [...(stored.get('cells') as Y.Map<any>).values()].map(
      (c) => c.v,
    );
    expect(values).not.toContain('=A1+A2');
  });

  it('setCells past the current size grows rows and cols', () => {
    const doc = docOf();
    applyOps('sheet', doc, [setCells([{ a1: 'AB100', value: 'far' }])]);
    const sheet = readBook(doc).sheets[0];
    expect(sheet.rows).toBe(100);
    expect(sheet.cols).toBe(28);
    expect(rawAt(doc, 'AB100')).toBe('far');
  });

  it('setCells picks the tab by sheetId, then by sheetName without regard to case', () => {
    const doc = docOf({}, ['Data', 'Other']);
    const [, data, other] = readBook(doc).sheets;
    applyOps('sheet', doc, [
      setCells([{ a1: 'A1', value: 'by id' }], {
        sheetId: other.id,
        sheetName: 'Data',
      }),
      setCells([{ a1: 'A2', value: 'by name' }], { sheetName: 'dATA' }),
      setCells([{ a1: 'A3', value: 'first' }]),
      setCells([{ a1: 'Other!A4', value: 'prefix wins' }], {
        sheetName: 'Data',
      }),
    ]);
    expect(rawAt(doc, 'A1', 2)).toBe('by id');
    expect(rawAt(doc, 'A2', 1)).toBe('by name');
    expect(rawAt(doc, 'A3', 0)).toBe('first');
    expect(rawAt(doc, 'A4', 2)).toBe('prefix wins');
    expect(data.name).toBe('Data');
  });

  it('setCells beyond the limits is refused with a count', () => {
    const doc = docOf();
    expect(() =>
      applyOps('sheet', doc, [
        { type: 'sheet.setCells', cells: [{ a1: 'A5001', value: '1' }] },
      ] as any),
    ).toThrow(/1 cell.* outside 5000 rows/);
    expect(() =>
      applyOps('sheet', doc, [
        setCells([
          { a1: 'A1', value: 'ok' },
          { a1: 'ZZZ1', value: '1' },
          { a1: 'A9999', value: '1' },
        ]),
      ]),
    ).toThrow(/2 cells .*outside 5000 rows and 702 columns/);
    // nothing of a refused operation is written
    expect(rawAt(doc, 'A1')).toBeUndefined();
  });

  it('setCells with more than MAX_CELLS_PER_OP cells is refused', () => {
    const doc = docOf();
    const cells = Array.from({ length: MAX_CELLS_PER_OP + 1 }, (_, i) => ({
      a1: `A${(i % 4000) + 1}`,
      value: 'x',
    }));
    expect(MAX_CELLS_PER_OP).toBe(5000);
    expect(() => applyOps('sheet', doc, [setCells(cells)])).toThrow(
      LiveBlockInputError,
    );
    expect(() =>
      applyOps('sheet', doc, [setCells(cells.slice(0, MAX_CELLS_PER_OP))]),
    ).not.toThrow();
  });

  it('setCells to an unknown tab name is refused unless createSheet is true', () => {
    const doc = docOf();
    expect(() =>
      applyOps('sheet', doc, [
        setCells([{ a1: 'A1', value: 'x' }], { sheetName: 'Budget' }),
      ]),
    ).toThrow(/Budget/);
    expect(() =>
      applyOps('sheet', doc, [setCells([{ a1: 'Budget!A1', value: 'x' }])]),
    ).toThrow(/Budget/);
    applyOps('sheet', doc, [
      setCells(
        [
          { a1: 'A1', value: 'x' },
          { a1: 'Q2!B2', value: 'y' },
        ],
        {
          sheetName: 'Budget',
          createSheet: true,
        },
      ),
    ]);
    const book = readBook(doc);
    expect(book.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Budget', 'Q2']);
    expect(rawAt(doc, 'A1', 1)).toBe('x');
    expect(rawAt(doc, 'B2', 2)).toBe('y');
  });

  it('setCells refuses bad input as an input error', () => {
    const doc = docOf();
    expect(() =>
      applyOps('sheet', doc, [setCells([{ a1: 'nope', value: 'x' }])]),
    ).toThrow(LiveBlockInputError);
    expect(() =>
      applyOps('sheet', doc, [setCells([{ a1: 'A1', value: 3 as any }])]),
    ).toThrow(LiveBlockInputError);
    expect(() =>
      applyOps('sheet', doc, [{ type: 'sheet.other' } as any]),
    ).toThrow(LiveBlockInputError);
  });

  it('staticNodes gives a heading per tab when there are several, then each table', () => {
    const doc = docOf({ A1: '=1+1' }, ['Data']);
    const id = readBook(doc).sheets[1].id;
    setCell(doc, id, 0, 0, { v: 'on data' });
    const snapshot = buildSnapshot('sheet', doc);
    const nodes = renderStaticNodes(snapshot, { title: 'Budget' }) as any[];
    expect(nodes.map((n) => n.type)).toEqual([
      'heading',
      'table',
      'heading',
      'table',
    ]);
    expect(nodes[0].content[0].text).toBe('Sheet1');
    expect(nodes[1].content[0].content[0].content[0].content[0].text).toBe('2');

    const single = buildSnapshot('sheet', docOf({ A1: 'x' }));
    expect(
      (renderStaticNodes(single, { title: 'T' }) as any[]).map((n) => n.type),
    ).toEqual(['table']);
    const empty = buildSnapshot('sheet', docOf());
    expect(renderStaticNodes(empty, { title: 'T' })).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Spreadsheet: T' }],
      },
    ]);
  });

  it('staticNodes says when a table is too large to show in full', () => {
    const snapshot = buildSnapshot('sheet', docOf({ A1: 'x' }));
    const notice = {
      type: 'paragraph',
      content: [{ type: 'text', text: TRUNCATED_TABLE_NOTICE }],
    };
    expect(
      renderStaticNodes({ ...snapshot, truncated: true }, { title: 'T' }),
    ).toContainEqual(notice);
    expect(renderStaticNodes(snapshot, { title: 'T' })).not.toContainEqual(
      notice,
    );
  });

  it('is registered with everything the platform calls', () => {
    const def = kindDefinition('sheet');
    for (const fn of [
      'empty',
      'build',
      'seed',
      'validate',
      'staticNodes',
      'applyOp',
    ]) {
      expect(typeof (def as any)[fn]).toBe('function');
    }
  });

  it('validate refuses malformed books with an input error, never a TypeError', () => {
    const circular: any = { sheets: [] };
    circular.sheets.push({ name: 'x', self: circular });
    const sheet = (extra: object) => ({
      sheets: [{ id: 's', name: 'S', rows: 10, cols: 5, cells: {}, ...extra }],
    });
    const cases: [string, unknown][] = [
      ['null', null],
      ['an array', []],
      ['sheets as text', { sheets: 'x' }],
      ['no sheets', { sheets: [] }],
      ['a sheet that is null', { sheets: [null] }],
      ['negative rows', sheet({ rows: -1 })],
      ['NaN rows', sheet({ rows: NaN })],
      ['fractional cols', sheet({ cols: 2.5 })],
      ["a cell key 'a:b'", sheet({ cells: { 'a:b': { v: 'x' } } })],
      ['a non-text value', sheet({ cells: { '0:0': { v: 5 } } })],
      ['a cell that is text', sheet({ cells: { '0:0': 'x' } })],
      [
        'duplicate sheet ids',
        {
          sheets: [
            { id: 'same', name: 'A' },
            { id: 'same', name: 'B' },
          ],
        },
      ],
      ['merges as text', sheet({ merges: 'x' })],
      ['a garbage merge', sheet({ merges: [{ r1: 'a' }] })],
      ['a circular object', circular],
      [
        'a value over the cap',
        sheet({ cells: { '0:0': { v: 'x'.repeat(32_768) } } }),
      ],
      [
        'too many tabs',
        {
          sheets: Array.from({ length: 201 }, (_, i) => ({
            id: `t${i}`,
            name: `T${i}`,
          })),
        },
      ],
    ];
    for (const [name, input] of cases) {
      let error: unknown = null;
      try {
        validateSnapshotInput('sheet', input);
      } catch (err) {
        error = err;
      }
      expect(error, name).toBeInstanceOf(LiveBlockInputError);
    }
  });

  it('validate recomputes display and normalises formats from outside', () => {
    const book = createEmptyBook();
    setCellRaw(book.sheets[0], 0, 0, '=2+2');
    const evil = 'left;position:fixed;inset:0;background:url(https://evil/x)';
    (book.sheets[0].cells['0:0'] as any).f = {
      align: evil,
      color: evil,
      bold: true,
    };
    const snapshot = validateSnapshotInput('sheet', {
      kind: 'sheet',
      book,
      display: { [book.sheets[0].id]: { '0:0': 'forged' } },
    }) as SheetSnapshot;
    expect(snapshot.display[book.sheets[0].id]['0:0']).toBe('4');
    expect(snapshot.book.sheets[0].cells['0:0'].f).toEqual({ bold: true });
  });

  it('malformed ops are input errors', () => {
    const cases: [string, unknown][] = [
      ['cells not a list', [{ type: 'sheet.setCells', cells: 'x' }]],
      [
        'an unknown sheetId',
        [{ type: 'sheet.setCells', sheetId: 'nope', cells: [] }],
      ],
      ['a null cell', [{ type: 'sheet.setCells', cells: [null] }]],
      [
        'an undefined a1',
        [{ type: 'sheet.setCells', cells: [{ value: 'x' }] }],
      ],
      [
        'a non-text sheetName',
        [{ type: 'sheet.setCells', sheetName: 5, cells: [] }],
      ],
      [
        'a non-text sheetId',
        [{ type: 'sheet.setCells', sheetId: {}, cells: [] }],
      ],
      ['a null op', [null]],
      ['ops that are null', null],
      ['ops that are not a list', { type: 'sheet.setCells' }],
      [
        'too many ops',
        Array.from({ length: 101 }, () => ({
          type: 'sheet.setCells',
          cells: [],
        })),
      ],
    ];
    for (const [name, ops] of cases) {
      const doc = docOf({ A1: 'kept' });
      const before = Y.encodeStateAsUpdate(doc);
      let error: unknown = null;
      try {
        applyOps('sheet', doc, ops as any);
      } catch (err) {
        error = err;
      }
      expect(error, name).toBeInstanceOf(LiveBlockInputError);
      expect(Y.encodeStateAsUpdate(doc), name).toEqual(before);
    }
  });

  it('a request that fails in a later op changes nothing, even a tab it created', () => {
    const doc = docOf();
    const before = Y.encodeStateAsUpdate(doc);
    expect(() =>
      applyOps('sheet', doc, [
        setCells([{ a1: 'A1', value: 'first op' }]),
        setCells([{ a1: 'B1', value: 'x' }], {
          sheetName: 'New',
          createSheet: true,
        }),
        setCells([{ a1: 'nope', value: 'bad' }]),
      ]),
    ).toThrow(LiveBlockInputError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readBook(doc).sheets.map((s) => s.name)).toEqual(['Sheet1']);
  });

  it('the cell cap counts every op of a request', () => {
    const doc = docOf();
    const half = Array.from({ length: 2600 }, (_, i) => ({
      a1: `A${i + 1}`,
      value: 'x',
    }));
    expect(() =>
      applyOps('sheet', doc, [setCells(half), setCells(half)]),
    ).toThrow(/At most 5000 cells per request/);
  });

  it('5,000 formulas are written in one batch, reading the layout once', () => {
    const doc = docOf();
    const cells = Array.from({ length: 5000 }, (_, i) => ({
      a1: `B${i + 1}`,
      value: `=A${i + 1}*2`,
    }));
    // the layout is read from the rows and columns arrays; per-cell writes
    // read it once per cell (10,000+ reads before the batch writer)
    const reads = vi.spyOn(Y.Array.prototype, 'toArray');
    try {
      applyOps('sheet', doc, [setCells(cells)]);
      expect(reads.mock.calls.length).toBeLessThan(50);
    } finally {
      reads.mockRestore();
    }
    expect(rawAt(doc, 'B5000')).toBe('=A5000*2');
  });

  it('the snapshot keeps only the cells its display shows', () => {
    // a stopped clock: the 2 s time budget cannot decide this on a slow machine
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const book = createEmptyBook();
    const sheet = book.sheets[0];
    sheet.rows = 5000;
    sheet.cols = 12;
    for (let r = 0; r < 5000; r++)
      for (let c = 0; c < 12; c++) setCellRaw(sheet, r, c, `${r}`);
    const doc = new Y.Doc();
    seedSheet(doc, book);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    const kept = Object.keys(snapshot.book.sheets[0].cells).length;
    expect(snapshot.truncated).toBe(true);
    expect(kept).toBe(Object.keys(snapshot.display[sheet.id]).length);
    expect(kept).toBe(SNAPSHOT_DISPLAY_CELLS);
  });

  it('the server and an editor make the same first tab, so they converge on one', () => {
    const server = new Y.Doc();
    applyOps('sheet', server, [
      setCells([{ a1: 'A1', value: 'from the server' }]),
    ]);
    expect(readBook(server).sheets[0].id).toBe(FIRST_TAB_ID);
    expect(
      (buildSnapshot('sheet', new Y.Doc()) as SheetSnapshot).book.sheets[0].id,
    ).toBe(FIRST_TAB_ID);
  });

  it('a snapshot whose budget ran out keeps plain values and is marked truncated', () => {
    // a stopped clock: the 2 s time budget cannot decide this on a slow machine
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const book = createEmptyBook();
    const sheet = book.sheets[0];
    sheet.rows = 5000;
    sheet.cols = 702;
    sheet.cells['0:0'] = { v: '=SUM(B1:ZZ5000,B1:ZZ5000)' };
    sheet.cells['1:1'] = { v: 'hello' };
    sheet.cells['2:2'] = { v: '5' };
    const doc = new Y.Doc();
    seedSheet(doc, book);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    const shown = snapshot.display[sheet.id];
    expect(shown['0:0']).toBe('#NUM!');
    expect(shown['1:1']).toBe('hello');
    expect(shown['2:2']).toBe('5');
    expect(snapshot.truncated).toBe(true);
  });

  it('seed refuses a truncated snapshot', () => {
    const snapshot = buildSnapshot(
      'sheet',
      docOf({ A1: '1' }),
    ) as SheetSnapshot;
    expect(() => seedYdoc({ ...snapshot, truncated: true })).toThrow(
      LiveBlockInputError,
    );
    expect(() => seedYdoc(snapshot)).not.toThrow();
  });

  it('build passes its time budget to the engine as a deadline', () => {
    // one formula; the clock reads 0 for the start and the first between-cell
    // check, then jumps past the 2 s budget while the formula is evaluated, so
    // only the engine's deadline can stop it
    const doc = docOf({ A1: '=1+1' });
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (calls++ < 2 ? 0 : 10_000));
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    const id = snapshot.book.sheets[0].id;
    expect(snapshot.display[id]['0:0']).toBe('#NUM!');
    expect(snapshot.truncated).toBe(true);
  });
});
