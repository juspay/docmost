// Ported from sinha-sahil/mindspace @149db12: src/lib/client/modules/sheets/engine.ts
/**
 * Formula engine for sheet projects — a Google-Sheets-compatible subset.
 *
 * Pure and dependency-free so it runs identically in the browser grid and in
 * the server-side MCP endpoints. Three layers:
 *
 *   1. tokenizer  — turns "=SUM(A1:A3)*2" into a flat token stream.
 *   2. parser     — recursive descent into an AST, honouring spreadsheet
 *                   operator precedence (note: `-2^2` = -4, like Sheets).
 *   3. Engine     — lazily evaluates cells with memoization + cycle detection,
 *                   resolving cell/range references (including cross-sheet
 *                   `Sheet2!A1` and quoted `'My Sheet'!A1`).
 *
 * A computed value is `number | string | boolean | FormulaError`. Errors are
 * first-class values that propagate through operators (so `=1/0+5` is
 * `#DIV/0!`), except where a function deliberately traps them (IFERROR/ISERROR).
 */

import {
  type SheetBook,
  type Sheet,
  cellKey,
  colToLetter,
  parseA1,
  MAX_ROWS,
  MAX_COLS,
} from './model';

// ============================================================
// values + errors
// ============================================================

export class FormulaError {
  constructor(public readonly code: string) {}
  toString(): string {
    return this.code;
  }
}

export const ERR_DIV0 = '#DIV/0!';
export const ERR_VALUE = '#VALUE!';
export const ERR_REF = '#REF!';
export const ERR_NAME = '#NAME?';
export const ERR_NA = '#N/A';
export const ERR_NUM = '#NUM!';
export const ERR_CYCLE = '#CYCLE!';
export const ERR_PARSE = '#ERROR!';
const ERROR_LITERALS = [
  ERR_DIV0,
  ERR_VALUE,
  ERR_REF,
  ERR_NAME,
  ERR_NA,
  ERR_NUM,
  ERR_CYCLE,
];

export type CellValue = number | string | boolean | FormulaError;

export function isError(v: CellValue): boolean {
  return v instanceof FormulaError;
}

/** A rectangular block of values — what a range reference evaluates to. */
class RangeBox {
  constructor(public readonly rows: CellValue[][]) {}
}

type EvalValue = CellValue | RangeBox;

// ============================================================
// tokenizer
// ============================================================

type TokType =
  | 'num'
  | 'str'
  | 'name'
  | 'sheetname' // quoted 'My Sheet'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'colon'
  | 'bang'
  | 'error'; // an error literal such as #REF! (docmost port)

type Token = { type: TokType; value: string };

class ParseError extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isAlpha = (c: string) =>
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    c === '_' ||
    c === '$' ||
    c === '.';

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // an error literal: a deleted reference is written as #REF!
    if (c === '#') {
      const code = ERROR_LITERALS.find((e) => src.startsWith(e, i));
      if (code) {
        tokens.push({ type: 'error', value: code });
        i += code.length;
        continue;
      }
    }
    // double-quoted string literal, "" escapes a quote
    if (c === '"') {
      i++;
      let s = '';
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      tokens.push({ type: 'str', value: s });
      continue;
    }
    // single-quoted sheet name, '' escapes a quote
    if (c === "'") {
      i++;
      let s = '';
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      tokens.push({ type: 'sheetname', value: s });
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let s = '';
      while (i < n && (isDigit(src[i]) || src[i] === '.')) {
        s += src[i++];
      }
      // scientific notation: 1e5, 2.3E-4
      if (
        (src[i] === 'e' || src[i] === 'E') &&
        (isDigit(src[i + 1]) || src[i + 1] === '+' || src[i + 1] === '-')
      ) {
        s += src[i++];
        if (src[i] === '+' || src[i] === '-') {
          s += src[i++];
        }
        while (i < n && isDigit(src[i])) {
          s += src[i++];
        }
      }
      tokens.push({ type: 'num', value: s });
      continue;
    }
    if (isAlpha(c)) {
      let s = '';
      while (i < n && (isAlpha(src[i]) || isDigit(src[i]))) {
        s += src[i++];
      }
      tokens.push({ type: 'name', value: s });
      continue;
    }
    // multi-char operators
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'lparen', value: c });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen', value: c });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ type: 'comma', value: c });
      i++;
      continue;
    }
    if (c === ':') {
      tokens.push({ type: 'colon', value: c });
      i++;
      continue;
    }
    if (c === '!') {
      tokens.push({ type: 'bang', value: c });
      i++;
      continue;
    }
    if ('+-*/^&=<>%'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    // Unknown character — surface as a parse error downstream.
    throw new ParseError(`Unexpected character '${c}'`);
  }
  return tokens;
}

// ============================================================
// AST
// ============================================================

