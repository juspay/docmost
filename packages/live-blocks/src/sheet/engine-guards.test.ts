import { describe, expect, it, vi } from 'vitest';
import { Engine, FormulaError, MAX_VISITS, wildcardMatch } from './engine';
import { createEmptyBook, setCellRaw } from './model';

function bookWith(cells: [number, number, string][], rows = 60) {
  const book = createEmptyBook();
  const sheet = book.sheets[0];
  sheet.rows = rows;
  for (const [r, c, v] of cells) setCellRaw(sheet, r, c, v);
  return { book, id: sheet.id };
}

describe('engine guards', () => {
  it('a 10,000-deep chain and a huge REPT return errors, not a crash', () => {
    // 5,000 rows down column A, then 5,000 more down column B
    const cells: [number, number, string][] = [[0, 0, '1']];
    for (let r = 1; r < 5_000; r++) cells.push([r, 0, `=A${r}+1`]);
    cells.push([0, 1, '=A5000+1']);
    for (let r = 1; r < 5_000; r++) cells.push([r, 1, `=B${r}+1`]);
    const chain = bookWith(cells, 5_000);
    const bottom = new Engine(chain.book).getValue(chain.id, 4_999, 1);
    expect(typeof bottom === 'number' || bottom instanceof FormulaError).toBe(
      true,
    );
    // a sheet of running totals is common, so the chain gives its real value
    expect(bottom).toBe(10_000);

    const rept = bookWith([[0, 0, '=REPT("x",1e9)']]);
    const engine = new Engine(rept.book);
    const repeat = vi.spyOn(String.prototype, 'repeat');
    try {
      const value = engine.getValue(rept.id, 0, 0);
      expect(value).toBeInstanceOf(FormulaError);
      expect(engine.display(rept.id, 0, 0)).toMatch(/^#/);
      // refused before the 1e9-character string is built
      expect(repeat).not.toHaveBeenCalled();
    } finally {
      repeat.mockRestore();
    }

    const cycle = bookWith([
      [0, 0, '=B1'],
      [0, 1, '=A1'],
    ]);
    expect(new Engine(cycle.book).display(cycle.id, 0, 0)).toBe('#CYCLE!');
  });

  it('a long cycle is still a cycle, not a stall', () => {
    const cells: [number, number, string][] = [[0, 0, '=A3000']];
    for (let r = 1; r < 3_000; r++) cells.push([r, 0, `=A${r}`]);
    const { book, id } = bookWith(cells, 3_000);
    const engine = new Engine(book);
    expect(engine.display(id, 1_500, 0)).toBe('#CYCLE!');
  });

  it('text results are capped at 32,767 characters', () => {
    const { book, id } = bookWith([
      [0, 0, '=REPT("ab",20000)'],
      [0, 1, '=REPT("a",30000)&REPT("b",30000)'],
      [0, 2, '=SUBSTITUTE(REPT("a",1000),"a",REPT("b",1000))'],
      [0, 3, '=REPT("a",32767)'],
    ]);
    const engine = new Engine(book);
    expect(engine.display(id, 0, 0)).toBe('#VALUE!');
    expect(engine.display(id, 0, 1)).toBe('#VALUE!');
    expect(engine.display(id, 0, 2)).toBe('#VALUE!');
    expect(String(engine.getValue(id, 0, 3)).length).toBe(32_767);
  });

  it('a range past the sheet limits is #REF!, not a billion-cell walk', () => {
    const { book, id } = bookWith([
      [0, 0, '=SUM(B1:B999999999)'],
      [0, 1, '=SUM(A2:ZZZ9)'],
    ]);
    // a tiny budget: a range that were walked would run it out
    const engine = new Engine(book, { budget: 100 });
    expect(engine.display(id, 0, 0)).toBe('#REF!');
    expect(engine.display(id, 0, 1)).toBe('#REF!');
    expect(engine.outOfBudget).toBe(false);
  });

  it('a wildcard criterion is matched in linear time', () => {
    const { book, id } = bookWith([
      [0, 0, 'a'.repeat(40)],
      [0, 1, '=COUNTIF(A1,"' + '*a'.repeat(26) + '*b")'],
      [0, 2, '=COUNTIF(A1,"' + '*a'.repeat(26) + '*")'],
      [1, 0, 'Apple pie'],
      [1, 1, '=COUNTIF(A1:A3,"app?e*")'],
      [2, 0, 'what?'],
      [2, 1, '=COUNTIF(A1:A3,"*~?")'],
      [3, 0, '=COUNTIF(A1,"' + '*'.repeat(300) + '")'],
    ]);
    const engine = new Engine(book);
    expect(engine.getValue(id, 0, 1)).toBe(0);
    expect(engine.getValue(id, 0, 2)).toBe(1);
    // the matcher's steps stay within text x pattern (the regex was exponential)
    const text = 'a'.repeat(40);
    const pattern = '*a'.repeat(26) + '*b';
    const steps = { n: 0 };
    expect(wildcardMatch(pattern, text, steps)).toBe(false);
    expect(steps.n).toBeLessThanOrEqual(
      (text.length + 1) * (pattern.length + 1),
    );
    expect(engine.getValue(id, 1, 1)).toBe(1);
    expect(engine.getValue(id, 2, 1)).toBe(1);
    // a criterion longer than 255 characters matches nothing, as in Excel
    expect(engine.getValue(id, 3, 0)).toBe(0);
  });

  it('the work budget bounds ranges before they are walked', () => {
    const big = '$B$1:$ZZ$5000';
    const { book, id } = bookWith(
      [
        [1, 1, '7'],
        [0, 0, `=SUM(${big})`],
        [1, 0, `=SUM(${big},${big})`],
      ],
      5000,
    );
    book.sheets[0].cols = 702;
    const engine = new Engine(book);
    // one whole-sheet range fits the budget and reads only the stored cells
    const reads = vi.spyOn(engine, 'getValue');
    expect(engine.getValue(id, 0, 0)).toBe(7);
    // two stored cells read (A1 and B2), not 3.5 million positions
    expect(reads.mock.calls.length).toBeLessThanOrEqual(3);
    // the second one does not fit: #NUM!, without walking it
    expect(engine.display(id, 1, 0)).toBe('#NUM!');
    expect(MAX_VISITS).toBe(5_000_000);
  });

  it('cache hits count against the budget', () => {
    // A1 is read through the same one-cell range again and again: after the
    // first read every one is a cache hit, and each still counts
    const repeat = Array(100).fill('$A$1:$A$1').join(',');
    const cells: [number, number, string][] = [[0, 0, '1']];
    for (let r = 1; r < 20; r++) cells.push([r, 1, `=SUM(${repeat})`]);
    const { book, id } = bookWith(cells);
    // each formula: 100 range charges + 100 reads, plus its own read
    const engine = new Engine(book, { budget: 2_000 });
    const values = [];
    for (let r = 1; r < 20; r++) values.push(engine.display(id, r, 1));
    expect(values[0]).toBe('100');
    expect(values).toContain('#NUM!');
    expect(engine.outOfBudget).toBe(true);
  });

  it('a deadline stops further formulas with #NUM!', () => {
    const cells: [number, number, string][] = [];
    for (let r = 0; r < 5000; r++) cells.push([r, 0, `=${r}+1`]);
    const { book, id } = bookWith(cells, 5000);
    // an injected clock that moves on one second per reading; the clock is
    // read at the first read and every 4,096 reads after it
    let clock = 0;
    const engine = new Engine(book, {
      deadline: 1_500,
      now: () => (clock += 1_000),
    });
    const shown = Array.from({ length: 5000 }, (_, r) =>
      engine.display(id, r, 0),
    );
    expect(shown[0]).toBe('1');
    // the 4,096th read (row 4095) reads the clock past the deadline
    expect(shown.indexOf('#NUM!')).toBe(4095);
    expect(shown.slice(4095).every((v) => v === '#NUM!')).toBe(true);
    expect(engine.outOfBudget).toBe(true);
  });

  it('a stack overflow is an error for that read, not a cached value', () => {
    const { book, id } = bookWith([[0, 0, '=1+1']]);
    let reads = 0;
    const cell = book.sheets[0].cells['0:0'];
    Object.defineProperty(cell, 'v', {
      get() {
        reads++;
        if (reads === 1)
          throw new RangeError('Maximum call stack size exceeded');
        return '=1+1';
      },
    });
    const engine = new Engine(book);
    expect(engine.getValue(id, 0, 0)).toBeInstanceOf(FormulaError);
    expect(engine.getValue(id, 0, 0)).toBe(2);
  });

  it('wildcard criteria are charged to the budget and stop at the deadline', () => {
    const cells: [number, number, string][] = [];
    // one match of the pattern over a 32,767-character text is already more
    // work than the whole budget, so three cells are enough
    for (let r = 1; r < 4; r++) cells.push([r, 0, '=REPT("a",32767)']);
    const pattern = '*' + 'a'.repeat(250) + 'b';
    cells.push([0, 0, `=COUNTIF(A2:A4,"${pattern}")`]);
    cells.push([0, 1, `=MATCH("${pattern}",A2:A4,0)`]);
    cells.push([0, 2, `=VLOOKUP("${pattern}",A2:A4,1,FALSE)`]);
    const { book, id } = bookWith(cells);
    for (const col of [0, 1, 2]) {
      // a stopped clock: only the work charged can stop these formulas
      const engine = new Engine(book, { deadline: 1, now: () => 0 });
      expect(engine.display(id, 0, col)).toBe('#NUM!');
      expect(engine.outOfBudget).toBe(true);
    }
    // and with budget to spare, the deadline stops them: each wildcard match
    // charges its work, which reads the clock
    let clock = 0;
    const timed = new Engine(book, {
      budget: Number.MAX_SAFE_INTEGER,
      deadline: 3_500,
      now: () => (clock += 1_000),
    });
    expect(timed.display(id, 0, 0)).toBe('#NUM!');
    expect(timed.outOfBudget).toBe(true);
  });

  it('a spent budget refuses only formulas not yet computed', () => {
    const { book, id } = bookWith(
      [
        [3, 3, '=1+1'],
        [0, 0, '=SUM(B1:ZZ5000,B1:ZZ5000)'],
        [1, 1, 'hello'],
        [2, 2, '5'],
        [5, 0, '=2+2'],
      ],
      5000,
    );
    book.sheets[0].cols = 702;
    const engine = new Engine(book);
    expect(engine.getValue(id, 3, 3)).toBe(2);
    expect(engine.display(id, 0, 0)).toBe('#NUM!');
    expect(engine.outOfBudget).toBe(true);
    // plain values and a result worked out before still show
    expect(engine.display(id, 1, 1)).toBe('hello');
    expect(engine.display(id, 2, 2)).toBe('5');
    expect(engine.display(id, 3, 3)).toBe('2');
    // a formula not computed yet is refused
    expect(engine.display(id, 5, 0)).toBe('#NUM!');
  });

  it('a formula read many times is evaluated once', () => {
    // A1 is a formula; fifty other formulas each read it
    const cells: [number, number, string][] = [[0, 0, '=1+1']];
    for (let r = 1; r <= 50; r++) cells.push([r, 0, '=A1+0']);
    const { book, id } = bookWith(cells);
    const engine = new Engine(book);
    // every formula evaluation parses (or looks up) its text once
    const evaluations = vi.spyOn(engine as any, 'getAst');
    for (let r = 1; r <= 50; r++) expect(engine.getValue(id, r, 0)).toBe(2);
    // 50 readers + A1 once; without the cache A1 would be evaluated 50 times
    expect(evaluations).toHaveBeenCalledTimes(51);
    expect(evaluations.mock.calls.filter(([f]) => f === '=1+1')).toHaveLength(
      1,
    );
  });
});