type Node =
  | { t: 'num'; value: number }
  | { t: 'str'; value: string }
  | { t: 'err'; code: string }
  | { t: 'bool'; value: boolean }
  | { t: 'ref'; sheet: string | null; row: number; col: number }
  | {
      t: 'range';
      sheet: string | null;
      r1: number;
      c1: number;
      r2: number;
      c2: number;
    }
  | { t: 'binary'; op: string; left: Node; right: Node }
  | { t: 'unary'; op: string; operand: Node }
  | { t: 'postfix'; op: string; operand: Node }
  | { t: 'call'; name: string; args: Node[] };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }
  private next(): Token | null {
    return this.tokens[this.pos++] ?? null;
  }
  private expect(type: TokType): Token {
    const t = this.next();
    if (!t || t.type !== type) {
      throw new ParseError(`Expected ${type}`);
    }
    return t;
  }

  parse(): Node {
    const node = this.parseComparison();
    if (this.pos < this.tokens.length) {
      throw new ParseError('Unexpected trailing input');
    }
    return node;
  }

  private isOp(values: string[]): boolean {
    const t = this.peek();
    return t !== null && t.type === 'op' && values.includes(t.value);
  }

  private parseComparison(): Node {
    let left = this.parseConcat();
    while (this.isOp(['=', '<>', '<', '>', '<=', '>='])) {
      const op = this.next()!.value;
      const right = this.parseConcat();
      left = { t: 'binary', op, left, right };
    }
    return left;
  }

  private parseConcat(): Node {
    let left = this.parseAdditive();
    while (this.isOp(['&'])) {
      this.next();
      const right = this.parseAdditive();
      left = { t: 'binary', op: '&', left, right };
    }
    return left;
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    while (this.isOp(['+', '-'])) {
      const op = this.next()!.value;
      const right = this.parseMultiplicative();
      left = { t: 'binary', op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    while (this.isOp(['*', '/'])) {
      const op = this.next()!.value;
      const right = this.parseUnary();
      left = { t: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.isOp(['-', '+'])) {
      const op = this.next()!.value;
      return { t: 'unary', op, operand: this.parseUnary() };
    }
    return this.parseExponent();
  }

  private parseExponent(): Node {
    const base = this.parsePostfix();
    if (this.isOp(['^'])) {
      this.next();
      // right-associative; right side via parseUnary so 2^-2 works
      const exp = this.parseUnary();
      return { t: 'binary', op: '^', left: base, right: exp };
    }
    return base;
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    while (this.isOp(['%'])) {
      this.next();
      node = { t: 'postfix', op: '%', operand: node };
    }
    return node;
  }

  private parsePrimary(): Node {
    const t = this.next();
    if (!t) {
      throw new ParseError('Unexpected end of formula');
    }
    if (t.type === 'num') {
      return { t: 'num', value: Number(t.value) };
    }
    if (t.type === 'str') {
      return { t: 'str', value: t.value };
    }
    if (t.type === 'error') {
      return { t: 'err', code: t.value };
    }
    if (t.type === 'lparen') {
      const node = this.parseComparison();
      this.expect('rparen');
      return node;
    }
    if (t.type === 'sheetname') {
      // quoted sheet name must be followed by ! and a ref/range
      this.expect('bang');
      return this.parseRefAfterSheet(t.value);
    }
    if (t.type === 'name') {
      // sheet-qualified reference: Name ! ref
      if (this.peek()?.type === 'bang') {
        this.next();
        return this.parseRefAfterSheet(t.value);
      }
      // function call
      if (this.peek()?.type === 'lparen') {
        return this.parseCall(t.value);
      }
      // boolean literals
      const upper = t.value.toUpperCase();
      if (upper === 'TRUE') {
        return { t: 'bool', value: true };
      }
      if (upper === 'FALSE') {
        return { t: 'bool', value: false };
      }
      // bare cell ref / range on the current sheet
      return this.parseRefOrRange(t.value, null);
    }
    throw new ParseError(`Unexpected token '${t.value}'`);
  }

  private parseCall(name: string): Node {
    this.expect('lparen');
    const args: Node[] = [];
    if (this.peek()?.type !== 'rparen') {
      args.push(this.parseComparison());
      while (this.peek()?.type === 'comma') {
        this.next();
        args.push(this.parseComparison());
      }
    }
    this.expect('rparen');
    return { t: 'call', name: name.toUpperCase(), args };
  }

  private parseRefAfterSheet(sheet: string): Node {
    const t = this.next();
    if (!t || t.type !== 'name') {
      throw new ParseError('Expected reference after sheet name');
    }
    return this.parseRefOrRange(t.value, sheet);
  }

  private parseRefOrRange(first: string, sheet: string | null): Node {
    const a = parseA1(first);
    if (!a) {
      throw new ParseError(`Invalid reference '${first}'`);
    }
    if (this.peek()?.type === 'colon') {
      this.next();
      const tok = this.next();
      if (!tok || tok.type !== 'name') {
        throw new ParseError('Expected reference after :');
      }
      const b = parseA1(tok.value);
      if (!b) {
        throw new ParseError(`Invalid reference '${tok.value}'`);
      }
      return {
        t: 'range',
        sheet,
        r1: Math.min(a.row, b.row),
        c1: Math.min(a.col, b.col),
        r2: Math.max(a.row, b.row),
        c2: Math.max(a.col, b.col),
      };
    }
    return { t: 'ref', sheet, row: a.row, col: a.col };
  }
}

// ============================================================
// number / value coercion
// ============================================================

/** Parse a stored literal string into number | boolean | string. */
export function parseLiteral(raw: string): CellValue {
  const s = raw.trim();
  if (s === '') {
    return '';
  }
  const upper = s.toUpperCase();
  if (upper === 'TRUE') {
    return true;
  }
  if (upper === 'FALSE') {
    return false;
  }
  const num = parseNumberLiteral(s);
  if (num !== null) {
    return num;
  }
  return raw;
}

/**
 * Lenient numeric literal: plain numbers, scientific, thousands separators,
 * a leading currency sign, or a trailing percent. Returns null when the string
 * is not a number (so it stays text).
 */
export function parseNumberLiteral(s: string): number | null {
  let str = s.trim();
  if (str === '') {
    return null;
  }
  let percent = false;
  if (str.endsWith('%')) {
    percent = true;
    str = str.slice(0, -1).trim();
  }
  let sign = 1;
  // leading currency symbol
  str = str.replace(/^([$€£¥])\s*/, '');
  // parenthesised negatives: (123) → -123
  if (/^\(.*\)$/.test(str)) {
    sign = -1;
    str = str.slice(1, -1).trim();
    str = str.replace(/^([$€£¥])\s*/, '');
  }
  // thousands separators between digits only
  if (/^[+-]?(\d{1,3}(,\d{3})+)(\.\d+)?$/.test(str)) {
    str = str.replace(/,/g, '');
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(str)) {
    return null;
  }
  const num = Number(str);
  if (!Number.isFinite(num)) {
    return null;
  }
  return sign * num * (percent ? 0.01 : 1);
}

export function toNumber(v: CellValue): number | FormulaError {
  if (v instanceof FormulaError) {
    return v;
  }
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'boolean') {
    return v ? 1 : 0;
  }
  if (v === '') {
    return 0;
  }
  const num = parseNumberLiteral(v);
  return num === null ? new FormulaError(ERR_VALUE) : num;
}

export function toText(v: CellValue): string {
  if (v instanceof FormulaError) {
    return v.code;
  }
  if (typeof v === 'number') {
    return numberToString(v);
  }
  if (typeof v === 'boolean') {
    return v ? 'TRUE' : 'FALSE';
  }
  return v;
}

export function toBoolean(v: CellValue): boolean | FormulaError {
  if (v instanceof FormulaError) {
    return v;
  }
  if (typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'number') {
    return v !== 0;
  }
  if (v === '') {
    return false;
  }
  const upper = v.trim().toUpperCase();
  if (upper === 'TRUE') {
    return true;
  }
  if (upper === 'FALSE') {
    return false;
  }
  const num = parseNumberLiteral(v);
  if (num !== null) {
    return num !== 0;
  }
  return new FormulaError(ERR_VALUE);
}

/** Render a JS number without scientific notation for typical magnitudes. */
function numberToString(n: number): string {
  if (!Number.isFinite(n)) {
    return ERR_NUM;
  }
  if (Number.isInteger(n)) {
    return String(n);
  }
  // Trim float noise to ~12 significant digits, then drop trailing zeros.
  let s = n.toPrecision(12);
  if (s.includes('e') || s.includes('E')) {
    s = String(n);
  }
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

/**
 * Three-way compare for spreadsheet semantics. Numbers compare numerically,
 * everything else as case-insensitive text. Booleans sort above text/numbers
 * (matching Sheets). Blank coerces to 0 / "".
 */
function compareValues(a: CellValue, b: CellValue): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    if (typeof a === 'boolean' && typeof b === 'boolean') {
      return (a ? 1 : 0) - (b ? 1 : 0);
    }
    // boolean vs non-boolean: booleans rank higher
    return typeof a === 'boolean' ? 1 : -1;
  }
  if (typeof a === 'number' || typeof b === 'number') {
    // number vs text: try to coerce the text to a number, else number < text.
    // A blank ('') coerces to 0 here, consistent with the arithmetic path.
    const at =
      typeof a === 'number' ? a : a === '' ? 0 : parseNumberLiteral(String(a));
    const bt =
      typeof b === 'number' ? b : b === '' ? 0 : parseNumberLiteral(String(b));
    if (at !== null && bt !== null) {
      return at < bt ? -1 : at > bt ? 1 : 0;
    }
    return typeof a === 'number' ? -1 : 1;
  }
  const as = String(a).toLowerCase();
  const bs = String(b).toLowerCase();
  return as < bs ? -1 : as > bs ? 1 : 0;
}

// ============================================================
// Engine
// ============================================================

// Guards added in the docmost port: the engine also runs on the server, so no
// cell may crash or stall it.
/** Longest text a cell or function may produce (Excel's cell limit). */
export const MAX_TEXT_LENGTH = 32_767;
/** Nested evaluations before the engine unwinds and resumes from the deepest cell. */
const MAX_DEPTH = 400;
/**
 * Cell reads one Engine performs (cache hits and every position of a range
 * included) before further formulas give #NUM!.
 */
export const MAX_VISITS = 5_000_000;
/** How often (in reads) the deadline is checked. */
const DEADLINE_CHECK_EVERY = 4096;

export type EngineOptions = {
  /** a time (from `now`) past which further formulas give #NUM! */
  deadline?: number;
  /** the clock the deadline is read from; Date.now by default */
  now?: () => number;
  /** cell reads before formulas give #NUM!; MAX_VISITS by default */
  budget?: number;
};

/** Thrown inside a formula whose work ran past the budget or the deadline. */
class OutOfBudget {}

class DepthExceeded {
  constructor(
    readonly sheetId: string,
    readonly row: number,
    readonly col: number,
  ) {}
}

function textTooLong(length: number): boolean {
  return length > MAX_TEXT_LENGTH;
}

export class Engine {
  private visits = 0;
  private exhausted = false;
  private readonly deadline: number | null;
  private readonly now: () => number;
  private readonly budget: number;
  /** per tab: row → columns holding a cell, so ranges read only stored cells */
  private occupied = new Map<string, Map<number, number[]>>();
  private byId = new Map<string, Sheet>();
  private byName = new Map<string, Sheet>();
  private cache = new Map<string, CellValue>();
  private stack = new Set<string>();
  private astCache = new Map<string, Node | FormulaError>();

  constructor(book: SheetBook, options: EngineOptions = {}) {
    this.deadline =
      typeof options.deadline === 'number' ? options.deadline : null;
    this.now = options.now ?? Date.now;
    this.budget =
      typeof options.budget === 'number' ? options.budget : MAX_VISITS;
    for (const s of book.sheets) {
      this.byId.set(s.id, s);
      this.byName.set(s.name.toLowerCase(), s);
    }
  }

  /** True once the work budget or the deadline ran out: some formulas show #NUM!. */
  get outOfBudget(): boolean {
    return this.exhausted;
  }

  /** Charges `count` reads; true once the budget or the deadline is spent. */
  private spend(count: number): boolean {
    if (this.exhausted) {
      return true;
    }
    const before = this.visits;
    this.visits += count;
    if (this.visits > this.budget) {
      this.exhausted = true;
    } else if (
      this.deadline !== null &&
      (count > 1 ||
        before % DEADLINE_CHECK_EVERY === 0 ||
        Math.floor(before / DEADLINE_CHECK_EVERY) !==
          Math.floor(this.visits / DEADLINE_CHECK_EVERY)) &&
      this.now() > this.deadline
    ) {
      this.exhausted = true;
    }
    return this.exhausted;
  }

  private occupiedRows(sheet: Sheet): Map<number, number[]> {
    let rows = this.occupied.get(sheet.id);
    if (!rows) {
      rows = new Map();
      for (const key of Object.keys(sheet.cells)) {
        const sep = key.indexOf(':');
        const r = Number(key.slice(0, sep));
        const c = Number(key.slice(sep + 1));
        if (!Number.isInteger(r) || !Number.isInteger(c)) {
          continue;
        }
        const cols = rows.get(r);
        if (cols) {
          cols.push(c);
        } else {
          rows.set(r, [c]);
        }
      }
      this.occupied.set(sheet.id, rows);
    }
    return rows;
  }

  private resolveSheet(
    ref: string | null,
    currentSheetId: string,
  ): Sheet | null {
    if (ref === null) {
      return this.byId.get(currentSheetId) ?? null;
    }
    return this.byName.get(ref.toLowerCase()) ?? null;
  }

  /** Computed value for a cell. Memoized; detects reference cycles. */
  getValue(sheetId: string, row: number, col: number): CellValue {
    if (this.stack.size > 0) {
      return this.compute(sheetId, row, col);
    }
    // A chain deeper than MAX_DEPTH unwinds; the deepest cell is computed on
    // its own first, then the chain is retried with that cell cached.
    const pending: DepthExceeded[] = [];
    const pendingKeys = new Set<string>();
    for (;;) {
      const target = pending[pending.length - 1];
      try {
        if (!target) {
          return this.compute(sheetId, row, col);
        }
        this.compute(target.sheetId, target.row, target.col);
        pending.pop();
        pendingKeys.delete(`${target.sheetId}!${target.row}:${target.col}`);
      } catch (err) {
        if (err instanceof RangeError) {
          // the JavaScript stack ran out: an error now, not a cached value
          return new FormulaError(ERR_NUM);
        }
        if (!(err instanceof DepthExceeded)) {
          throw err;
        }
        const key = `${err.sheetId}!${err.row}:${err.col}`;
        if (pendingKeys.has(key)) {
          // a cell waiting on itself through a chain longer than MAX_DEPTH
          this.cache.set(key, new FormulaError(ERR_CYCLE));
          continue;
        }
        pending.push(err);
        pendingKeys.add(key);
      }
    }
  }

  private compute(sheetId: string, row: number, col: number): CellValue {
    const key = `${sheetId}!${row}:${col}`;
    // every read counts, but a spent budget refuses only formulas not yet
    // computed: plain values and results already worked out still show
    this.spend(1);
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }
    if (this.stack.has(key)) {
      return new FormulaError(ERR_CYCLE);
    }
    const sheet = this.byId.get(sheetId);
    if (!sheet) {
      return new FormulaError(ERR_REF);
    }
    const raw = sheet.cells[cellKey(row, col)]?.v ?? '';
    if (raw === '' || raw[0] !== '=') {
      const value = parseLiteral(raw);
      this.cache.set(key, value);
      return value;
    }
    if (this.exhausted) {
      const refused = new FormulaError(ERR_NUM);
      this.cache.set(key, refused);
      return refused;
    }
    if (this.stack.size >= MAX_DEPTH) {
      throw new DepthExceeded(sheetId, row, col);
    }
    this.stack.add(key);
    let value: CellValue;
    try {
      const ast = this.getAst(raw);
      if (ast instanceof FormulaError) {
        value = ast;
      } else {
        const result = this.evalNode(ast, sheetId);
        value =
          result instanceof RangeBox ? this.rangeToScalar(result) : result;
      }
    } catch (err) {
      if (err instanceof DepthExceeded || err instanceof RangeError) {
        throw err;
      }
      value = new FormulaError(
        err instanceof OutOfBudget ? ERR_NUM : ERR_PARSE,
      );
    } finally {
      this.stack.delete(key);
    }
    // an overflow or a NaN is an error, not Infinity or NaN on screen
    if (typeof value === 'number' && !Number.isFinite(value)) {
      value = new FormulaError(ERR_NUM);
    }
    if (typeof value === 'string' && textTooLong(value.length)) {
      value = new FormulaError(ERR_VALUE);
    }
    this.cache.set(key, value);
    return value;
  }

  private getAst(formula: string): Node | FormulaError {
    if (this.astCache.has(formula)) {
      return this.astCache.get(formula)!;
    }
    let result: Node | FormulaError;
    try {
      const tokens = tokenize(formula.slice(1)); // drop leading '='
      result = new Parser(tokens).parse();
    } catch {
      result = new FormulaError(ERR_PARSE);
    }
    this.astCache.set(formula, result);
    return result;
  }

  /** A range used in scalar position collapses to its top-left cell. */
  private rangeToScalar(r: RangeBox): CellValue {
    const row = r.rows[0];
    if (!row || row.length === 0) {
      return new FormulaError(ERR_REF);
    }
    return row[0];
  }

  private evalNode(node: Node, sheetId: string): EvalValue {
    switch (node.t) {
      case 'num':
        return node.value;
      case 'str':
        return node.value;
      case 'err':
        return new FormulaError(node.code);
      case 'bool':
        return node.value;
      case 'ref': {
        const sheet = this.resolveSheet(node.sheet, sheetId);
        if (!sheet || node.row >= MAX_ROWS || node.col >= MAX_COLS) {
          return new FormulaError(ERR_REF);
        }
        return this.getValue(sheet.id, node.row, node.col);
      }
      case 'range': {
        const sheet = this.resolveSheet(node.sheet, sheetId);
        if (!sheet || node.r2 >= MAX_ROWS || node.c2 >= MAX_COLS) {
          return new FormulaError(ERR_REF);
        }
        const width = node.c2 - node.c1 + 1;
        // every position counts against the budget before any is walked
        if (this.spend((node.r2 - node.r1 + 1) * width)) {
          return new FormulaError(ERR_NUM);
        }
        const occupied = this.occupiedRows(sheet);
        const rows: CellValue[][] = [];
        for (let r = node.r1; r <= node.r2; r++) {
          const line: CellValue[] = new Array(width).fill('');
          for (const c of occupied.get(r) ?? []) {
            if (c >= node.c1 && c <= node.c2) {
              line[c - node.c1] = this.getValue(sheet.id, r, c);
            }
          }
          rows.push(line);
        }
        return new RangeBox(rows);
      }
      case 'unary': {
        const operand = this.scalar(this.evalNode(node.operand, sheetId));
        const num = toNumber(operand);
        if (num instanceof FormulaError) {
          return num;
        }
        return node.op === '-' ? -num : num;
      }
      case 'postfix': {
        const operand = this.scalar(this.evalNode(node.operand, sheetId));
        const num = toNumber(operand);
        if (num instanceof FormulaError) {
          return num;
        }
        return num / 100;
      }
      case 'binary':
        return this.evalBinary(node, sheetId);
      case 'call':
        return this.evalCall(node, sheetId);
    }
  }

  private scalar(v: EvalValue): CellValue {
    if (v instanceof RangeBox) {
      return this.rangeToScalar(v);
    }
    return v;
  }

  private evalBinary(
    node: Extract<Node, { t: 'binary' }>,
    sheetId: string,
  ): EvalValue {
    const left = this.scalar(this.evalNode(node.left, sheetId));
    const right = this.scalar(this.evalNode(node.right, sheetId));
    if (left instanceof FormulaError) {
      return left;
    }
    if (right instanceof FormulaError) {
      return right;
    }
    const op = node.op;
    if (op === '&') {
      const l = toText(left);
      const r = toText(right);
      return textTooLong(l.length + r.length)
        ? new FormulaError(ERR_VALUE)
        : l + r;
    }
    if (
      op === '=' ||
      op === '<>' ||
      op === '<' ||
      op === '>' ||
      op === '<=' ||
      op === '>='
    ) {
      const cmp = compareValues(left, right);
      switch (op) {
        case '=':
          return cmp === 0;
        case '<>':
          return cmp !== 0;
        case '<':
          return cmp < 0;
        case '>':
          return cmp > 0;
        case '<=':
          return cmp <= 0;
        default:
          return cmp >= 0;
      }
    }
    const a = toNumber(left);
    if (a instanceof FormulaError) {
      return a;
    }
    const b = toNumber(right);
    if (b instanceof FormulaError) {
      return b;
    }
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return b === 0 ? new FormulaError(ERR_DIV0) : a / b;
      case '^': {
        const p = Math.pow(a, b);
        return Number.isFinite(p) ? p : new FormulaError(ERR_NUM);
      }
      default:
        return new FormulaError(ERR_PARSE);
    }
  }

  // ----- function dispatch -----

  private evalCall(
    node: Extract<Node, { t: 'call' }>,
    sheetId: string,
  ): EvalValue {
    const fn = FUNCTIONS[node.name];
    if (!fn) {
      return new FormulaError(ERR_NAME);
    }
    const ctx: FnCtx = {
      sheetId,
      spend: (work) => {
        if (this.spend(work)) throw new OutOfBudget();
      },
      evalScalar: (n) => this.scalar(this.evalNode(n, sheetId)),
      evalNode: (n) => this.evalNode(n, sheetId),
      flatten: (n) => this.flatten(n, sheetId),
    };
    return fn(node.args, ctx);
  }

  /** Flatten a node into a list of scalar values (ranges expand row-major). */
  private flatten(node: Node, sheetId: string): CellValue[] {
    const v = this.evalNode(node, sheetId);
    if (v instanceof RangeBox) {
      const out: CellValue[] = [];
      for (const row of v.rows) {
        for (const cell of row) {
          out.push(cell);
        }
      }
      return out;
    }
    return [v];
  }

  /** Display string for a cell, honouring its number format. */
  display(sheetId: string, row: number, col: number): string {
    const sheet = this.byId.get(sheetId);
    const raw = sheet?.cells[cellKey(row, col)]?.v ?? '';
    if (raw === '') {
      return '';
    }
    const value = this.getValue(sheetId, row, col);
    const f = sheet?.cells[cellKey(row, col)]?.f;
    const fmt = f?.numFmt ?? null;
    const decimals = typeof f?.decimals === 'number' ? f.decimals : null;
    return formatValue(value, fmt, decimals);
  }
}

// ============================================================
// function library
// ============================================================

type FnCtx = {
  sheetId: string;
  /** charges work to the engine's budget; throws OutOfBudget once it is spent */
  spend: (work: number) => void;
  evalScalar: (node: Node) => CellValue;
  evalNode: (node: Node) => EvalValue;
  flatten: (node: Node) => CellValue[];
};

type Fn = (args: Node[], ctx: FnCtx) => EvalValue;

/** Collect numbers from args, ignoring blanks/text (SUM-style coercion). */
function collectNumbers(args: Node[], ctx: FnCtx): number[] | FormulaError {
  const out: number[] = [];
  for (const arg of args) {
    const values = ctx.flatten(arg);
    for (const v of values) {
      if (v instanceof FormulaError) {
        return v;
      }
      if (typeof v === 'number') {
        out.push(v);
      } else if (typeof v === 'boolean') {
        out.push(v ? 1 : 0);
      } else if (typeof v === 'string' && v.trim() !== '') {
        // Literal numeric arguments count; stray text in ranges is ignored.
        const num = parseNumberLiteral(v);
        if (num !== null) {
          out.push(num);
        }
      }
    }
  }
  return out;
}

function num1(args: Node[], ctx: FnCtx): number | FormulaError {
  if (args.length < 1) {
    return new FormulaError(ERR_NA);
  }
  return toNumber(ctx.evalScalar(args[0]));
}

/** Matches a value against a criterion like ">5", "<=3", "apple", "*x*". */
function matchCriterion(
  value: CellValue,
  criterion: CellValue,
  ctx: FnCtx,
): boolean {
  ctx.spend(1);
  if (value instanceof FormulaError) {
    return false;
  }
  if (typeof criterion === 'number' || typeof criterion === 'boolean') {
    return compareValues(value, criterion) === 0;
  }
  const cStr = typeof criterion === 'string' ? criterion : toText(criterion);
  const opMatch = /^(<=|>=|<>|<|>|=)(.*)$/.exec(cStr.trim());
  if (opMatch) {
    const op = opMatch[1];
    const rest = opMatch[2].trim();
    const restNum = parseNumberLiteral(rest);
    const target: CellValue = restNum !== null ? restNum : rest;
    const cmp = compareValues(value, target);
    switch (op) {
      case '=':
        return cmp === 0;
      case '<>':
        return cmp !== 0;
      case '<':
        return cmp < 0;
      case '>':
        return cmp > 0;
      case '<=':
        return cmp <= 0;
      default:
        return cmp >= 0;
    }
  }
  // plain value: wildcard text match (* and ?) or direct equality
  if (cStr.includes('*') || cStr.includes('?')) {
    const text = toText(value);
    // the match is at worst text length x pattern length steps
    ctx.spend(text.length * Math.min(cStr.length, MAX_CRITERION_LENGTH));
    return wildcardMatch(cStr, text);
  }
  return compareValues(value, cStr) === 0;
}

/** Excel's limit on a criterion's length; longer ones match nothing. */
const MAX_CRITERION_LENGTH = 255;

/**
 * `*` and `?` wildcards (`~` escapes them), case-insensitive. A linear
 * two-pointer match: the regular expression this replaced backtracked
 * exponentially on patterns such as `*a*a*a…b` (docmost port change).
 */
/** `steps`, when given, counts loop steps (tests check the bound). */
export function wildcardMatch(
  pattern: string,
  text: string,
  steps?: { n: number },
): boolean {
  if (pattern.length > MAX_CRITERION_LENGTH) {
    return false;
  }
  type Tok = { any: boolean; one: boolean; ch: string };
  const toks: Tok[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '~' && (pattern[i + 1] === '*' || pattern[i + 1] === '?')) {
      toks.push({ any: false, one: false, ch: pattern[++i].toLowerCase() });
    } else if (c === '*') {
      toks.push({ any: true, one: false, ch: '' });
    } else if (c === '?') {
      toks.push({ any: false, one: true, ch: '' });
    } else {
      toks.push({ any: false, one: false, ch: c.toLowerCase() });
    }
  }
  const s = text.toLowerCase();
  let t = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (t < s.length) {
    if (steps) steps.n++;
    const tok = toks[p];
    if (tok && !tok.any && (tok.one || tok.ch === s[t])) {
      t++;
      p++;
    } else if (tok && tok.any) {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < toks.length && toks[p].any) {
    p++;
  }
  return p === toks.length;
}

// date serial helpers (Sheets/Excel epoch = 1899-12-30)
const EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;
function dateToSerial(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY_MS);
}
function serialToDate(serial: number): Date {
  // Keep the fractional (time-of-day) component intact — rounding would
  // collapse times to midnight and bump afternoon serials to the next day.
  return new Date(EPOCH + serial * DAY_MS);
}

const FUNCTIONS: Record<string, Fn> = {
  // ---- math / aggregation ----
  SUM: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    return nums instanceof FormulaError
      ? nums
      : nums.reduce((a, b) => a + b, 0);
  },
  PRODUCT: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (nums instanceof FormulaError) {
      return nums;
    }
    return nums.length === 0 ? 0 : nums.reduce((a, b) => a * b, 1);
  },
  AVERAGE: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (nums instanceof FormulaError) {
      return nums;
    }
    return nums.length === 0
      ? new FormulaError(ERR_DIV0)
      : nums.reduce((a, b) => a + b, 0) / nums.length;
  },
  AVG: (args, ctx) => FUNCTIONS.AVERAGE(args, ctx),
  MIN: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (nums instanceof FormulaError) {
      return nums;
    }
    // a loop: spreading 150,000 numbers into arguments overflows the stack
    return nums.length === 0 ? 0 : nums.reduce((a, b) => (b < a ? b : a));
  },
  MAX: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (nums instanceof FormulaError) {
      return nums;
    }
    return nums.length === 0 ? 0 : nums.reduce((a, b) => (b > a ? b : a));
  },
  MEDIAN: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (nums instanceof FormulaError) {
      return nums;
    }
    if (nums.length === 0) {
      return new FormulaError(ERR_NUM);
    }
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  },
  COUNT: (args, ctx) => {
    let count = 0;
    for (const arg of args) {
      for (const v of ctx.flatten(arg)) {
        if (typeof v === 'number') {
          count++;
        } else if (
          typeof v === 'string' &&
          v.trim() !== '' &&
          parseNumberLiteral(v) !== null
        ) {
          count++;
        }
      }
    }
    return count;
  },
  COUNTA: (args, ctx) => {
    let count = 0;
    for (const arg of args) {
      for (const v of ctx.flatten(arg)) {
        if (!(typeof v === 'string' && v === '')) {
          count++;
        }
      }
    }
    return count;
  },
  COUNTBLANK: (args, ctx) => {
    let count = 0;
    for (const arg of args) {
      for (const v of ctx.flatten(arg)) {
        if (typeof v === 'string' && v === '') {
          count++;
        }
      }
    }
    return count;
  },
  ABS: (args, ctx) => mathUnary(args, ctx, Math.abs),
  SQRT: (args, ctx) =>
    mathUnary(args, ctx, (n) =>
      n < 0 ? new FormulaError(ERR_NUM) : Math.sqrt(n),
    ),
  INT: (args, ctx) => mathUnary(args, ctx, Math.floor),
  SIGN: (args, ctx) => mathUnary(args, ctx, Math.sign),
  EXP: (args, ctx) => mathUnary(args, ctx, Math.exp),
  LN: (args, ctx) =>
    mathUnary(args, ctx, (n) =>
      n <= 0 ? new FormulaError(ERR_NUM) : Math.log(n),
    ),
  LOG10: (args, ctx) =>
    mathUnary(args, ctx, (n) =>
      n <= 0 ? new FormulaError(ERR_NUM) : Math.log10(n),
    ),
  LOG: (args, ctx) => {
    const n = num1([args[0]], ctx);
    if (n instanceof FormulaError) {
      return n;
    }
    const base = args.length > 1 ? toNumber(ctx.evalScalar(args[1])) : 10;
    if (base instanceof FormulaError) {
      return base;
    }
    if (n <= 0 || base <= 0 || base === 1) {
      return new FormulaError(ERR_NUM);
    }
    return Math.log(n) / Math.log(base);
  },
  POWER: (args, ctx) => {
    const a = num1([args[0]], ctx);
    if (a instanceof FormulaError) {
      return a;
    }
    const b = args[1] ? toNumber(ctx.evalScalar(args[1])) : 0;
    if (b instanceof FormulaError) {
      return b;
    }
    const p = Math.pow(a, b);
    return Number.isFinite(p) ? p : new FormulaError(ERR_NUM);
  },
  MOD: (args, ctx) => {
    const a = num1([args[0]], ctx);
    if (a instanceof FormulaError) {
      return a;
    }
    const b = args[1] ? toNumber(ctx.evalScalar(args[1])) : 0;
    if (b instanceof FormulaError) {
      return b;
    }
    if (b === 0) {
      return new FormulaError(ERR_DIV0);
    }
    return a - b * Math.floor(a / b);
  },
  ROUND: (args, ctx) => roundFn(args, ctx, 'round'),
  ROUNDUP: (args, ctx) => roundFn(args, ctx, 'up'),
  ROUNDDOWN: (args, ctx) => roundFn(args, ctx, 'down'),
  CEILING: (args, ctx) => {
    const a = num1([args[0]], ctx);
    if (a instanceof FormulaError) {
      return a;
    }
    const factor = args[1] ? toNumber(ctx.evalScalar(args[1])) : 1;
    if (factor instanceof FormulaError) {
      return factor;
    }
    if (factor === 0) {
      return 0;
    }
    return Math.ceil(a / factor) * factor;
  },
  FLOOR: (args, ctx) => {
    const a = num1([args[0]], ctx);
    if (a instanceof FormulaError) {
      return a;
    }
    const factor = args[1] ? toNumber(ctx.evalScalar(args[1])) : 1;
    if (factor instanceof FormulaError) {
      return factor;
    }
    if (factor === 0) {
      return 0;
    }
    return Math.floor(a / factor) * factor;
  },
  TRUNC: (args, ctx) => {
    const n = num1([args[0]], ctx);
    if (n instanceof FormulaError) {
      return n;
    }
    const digits = args[1] ? toNumber(ctx.evalScalar(args[1])) : 0;
    if (digits instanceof FormulaError) {
      return digits;
    }
    const factor = Math.pow(10, Math.floor(digits));
    return Math.trunc(n * factor) / factor;
  },
  PI: () => Math.PI,
  RAND: () => Math.random(),
  RANDBETWEEN: (args, ctx) => {
    const lo = num1([args[0]], ctx);
    if (lo instanceof FormulaError) {
      return lo;
    }
    const hi = args[1] ? toNumber(ctx.evalScalar(args[1])) : 0;
    if (hi instanceof FormulaError) {
      return hi;
    }
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  },
  SUMPRODUCT: (args, ctx) => {
    const arrays = args.map((a) => ctx.flatten(a));
    const len = arrays[0]?.length ?? 0;
    let total = 0;
    for (let i = 0; i < len; i++) {
      let prod = 1;
      for (const arr of arrays) {
        const n = toNumber(arr[i] ?? 0);
        if (n instanceof FormulaError) {
          return n;
        }
        prod *= n;
      }
      total += prod;
    }
    return total;
  },

  // ---- conditional aggregation ----
  SUMIF: (args, ctx) => sumCountIf(args, ctx, 'sum'),
  COUNTIF: (args, ctx) => sumCountIf(args, ctx, 'count'),
  AVERAGEIF: (args, ctx) => sumCountIf(args, ctx, 'avg'),

  // ---- logical ----
  IF: (args, ctx) => {
    if (args.length < 2) {
      return new FormulaError(ERR_NA);
    }
    const cond = toBoolean(ctx.evalScalar(args[0]));
    if (cond instanceof FormulaError) {
      return cond;
    }
    if (cond) {
      return ctx.evalNode(args[1]);
    }
    return args.length > 2 ? ctx.evalNode(args[2]) : false;
  },
  IFS: (args, ctx) => {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const cond = toBoolean(ctx.evalScalar(args[i]));
      if (cond instanceof FormulaError) {
        return cond;
      }
      if (cond) {
        return ctx.evalNode(args[i + 1]);
      }
    }
    return new FormulaError(ERR_NA);
  },
  IFERROR: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    if (v instanceof FormulaError) {
      return args.length > 1 ? ctx.evalNode(args[1]) : '';
    }
    return v;
  },
  IFNA: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    if (v instanceof FormulaError && v.code === ERR_NA) {
      return args.length > 1 ? ctx.evalNode(args[1]) : '';
    }
    return v;
  },
  AND: (args, ctx) => {
    let any = false;
    for (const arg of args) {
      for (const v of ctx.flatten(arg)) {
        if (typeof v === 'string' && v === '') {
          continue;
        }
        const b = toBoolean(v);
        if (b instanceof FormulaError) {
          return b;
        }
        any = true;
        if (!b) {
          return false;
        }
      }
    }
    return any ? true : new FormulaError(ERR_VALUE);
  },
  OR: (args, ctx) => {
    let any = false;
    for (const arg of args) {
      for (const v of ctx.flatten(arg)) {
        if (typeof v === 'string' && v === '') {
          continue;
        }
        const b = toBoolean(v);
        if (b instanceof FormulaError) {
          return b;
        }
        any = true;
        if (b) {
          return true;
        }
      }
    }
    return any ? false : new FormulaError(ERR_VALUE);
  },
  XOR: (args, ctx) => {
    let count = 0;
    for (const arg of args) {
      for (const v of ctx.flatten(arg)) {
        if (typeof v === 'string' && v === '') {
          continue;
        }
        const b = toBoolean(v);
        if (b instanceof FormulaError) {
          return b;
        }
        if (b) {
          count++;
        }
      }
    }
    return count % 2 === 1;
  },
  NOT: (args, ctx) => {
    const b = toBoolean(ctx.evalScalar(args[0]));
    return b instanceof FormulaError ? b : !b;
  },
  TRUE: () => true,
  FALSE: () => false,

  // ---- information ----
  ISBLANK: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    return typeof v === 'string' && v === '';
  },
  ISNUMBER: (args, ctx) => typeof ctx.evalScalar(args[0]) === 'number',
  ISTEXT: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    return typeof v === 'string' && v !== '';
  },
  ISLOGICAL: (args, ctx) => typeof ctx.evalScalar(args[0]) === 'boolean',
  ISERROR: (args, ctx) => ctx.evalScalar(args[0]) instanceof FormulaError,
  ISERR: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    return v instanceof FormulaError && v.code !== ERR_NA;
  },
  ISNA: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    return v instanceof FormulaError && v.code === ERR_NA;
  },
  NA: () => new FormulaError(ERR_NA),

  // ---- text ----
  LEN: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    return v instanceof FormulaError ? v : toText(v).length;
  },
  LEFT: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    if (v instanceof FormulaError) {
      return v;
    }
    const n = args[1] ? toNumber(ctx.evalScalar(args[1])) : 1;
    if (n instanceof FormulaError) {
      return n;
    }
    return toText(v).slice(0, Math.max(0, Math.floor(n)));
  },
  RIGHT: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    if (v instanceof FormulaError) {
      return v;
    }
    const n = args[1] ? toNumber(ctx.evalScalar(args[1])) : 1;
    if (n instanceof FormulaError) {
      return n;
    }
    const s = toText(v);
    const k = Math.max(0, Math.floor(n));
    return k === 0 ? '' : s.slice(Math.max(0, s.length - k));
  },
  MID: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    if (v instanceof FormulaError) {
      return v;
    }
    const start = toNumber(ctx.evalScalar(args[1]));
    if (start instanceof FormulaError) {
      return start;
    }
    const len = toNumber(ctx.evalScalar(args[2]));
    if (len instanceof FormulaError) {
      return len;
    }
    const s = toText(v);
    const from = Math.max(0, Math.floor(start) - 1);
    return s.slice(from, from + Math.max(0, Math.floor(len)));
  },
  UPPER: (args, ctx) => textUnary(args, ctx, (s) => s.toUpperCase()),
  LOWER: (args, ctx) => textUnary(args, ctx, (s) => s.toLowerCase()),
  TRIM: (args, ctx) =>
    textUnary(args, ctx, (s) => s.replace(/\s+/g, ' ').trim()),
  PROPER: (args, ctx) =>
    textUnary(args, ctx, (s) =>
      s
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace(/\B\w/g, (c) => c.toLowerCase()),
    ),
  CONCAT: (args, ctx) => concat(args, ctx),
  CONCATENATE: (args, ctx) => concat(args, ctx),
  TEXTJOIN: (args, ctx) => {
    const delim = toText(ctx.evalScalar(args[0]));
    const ignoreEmpty = args[1] ? toBoolean(ctx.evalScalar(args[1])) : true;
    if (ignoreEmpty instanceof FormulaError) {
      return ignoreEmpty;
    }
    const parts: string[] = [];
    let length = 0;
    for (let i = 2; i < args.length; i++) {
      for (const v of ctx.flatten(args[i])) {
        if (v instanceof FormulaError) {
          return v;
        }
        const s = toText(v);
        if (ignoreEmpty && s === '') {
          continue;
        }
        length += s.length + (parts.length > 0 ? delim.length : 0);
        if (textTooLong(length)) {
          return new FormulaError(ERR_VALUE);
        }
        parts.push(s);
      }
    }
    return parts.join(delim);
  },
  SUBSTITUTE: (args, ctx) => {
    const s = toText(ctx.evalScalar(args[0]));
    const find = toText(ctx.evalScalar(args[1]));
    const repl = toText(ctx.evalScalar(args[2]));
    if (find === '') {
      return s;
    }
    if (args.length > 3) {
      const which = toNumber(ctx.evalScalar(args[3]));
      if (which instanceof FormulaError) {
        return which;
      }
      let count = 0;
      let from = 0;
      let idx = s.indexOf(find, from);
      while (idx !== -1) {
        count++;
        if (count === Math.floor(which)) {
          return s.slice(0, idx) + repl + s.slice(idx + find.length);
        }
        from = idx + find.length;
        idx = s.indexOf(find, from);
      }
      return s;
    }
    const pieces = s.split(find);
    if (
      textTooLong(s.length + (pieces.length - 1) * (repl.length - find.length))
    ) {
      return new FormulaError(ERR_VALUE);
    }
    return pieces.join(repl);
  },
  REPLACE: (args, ctx) => {
    const s = toText(ctx.evalScalar(args[0]));
    const start = toNumber(ctx.evalScalar(args[1]));
    if (start instanceof FormulaError) {
      return start;
    }
    const len = toNumber(ctx.evalScalar(args[2]));
    if (len instanceof FormulaError) {
      return len;
    }
    const repl = toText(ctx.evalScalar(args[3]));
    const from = Math.max(0, Math.floor(start) - 1);
    return (
      s.slice(0, from) + repl + s.slice(from + Math.max(0, Math.floor(len)))
    );
  },
  FIND: (args, ctx) => {
    const find = toText(ctx.evalScalar(args[0]));
    const within = toText(ctx.evalScalar(args[1]));
    const start = args[2] ? toNumber(ctx.evalScalar(args[2])) : 1;
    if (start instanceof FormulaError) {
      return start;
    }
    const idx = within.indexOf(find, Math.max(0, Math.floor(start) - 1));
    return idx === -1 ? new FormulaError(ERR_VALUE) : idx + 1;
  },
  SEARCH: (args, ctx) => {
    const find = toText(ctx.evalScalar(args[0])).toLowerCase();
    const within = toText(ctx.evalScalar(args[1])).toLowerCase();
    const start = args[2] ? toNumber(ctx.evalScalar(args[2])) : 1;
    if (start instanceof FormulaError) {
      return start;
    }
    const idx = within.indexOf(find, Math.max(0, Math.floor(start) - 1));
    return idx === -1 ? new FormulaError(ERR_VALUE) : idx + 1;
  },
  REPT: (args, ctx) => {
    const s = toText(ctx.evalScalar(args[0]));
    const n = toNumber(ctx.evalScalar(args[1]));
    if (n instanceof FormulaError) {
      return n;
    }
    if (n < 0 || textTooLong(s.length * Math.floor(n))) {
      return new FormulaError(ERR_VALUE);
    }
    return s.repeat(Math.floor(n));
  },
  VALUE: (args, ctx) => toNumber(ctx.evalScalar(args[0])),
  TEXT: (args, ctx) => {
    const v = ctx.evalScalar(args[0]);
    if (v instanceof FormulaError) {
      return v;
    }
    const pattern = toText(ctx.evalScalar(args[1]));
    return applyTextPattern(v, pattern);
  },
  CHAR: (args, ctx) => {
    const n = num1(args, ctx);
    if (n instanceof FormulaError) {
      return n;
    }
    return String.fromCharCode(Math.floor(n));
  },
  CODE: (args, ctx) => {
    const s = toText(ctx.evalScalar(args[0]));
    return s.length === 0 ? new FormulaError(ERR_VALUE) : s.charCodeAt(0);
  },

  // ---- lookup / reference ----
  ROW: (args) => {
    if (args.length === 0) {
      return new FormulaError(ERR_NA);
    }
    const a = args[0];
    if (a.t === 'ref') {
      return a.row + 1;
    }
    if (a.t === 'range') {
      return a.r1 + 1;
    }
    return new FormulaError(ERR_VALUE);
  },
  COLUMN: (args) => {
    if (args.length === 0) {
      return new FormulaError(ERR_NA);
    }
    const a = args[0];
    if (a.t === 'ref') {
      return a.col + 1;
    }
    if (a.t === 'range') {
      return a.c1 + 1;
    }
    return new FormulaError(ERR_VALUE);
  },
  ROWS: (args) => {
    const a = args[0];
    if (a?.t === 'range') {
      return a.r2 - a.r1 + 1;
    }
    if (a?.t === 'ref') {
      return 1;
    }
    return new FormulaError(ERR_VALUE);
  },
  COLUMNS: (args) => {
    const a = args[0];
    if (a?.t === 'range') {
      return a.c2 - a.c1 + 1;
    }
    if (a?.t === 'ref') {
      return 1;
    }
    return new FormulaError(ERR_VALUE);
  },
  VLOOKUP: (args, ctx) => lookup(args, ctx, 'v'),
  HLOOKUP: (args, ctx) => lookup(args, ctx, 'h'),
  MATCH: (args, ctx) => {
    const target = ctx.evalScalar(args[0]);
    if (target instanceof FormulaError) {
      return target;
    }
    const arr = ctx.flatten(args[1]);
    const type = args[2] ? toNumber(ctx.evalScalar(args[2])) : 1;
    if (type instanceof FormulaError) {
      return type;
    }
    if (type === 0) {
      for (let i = 0; i < arr.length; i++) {
        if (matchCriterion(arr[i], target, ctx)) {
          return i + 1;
        }
      }
      return new FormulaError(ERR_NA);
    }
    // 1 = largest ≤ target (ascending); -1 = smallest ≥ target (descending)
    let best = -1;
    for (let i = 0; i < arr.length; i++) {
      const cmp = compareValues(arr[i], target);
      if (type === 1 && cmp <= 0) {
        best = i;
      } else if (type === -1 && cmp >= 0) {
        best = i;
      }
    }
    return best === -1 ? new FormulaError(ERR_NA) : best + 1;
  },
  INDEX: (args, ctx) => {
    const rowArg = args[1] ? toNumber(ctx.evalScalar(args[1])) : 0;
    if (rowArg instanceof FormulaError) {
      return rowArg;
    }
    const colArg = args[2] ? toNumber(ctx.evalScalar(args[2])) : 0;
    if (colArg instanceof FormulaError) {
      return colArg;
    }
    const v = ctx.evalNode(args[0]);
    if (v instanceof FormulaError) {
      return v;
    }
    if (!(v instanceof RangeBox)) {
      return rowArg <= 1 && colArg <= 1 ? v : new FormulaError(ERR_REF);
    }
    const rows = v.rows;
    const ri = Math.floor(rowArg);
    const ci = Math.floor(colArg);
    if (ri === 0 && ci > 0) {
      // whole column
      const out: CellValue[][] = [];
      for (const r of rows) {
        if (ci - 1 < r.length) {
          out.push([r[ci - 1]]);
        }
      }
      return out.length === 1 ? out[0][0] : new RangeBox(out);
    }
    if (ci === 0 && ri > 0) {
      const out = rows[ri - 1];
      if (!out) {
        return new FormulaError(ERR_REF);
      }
      return out.length === 1 ? out[0] : new RangeBox([out]);
    }
    const r = rows[ri - 1];
    if (!r || ci - 1 < 0 || ci - 1 >= r.length) {
      return new FormulaError(ERR_REF);
    }
    return r[ci - 1];
  },

  // ---- date / time ----
  DATE: (args, ctx) => {
    const y = num1([args[0]], ctx);
    if (y instanceof FormulaError) {
      return y;
    }
    const m = toNumber(ctx.evalScalar(args[1]));
    if (m instanceof FormulaError) {
      return m;
    }
    const d = toNumber(ctx.evalScalar(args[2]));
    if (d instanceof FormulaError) {
      return d;
    }
    return dateToSerial(Math.floor(y), Math.floor(m), Math.floor(d));
  },
  TODAY: () => {
    const now = new Date();
    return dateToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
  },
  NOW: () => (Date.now() - EPOCH) / DAY_MS,
  YEAR: (args, ctx) => dateComponent(args, ctx, (d) => d.getUTCFullYear()),
  MONTH: (args, ctx) => dateComponent(args, ctx, (d) => d.getUTCMonth() + 1),
  DAY: (args, ctx) => dateComponent(args, ctx, (d) => d.getUTCDate()),
  WEEKDAY: (args, ctx) => dateComponent(args, ctx, (d) => d.getUTCDay() + 1),
};

// ----- function helpers -----

function mathUnary(
  args: Node[],
  ctx: FnCtx,
  fn: (n: number) => number | FormulaError,
): EvalValue {
  const n = num1(args, ctx);
  if (n instanceof FormulaError) {
    return n;
  }
  return fn(n);
}

function textUnary(
  args: Node[],
  ctx: FnCtx,
  fn: (s: string) => string,
): EvalValue {
  const v = ctx.evalScalar(args[0]);
  return v instanceof FormulaError ? v : fn(toText(v));
}

function concat(args: Node[], ctx: FnCtx): EvalValue {
  let s = '';
  for (const arg of args) {
    for (const v of ctx.flatten(arg)) {
      if (v instanceof FormulaError) {
        return v;
      }
      s += toText(v);
      if (textTooLong(s.length)) {
        return new FormulaError(ERR_VALUE);
      }
    }
  }
  return s;
}

function roundFn(
  args: Node[],
  ctx: FnCtx,
  mode: 'round' | 'up' | 'down',
): EvalValue {
  const n = num1([args[0]], ctx);
  if (n instanceof FormulaError) {
    return n;
  }
  const digits = args[1] ? toNumber(ctx.evalScalar(args[1])) : 0;
  if (digits instanceof FormulaError) {
    return digits;
  }
  const factor = Math.pow(10, Math.floor(digits));
  const scaled = n * factor;
  let r: number;
  if (mode === 'up') {
    r = scaled >= 0 ? Math.ceil(scaled) : Math.floor(scaled);
  } else if (mode === 'down') {
    r = scaled >= 0 ? Math.floor(scaled) : Math.ceil(scaled);
  } else {
    // round half away from zero (spreadsheet behaviour)
    r = Math.sign(scaled) * Math.round(Math.abs(scaled));
  }
  return r / factor;
}

function dateComponent(
  args: Node[],
  ctx: FnCtx,
  get: (d: Date) => number,
): EvalValue {
  const n = num1(args, ctx);
  if (n instanceof FormulaError) {
    return n;
  }
  return get(serialToDate(n));
}

function sumCountIf(
  args: Node[],
  ctx: FnCtx,
  mode: 'sum' | 'count' | 'avg',
): EvalValue {
  const range = ctx.flatten(args[0]);
  const criterion = ctx.evalScalar(args[1]);
  if (criterion instanceof FormulaError) {
    return criterion;
  }
  // SUMIF/AVERAGEIF: optional separate sum range
  const sumRange = mode !== 'count' && args[2] ? ctx.flatten(args[2]) : range;
  let total = 0;
  let count = 0;
  for (let i = 0; i < range.length; i++) {
    if (matchCriterion(range[i], criterion, ctx)) {
      if (mode === 'count') {
        count++;
      } else {
        const n = toNumber(sumRange[i] ?? 0);
        if (typeof n === 'number') {
          total += n;
          count++;
        }
      }
    }
  }
  if (mode === 'count') {
    return count;
  }
  if (mode === 'avg') {
    return count === 0 ? new FormulaError(ERR_DIV0) : total / count;
  }
  return total;
}

function lookup(args: Node[], ctx: FnCtx, dir: 'v' | 'h'): EvalValue {
  const target = ctx.evalScalar(args[0]);
  if (target instanceof FormulaError) {
    return target;
  }
  const table = ctx.evalNode(args[1]);
  if (table instanceof FormulaError) {
    return table;
  }
  if (!(table instanceof RangeBox)) {
    return new FormulaError(ERR_NA);
  }
  const index = toNumber(ctx.evalScalar(args[2]));
  if (index instanceof FormulaError) {
    return index;
  }
  const approximate = args[3] ? toBoolean(ctx.evalScalar(args[3])) : true;
  if (approximate instanceof FormulaError) {
    return approximate;
  }
  const rows = table.rows;
  const idx = Math.floor(index) - 1;

  if (dir === 'v') {
    let matchRow = -1;
    if (approximate) {
      for (let r = 0; r < rows.length; r++) {
        if (compareValues(rows[r][0], target) <= 0) {
          matchRow = r;
        } else {
          break;
        }
      }
    } else {
      for (let r = 0; r < rows.length; r++) {
        if (matchCriterion(rows[r][0], target, ctx)) {
          matchRow = r;
          break;
        }
      }
    }
    if (matchRow === -1) {
      return new FormulaError(ERR_NA);
    }
    const row = rows[matchRow];
    if (idx < 0 || idx >= row.length) {
      return new FormulaError(ERR_REF);
    }
    return row[idx];
  }
  const header = rows[0] ?? [];
  let matchCol = -1;
  if (approximate) {
    for (let c = 0; c < header.length; c++) {
      if (compareValues(header[c], target) <= 0) {
        matchCol = c;
      } else {
        break;
      }
    }
  } else {
    for (let c = 0; c < header.length; c++) {
      if (matchCriterion(header[c], target, ctx)) {
        matchCol = c;
        break;
      }
    }
  }
  if (matchCol === -1) {
    return new FormulaError(ERR_NA);
  }
  const row = rows[idx];
  if (!row || matchCol >= row.length) {
    return new FormulaError(ERR_REF);
  }
  return row[matchCol];
}

// ============================================================
// display formatting
// ============================================================

function applyTextPattern(value: CellValue, pattern: string): string {
  const num = toNumber(value);
  const p = pattern.toLowerCase();
  if (num instanceof FormulaError) {
    return toText(value);
  }
  if (p.includes('%')) {
    const decimals = (pattern.split('.')[1] ?? '').replace(/[^0#]/g, '').length;
    return (num * 100).toFixed(decimals) + '%';
  }
  if (p.includes('$') || p.includes('#,##')) {
    const decimals =
      (pattern.split('.')[1] ?? '').replace(/[^0#]/g, '').length || 2;
    const sign = p.includes('$') ? '$' : '';
    return sign + groupThousands(num.toFixed(decimals));
  }
  if (pattern.includes('0') || pattern.includes('#')) {
    const decimals = (pattern.split('.')[1] ?? '').replace(/[^0#]/g, '').length;
    return num.toFixed(decimals);
  }
  return numberToString(num);
}

function groupThousands(s: string): string {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPart, frac] = body.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + (frac ? '.' + frac : '');
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/**
 * Render a computed value as the string the grid shows, honouring numFmt and an
 * optional decimal-place override (for the increase/decrease-decimals controls).
 */
export function formatValue(
  value: CellValue,
  fmt: string | null,
  decimals: number | null = null,
): string {
  if (value instanceof FormulaError) {
    return value.code;
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'string') {
    return value;
  }
  // number
  const n = value;
  if (!Number.isFinite(n)) {
    return ERR_NUM;
  }
  const dp = (fallback: number) => (decimals === null ? fallback : decimals);
  switch (fmt) {
    case 'integer':
      return groupThousands(n.toFixed(dp(0)));
    case 'number':
      return groupThousands(n.toFixed(dp(2)));
    case 'currency':
      return (n < 0 ? '-$' : '$') + groupThousands(Math.abs(n).toFixed(dp(2)));
    case 'accounting': {
      // Accounting: currency symbol left-aligned feel, negatives in parens.
      const body = '$' + groupThousands(Math.abs(n).toFixed(dp(2)));
      return n < 0 ? `(${body})` : body;
    }
    case 'percent': {
      const s = groupThousands((n * 100).toFixed(dp(2)));
      // Default percent hides a trailing ".00" for a clean 50% (not 50.00%).
      return (decimals === null ? s.replace(/\.00$/, '') : s) + '%';
    }
    case 'scientific':
      return n.toExponential(dp(2));
    case 'text':
      return numberToString(n);
    case 'duration': {
      // Elapsed time h:mm:ss from a serial fraction (days).
      const totalSec = Math.round(n * 86400);
      if (!Number.isFinite(totalSec)) return ERR_NUM;
      const sign = totalSec < 0 ? '-' : '';
      const s = Math.abs(totalSec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      return `${sign}${h}:${pad2(m)}:${pad2(sec)}`;
    }
    case 'date': {
      const d = serialToDate(n);
      if (Number.isNaN(d.getTime())) return ERR_NUM;
      return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
    }
    case 'datetime': {
      const d = serialToDate(n);
      if (Number.isNaN(d.getTime())) return ERR_NUM;
      return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    }
    case 'time': {
      const d = serialToDate(n);
      if (Number.isNaN(d.getTime())) return ERR_NUM;
      return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
    }
    default:
      return decimals === null
        ? numberToString(n)
        : groupThousands(n.toFixed(decimals));
  }
}

// ============================================================
// relative reference translation (copy / paste / fill)
// ============================================================

/** A cell reference inside formula text, as `mapReferences` reports it. */
export type FormulaRef = {
  sheetName?: string;
  row: number;
  col: number;
  absRow: boolean;
  absCol: boolean;
};

type RefVisitor = {
  /** `source` is the exact text replaced, including any `Name!` prefix. */
  ref(ref: FormulaRef, source: string): string;
  /** A whole `A1:B2`; null visits each end through `ref` instead. */
  range?(a: FormulaRef, b: FormulaRef, source: string): string | null;
};

const REF_TOKEN = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;
const IDENT_CHAR = /[A-Za-z0-9_$.]/;

/** Index just past the quoted literal that opens at `start`; a doubled quote is an escape. */
function quotedEnd(body: string, start: number): number {
  const q = body[start];
  let i = start + 1;
  while (i < body.length) {
    if (body[i] === q && body[i + 1] === q) {
      i += 2;
      continue;
    }
    if (body[i] === q) {
      return i + 1;
    }
    i++;
  }
  return i;
}

function identEnd(body: string, start: number): number {
  let i = start;
  while (i < body.length && IDENT_CHAR.test(body[i])) {
    i++;
  }
  return i;
}

/** The reference spelled by the identifier run [start, end), or null. */
function refIn(
  body: string,
  start: number,
  end: number,
  sheetName: string | undefined,
): FormulaRef | null {
  if (end === start || body[end] === '(' || body[end] === '!') {
    return null;
  }
  const m = REF_TOKEN.exec(body.slice(start, end));
  const a = m ? parseA1(m[0]) : null;
  if (!a) {
    return null;
  }
  const ref: FormulaRef = {
    row: a.row,
    col: a.col,
    absRow: a.absRow,
    absCol: a.absCol,
  };
  if (sheetName !== undefined) {
    ref.sheetName = sheetName;
  }
  return ref;
}

/**
 * The reference walk shared by translateFormula, remapSameSheetRefs and the
 * docmost sync model. String literals, function names and booleans are copied
 * untouched; a sheet qualifier (`Sheet2!`, `'My Sheet'!`) is part of the first
 * reference after it, and both ends of a qualified range carry its name.
 */
function walkReferences(formula: string, visit: RefVisitor): string {
  if (!formula.startsWith('=')) {
    return formula;
  }
  const body = formula.slice(1);
  let out = '=';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"') {
      const end = quotedEnd(body, i);
      out += body.slice(i, end);
      i = end;
      continue;
    }
    let sheetName: string | undefined;
    let refStart = i;
    if (c === "'") {
      const end = quotedEnd(body, i);
      if (body[end] !== '!') {
        out += body.slice(i, end);
        i = end;
        continue;
      }
      sheetName = body.slice(i + 1, end - 1).replace(/''/g, "'");
      refStart = end + 1;
    } else if (IDENT_CHAR.test(c)) {
      const end = identEnd(body, i);
      if (body[end] === '!') {
        sheetName = body.slice(i, end);
        refStart = end + 1;
      }
    } else {
      out += c;
      i++;
      continue;
    }

    const refEnd = identEnd(body, refStart);
    const first = refIn(body, refStart, refEnd, sheetName);
    if (!first) {
      // not a reference: copy the qualifier or identifier as typed
      const end = sheetName !== undefined ? refStart : identEnd(body, i);
      out += body.slice(i, end);
      i = end;
      continue;
    }

    if (body[refEnd] === ':') {
      const secondEnd = identEnd(body, refEnd + 1);
      const second = refIn(body, refEnd + 1, secondEnd, sheetName);
      if (second) {
        const whole = visit.range?.(first, second, body.slice(i, secondEnd));
        if (whole !== null && whole !== undefined) {
          out += whole;
        } else {
          out += visit.ref(first, body.slice(i, refEnd));
          out += ':';
          out += visit.ref(second, body.slice(refEnd + 1, secondEnd));
        }
        i = secondEnd;
        continue;
      }
    }
    out += visit.ref(first, body.slice(i, refEnd));
    i = refEnd;
  }
  return out;
}

/**
 * Calls `fn` for every cell reference in a formula (each end of a range
 * separately) and splices its result in place of the reference. The spliced
 * text of a qualified reference includes its `Name!` prefix; `source` is that
 * exact text.
 */
export function mapReferences(
  formula: string,
  fn: (ref: FormulaRef, source: string) => string,
): string {
  return walkReferences(formula, { ref: fn });
}

function qualifierOf(source: string): string {
  return source.slice(0, source.lastIndexOf('!') + 1);
}

function refText(
  row: number,
  col: number,
  absRow: boolean,
  absCol: boolean,
): string {
  return (
    (absCol ? '$' : '') + colToLetter(col) + (absRow ? '$' : '') + (row + 1)
  );
}

/**
 * Shift the relative parts of every A1 reference in a formula by (dRow, dCol).
 * Used when copy-pasting a formula to a new origin so `=A1` pasted one row down
 * becomes `=A2`, while `$A$1` stays put. Quoted strings are left untouched.
 */
export function translateFormula(
  formula: string,
  dRow: number,
  dCol: number,
): string {
  return mapReferences(formula, (ref, source) => {
    const newCol = ref.absCol ? ref.col : ref.col + dCol;
    const newRow = ref.absRow ? ref.row : ref.row + dRow;
    if (newCol < 0 || newRow < 0) {
      return qualifierOf(source) + ERR_REF;
    }
    return (
      qualifierOf(source) + refText(newRow, newCol, ref.absRow, ref.absCol)
    );
  });
}

/**
 * Rewrite every SAME-SHEET (unqualified) reference in a formula by mapping its
 * row and column through `rowMap`/`colMap`. A map returning null means the
 * reference's row/col was deleted → the ref becomes #REF!. Sheet-qualified
 * refs (Sheet2!A1) and quoted strings are left untouched. Used by insert/delete
 * row/column so formulas in the edited sheet keep pointing at the right cells.
 */
export function remapSameSheetRefs(
  formula: string,
  rowMap: (row: number) => number | null,
  colMap: (col: number) => number | null,
): string {
  return walkReferences(formula, {
    ref: (ref, source) => {
      if (ref.sheetName !== undefined) {
        return source;
      }
      const nc = colMap(ref.col);
      const nr = rowMap(ref.row);
      if (nc === null || nr === null || nc < 0 || nr < 0) {
        return ERR_REF;
      }
      return refText(nr, nc, ref.absRow, ref.absCol);
    },
    // A range `<ref>:<ref>` is remapped as a unit: deleting a band that
    // covers one endpoint CONTRACTS the range (A2:A5 minus row 2 → A2:A4)
    // rather than poisoning an endpoint with #REF! (which Sheets only does
    // when the whole range is gone).
    range: (a, b, source) => {
      if (a.sheetName !== undefined) {
        return source;
      }
      const rows: number[] = [];
      for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
        const nr = rowMap(r);
        if (nr !== null && nr >= 0) {
          rows.push(nr);
        }
      }
      const cols: number[] = [];
      for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) {
        const nc = colMap(c);
        if (nc !== null && nc >= 0) {
          cols.push(nc);
        }
      }
      if (rows.length === 0 || cols.length === 0) {
        return `${ERR_REF}:${ERR_REF}`;
      }
      return (
        refText(Math.min(...rows), Math.min(...cols), a.absRow, a.absCol) +
        ':' +
        refText(Math.max(...rows), Math.max(...cols), b.absRow, b.absCol)
      );
    },
  });
}

// re-export A1 helpers so consumers can import them from the engine too
export { toA1, colToLetter, letterToCol } from './model';
