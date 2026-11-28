import * as Y from 'yjs';
import {
  type Cell,
  type CellFormat,
  type MergeRange,
  type Sheet,
  type SheetBook,
  MAX_COL_WIDTH,
  MAX_COLS,
  MAX_ROW_HEIGHT,
  MAX_ROWS,
  MIN_COL_WIDTH,
  MIN_ROW_HEIGHT,
  normalizeFormat,
  parseKey,
} from './model';
import { LiveBlockInputError } from '../snapshot';
import { mapReferences } from './engine';
import {
  decodeFormula,
  encodeFormula,
  type RefContext,
  shrinkRanges,
} from './refs';

/*
 * Layout of a sheet document (see the shared plan):
 *   order:  Y.Array of tab ids
 *   sheets: Y.Map tab id → Y.Map { name, frozenRows, frozenCols, rows, cols,
 *           cells, colWidths, rowHeights, merges }
 * Rows and columns have ids that never change; a position is only the index
 * of an id in `rows` or `cols`. Cells are keyed "rowId:colId" and formulas are
 * stored with anchored references (refs.ts). A tab exists while its id is in
 * `order`; a deleted tab, row or column keeps its cells so an undo brings
 * them back.
 */

export const SHEET_LIMITS = { rows: MAX_ROWS, cols: MAX_COLS };
/** The first tab of a new sheet, wherever it is made (editor or server). */
export const FIRST_TAB_ID = 'sheet1';
/** Longest cell value. */
export const MAX_TEXT = 32_767;
/**
 * Longest tab name. Every reference to another tab repeats its name when a
 * formula is decoded, so a long name multiplies the size of every formula.
 */
export const MAX_TAB_NAME = 100;

/** A tab name as stored and shown: trimmed and capped. */
export function cleanTabName(raw: unknown): string {
  return typeof raw === 'string'
    ? raw.trim().slice(0, MAX_TAB_NAME).trim()
    : '';
}

const ORDER = 'order';
const SHEETS = 'sheets';

type Tab = Y.Map<unknown>;
type IdMerge = { r1: string; c1: string; r2: string; c2: string };
type Axis = 'rows' | 'cols';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A short random id for a row, column, tab or merge. */
export function newLayoutId(): string {
  const bytes = new Uint8Array(10);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

function newIds(count: number): string[] {
  return Array.from({ length: count }, newLayoutId);
}

/** FNV-1a over a string, as 10 base-36 characters. */
function hashId(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).padStart(10, '0').slice(-10);
}

/**
 * Ids for rows or columns appended at the end. They follow from the id before
 * them, so two people growing a tab at once append the same ids and the
 * first-occurrence rule merges the two runs instead of interleaving them. An
 * id already used (a deleted row keeps its cells) is skipped, the same way on
 * both sides.
 */
function growthIds(
  after: string,
  axis: Axis,
  count: number,
  used: (id: string) => boolean,
): string[] {
  const out: string[] = [];
  let prev = after;
  for (let i = 0; i < count; i++) {
    let id = 'g' + hashId(`${axis}:${prev}`);
    for (let salt = 1; used(id) || out.includes(id); salt++) {
      id = 'g' + hashId(`${axis}:${prev}:${salt}`);
    }
    out.push(id);
    prev = id;
  }
  return out;
}

export function sheetOrder(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>(ORDER);
}

export function sheetTabs(doc: Y.Doc): Y.Map<Tab> {
  return doc.getMap<Tab>(SHEETS);
}

/** Live tab ids in order; the first occurrence of a repeated id counts. */
/** Tabs read from a document; the same cap as a book from outside. */
export const MAX_TABS_READ = 200;

export function tabIds(doc: Y.Doc): string[] {
  const tabs = sheetTabs(doc);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of sheetOrder(doc).toArray()) {
    if (out.length >= MAX_TABS_READ) break;
    // __proto__ would replace the prototype of every map keyed by tab id
    if (
      typeof id !== 'string' ||
      seen.has(id) ||
      !VALID_ID.test(id) ||
      id === '__proto__'
    )
      continue;
    seen.add(id);
    if (tabs.get(id) instanceof Y.Map) out.push(id);
  }
  return out;
}

function tabOf(doc: Y.Doc, sheetId: string): Tab {
  const tab = sheetTabs(doc).get(sheetId);
  if (!(tab instanceof Y.Map) || !tabIds(doc).includes(sheetId)) {
    throw new Error(`Unknown sheet tab: ${sheetId}`);
  }
  return repairTab(tab);
}

/**
 * A tab written without its parts (any client can) gets them, so writing to
 * it, or growing it from a formula on another tab, works instead of
 * throwing a TypeError. Known limit: two peers repairing the same tab at
 * once each set a new array and Yjs keeps one, so rows one of them grew
 * past the other's length are lost (needs a malformed tab from a peer).
 */
function repairTab(tab: Tab): Tab {
  if (!(tab.get('rows') instanceof Y.Array))
    tab.set('rows', new Y.Array<string>());
  if (!(tab.get('cols') instanceof Y.Array))
    tab.set('cols', new Y.Array<string>());
  for (const part of ['cells', 'colWidths', 'rowHeights', 'merges']) {
    if (!(tab.get(part) instanceof Y.Map)) tab.set(part, new Y.Map());
  }
  return tab;
}

function arrayOf(tab: Tab, axis: Axis): Y.Array<string> {
  return tab.get(axis) as Y.Array<string>;
}

function mapOf<T>(tab: Tab, name: string): Y.Map<T> {
  return tab.get(name) as Y.Map<T>;
}

export type AxisLayout = {
  ids: string[];
  /** position → index in the Y.Array */
  raw: number[];
  at: Map<string, number>;
};

export type TabLayout = {
  id: string;
  name: string;
  rows: AxisLayout;
  cols: AxisLayout;
};

function axisLayout(arr: Y.Array<string> | undefined, max: number): AxisLayout {
  const layout: AxisLayout = { ids: [], raw: [], at: new Map() };
  if (!(arr instanceof Y.Array)) return layout;
  arr.toArray().forEach((id, i) => {
    // ids past the limit (concurrent growth) are not read
    if (typeof id !== 'string' || layout.at.has(id) || layout.ids.length >= max)
      return;
    layout.at.set(id, layout.ids.length);
    layout.ids.push(id);
    layout.raw.push(i);
  });
  return layout;
}

export function readLayout(doc: Y.Doc, sheetId: string): TabLayout | null {
  const tab = sheetTabs(doc).get(sheetId);
  if (!(tab instanceof Y.Map)) return null;
  const name = tab.get('name');
  return {
    id: sheetId,
    name: typeof name === 'string' && name ? name : 'Sheet',
    rows: axisLayout(tab.get('rows') as Y.Array<string>, MAX_ROWS),
    cols: axisLayout(tab.get('cols') as Y.Array<string>, MAX_COLS),
  };
}

/** Layouts of the live tabs, read on demand and kept for the call. */
export class LayoutCache {
  private readonly layouts = new Map<string, TabLayout | null>();
  private live: string[] | null = null;

  constructor(private readonly doc: Y.Doc) {}

  tabs(): string[] {
    if (!this.live) this.live = tabIds(this.doc);
    return this.live;
  }

  private names: Map<string, string> | null = null;

  /** Tab names as shown and as formulas use them: a repeated name gets " (2)". */
  nameOf(sheetId: string): string | null {
    if (!this.names) {
      this.names = new Map();
      const taken = new Set<string>();
      // the next number to try per name, so repeats are not rescanned from 2
      const next = new Map<string, number>();
      for (const id of this.tabs()) {
        const raw = sheetTabs(this.doc).get(id)?.get('name');
        const base =
          typeof raw === 'string' && raw.trim()
            ? cleanTabName(raw) || 'Sheet'
            : 'Sheet';
        const key = base.toLowerCase();
        let name = base;
        let n = next.get(key) ?? 2;
        // the number keeps the name within the cap: two long names that
        // differ only after 100 characters become "X…" and "X… (2)"
        while (taken.has(name.toLowerCase())) {
          const suffix = ` (${n++})`;
          name = base.slice(0, MAX_TAB_NAME - suffix.length).trimEnd() + suffix;
        }
        next.set(key, n);
        taken.add(name.toLowerCase());
        this.names.set(id, name);
      }
    }
    return this.names.get(sheetId) ?? null;
  }

  get(sheetId: string): TabLayout | null {
    if (!this.tabs().includes(sheetId)) return null;
    if (!this.layouts.has(sheetId)) {
      const layout = readLayout(this.doc, sheetId);
      if (layout) layout.name = this.nameOf(sheetId) ?? layout.name;
      this.layouts.set(sheetId, layout);
    }
    return this.layouts.get(sheetId);
  }

  /** Forget one tab (after its rows or columns changed) or every tab. */
  invalidate(sheetId?: string): void {
    if (sheetId === undefined) {
      this.layouts.clear();
      this.live = null;
      this.names = null;
    } else {
      this.layouts.delete(sheetId);
    }
  }
}

/** Appends ids until the tab has at least `rows` rows and `cols` columns. */
function growLayout(
  doc: Y.Doc,
  layout: TabLayout,
  rows: number,
  cols: number,
): void {
  if (rows > MAX_ROWS || cols > MAX_COLS) {
    throw new Error(
      `A sheet holds at most ${MAX_ROWS} rows and ${MAX_COLS} columns`,
    );
  }
  const tab = repairTab(sheetTabs(doc).get(layout.id));
  for (const [axis, want] of [
    ['rows', rows],
    ['cols', cols],
  ] as const) {
    const al = layout[axis];
    const missing = want - al.ids.length;
    if (missing <= 0) continue;
    const arr = arrayOf(tab, axis);
    const cells = mapOf<unknown>(tab, 'cells');
    // the ids used by cells of deleted rows, read only if a new id is taken
    let inCells: Set<string> | null = null;
    const deletedIds = () => {
      if (!inCells) {
        inCells = new Set<string>();
        if (cells instanceof Y.Map) {
          for (const key of cells.keys()) {
            const i = key.indexOf(':');
            inCells.add(axis === 'rows' ? key.slice(0, i) : key.slice(i + 1));
          }
        }
      }
      return inCells;
    };
    const usedIds = (id: string) => al.at.has(id) || deletedIds().has(id);
    const last = arr.length > 0 ? String(arr.get(arr.length - 1)) : layout.id;
    const ids = growthIds(last, axis, missing, usedIds);
    const start = arr.length;
    arr.push(ids);
    ids.forEach((id, i) => {
      al.at.set(id, al.ids.length);
      al.ids.push(id);
      al.raw.push(start + i);
    });
  }
}

/**
 * The reference context of formulas on one tab. With `grow`, a reference past
 * the end of a tab grows it so the position gets an id.
 */
export function refContext(
  doc: Y.Doc,
  layouts: LayoutCache,
  sheetId: string,
  grow = false,
): RefContext {
  const idAt = (axis: Axis, id: string, pos: number) => {
    const layout = layouts.get(id);
    if (!layout || pos < 0) return null;
    const max = axis === 'rows' ? MAX_ROWS : MAX_COLS;
    if (pos >= layout[axis].ids.length) {
      if (!grow || pos >= max) return null;
      growLayout(
        doc,
        layout,
        axis === 'rows' ? pos + 1 : 0,
        axis === 'cols' ? pos + 1 : 0,
      );
    }
    return layout[axis].ids[pos];
  };
  return {
    sheetId,
    rowId: (id, row) => idAt('rows', id, row),
    colId: (id, col) => idAt('cols', id, col),
    rowIndex: (id, rowId) => layouts.get(id)?.rows.at.get(rowId) ?? null,
    colIndex: (id, colId) => layouts.get(id)?.cols.at.get(colId) ?? null,
    sheetIdByName: (name) => {
      const lower = name.toLowerCase();
      return (
        layouts
          .tabs()
          .find((id) => layouts.get(id)?.name.toLowerCase() === lower) ?? null
      );
    },
    sheetName: (id) => layouts.get(id)?.name ?? null,
  };
}

function storedCell(value: unknown): Cell | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { v?: unknown; f?: unknown };
  const v = typeof raw.v === 'string' ? raw.v : '';
  const f = raw.f === undefined ? null : normalizeFormat(raw.f);
  if (v === '' && !f) return null;
  return f ? { v, f } : { v };
}

/** A stored cell as the engine and UI see it: formula references decoded. */
export function decodeCell(value: unknown, ctx: RefContext): Cell | null {
  const cell = storedCell(value);
  if (!cell || !cell.v.startsWith('=')) return cell;
  const v = decodeFormula(cell.v, ctx);
  return cell.f ? { v, f: cell.f } : { v };
}

function splitKey(key: string): [string, string] | null {
  const i = key.indexOf(':');
  return i <= 0 ? null : [key.slice(0, i), key.slice(i + 1)];
}

function clampCount(v: unknown, max: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(0, Math.round(v)))
    : 0;
}

/**
 * Frozen panes are stored as the id of the last frozen row or column, so a
 * concurrent insert or delete above them keeps the same rows frozen. A number
 * (an older document) is read as a count.
 */
function readFrozen(value: unknown, al: AxisLayout): number {
  if (typeof value === 'string') {
    const at = al.at.get(value);
    return at === undefined ? 0 : at + 1;
  }
  return clampCount(value, al.ids.length);
}

function frozenValue(count: number, ids: string[]): string | number {
  return count > 0 && ids[count - 1] ? ids[count - 1] : 0;
}

function readSizes(
  map: Y.Map<number> | undefined,
  at: Map<string, number>,
  min: number,
  max: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!(map instanceof Y.Map)) return out;
  map.forEach((size, id) => {
    const pos = at.get(id);
    if (
      pos !== undefined &&
      typeof size === 'number' &&
      Number.isFinite(size)
    ) {
      // a size written by any client is kept within the editor's limits
      out[String(pos)] = Math.min(max, Math.max(min, size));
    }
  });
  return out;
}

/** Merges read from one tab; the same cap as a book from outside. */
export const MAX_MERGES_READ = 10_000;

function readMerges(
  map: Y.Map<IdMerge> | undefined,
  layout: TabLayout,
): MergeRange[] {
  const found: [string, MergeRange][] = [];
  if (!(map instanceof Y.Map)) return [];
  map.forEach((m, id) => {
    const range = mergePositions(m, layout);
    if (range) found.push([id, range]);
  });
  // which entries are read is decided by id, the same on every peer
  found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (found.length > MAX_MERGES_READ) found.length = MAX_MERGES_READ;
  return acceptMerges(found.map(([, r]) => r));
}

/**
 * The merges kept when some overlap (two people merging at once): in
 * (r1, c1, r2, c2, index) order, a merge is kept unless it overlaps one kept
 * before it. A sweep down the rows keeps `active`, the kept merges that reach
 * the current row, sorted by c1. They all span that row and never overlap,
 * so their column intervals are disjoint and one binary search finds the
 * only two that could overlap a candidate. No work is done per cell, so a
 * merge's size does not matter.
 *
 * Bound for n candidates: the sort, plus per candidate one binary search
 * over `active` and its expiry list (O(log n) comparisons each), plus at
 * most n inserts and n removals in arrays of at most n entries. With
 * n <= MAX_MERGES_READ that is about 10^5 comparisons and 10^8 element
 * moves in the worst case, usually far fewer. `count` (tests) adds up the
 * comparisons.
 */
export function acceptMerges(
  input: MergeRange[],
  count?: { n: number },
): MergeRange[] {
  const tick = count ? () => count.n++ : () => undefined;
  const order = input.map((r, i) => ({ r, i }));
  order.sort((a, b) => {
    tick();
    return (
      a.r.r1 - b.r.r1 ||
      a.r.c1 - b.r.c1 ||
      a.r.r2 - b.r.r2 ||
      a.r.c2 - b.r.c2 ||
      a.i - b.i
    );
  });
  // first index in `list` whose key is greater than `key`
  const upper = <T>(list: T[], key: number, of: (x: T) => number) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      tick();
      const mid = (lo + hi) >> 1;
      if (of(list[mid]) <= key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const active: MergeRange[] = []; // by c1
  const expiry: MergeRange[] = []; // by r2, latest first (pop the earliest)
  const out: MergeRange[] = [];
  for (const { r } of order) {
    // drop merges that end above this row
    while (expiry.length > 0 && expiry[expiry.length - 1].r2 < r.r1) {
      tick();
      const gone = expiry.pop()!;
      const at = upper(active, gone.c1, (m) => m.c1) - 1;
      active.splice(at, 1);
    }
    const at = upper(active, r.c1, (m) => m.c1);
    tick();
    const before = active[at - 1];
    const after = active[at];
    if ((before && before.c2 >= r.c1) || (after && after.c1 <= r.c2)) continue;
    active.splice(at, 0, r);
    // expiry is sorted by r2 descending: insert after every larger r2
    const e = upper(expiry, -r.r2, (m) => -m.r2);
    expiry.splice(e, 0, r);
    out.push(r);
  }
  return out;
}

function mergePositions(m: unknown, layout: TabLayout): MergeRange | null {
  if (typeof m !== 'object' || m === null) return null;
  const { r1, c1, r2, c2 } = m as IdMerge;
  const p = [
    layout.rows.at.get(r1),
    layout.cols.at.get(c1),
    layout.rows.at.get(r2),
    layout.cols.at.get(c2),
  ];
  if (p.some((x) => x === undefined)) return null;
  const range = {
    r1: Math.min(p[0], p[2]),
    c1: Math.min(p[1], p[3]),
    r2: Math.max(p[0], p[2]),
    c2: Math.max(p[1], p[3]),
  };
  if (range.r1 === range.r2 && range.c1 === range.c2) return null;
  return range;
}

/** One tab as a positional Sheet. */
export function readSheet(
  doc: Y.Doc,
  sheetId: string,
  layouts: LayoutCache = new LayoutCache(doc),
): Sheet | null {
  const layout = layouts.get(sheetId);
  const tab = sheetTabs(doc).get(sheetId);
  if (!layout || !(tab instanceof Y.Map)) return null;
  const ctx = refContext(doc, layouts, sheetId);
  const cells: Record<string, Cell> = {};
  const stored = mapOf<unknown>(tab, 'cells');
  if (stored instanceof Y.Map) {
    stored.forEach((value, key) => {
      const ids = splitKey(key);
      if (!ids) return;
      const r = layout.rows.at.get(ids[0]);
      const c = layout.cols.at.get(ids[1]);
      if (r === undefined || c === undefined) return;
      const cell = decodeCell(value, ctx);
      if (cell) cells[`${r}:${c}`] = cell;
    });
  }
  // a tab whose last row or column went in concurrent deletes reads as one
  const rows = Math.max(1, layout.rows.ids.length);
  const cols = Math.max(1, layout.cols.ids.length);
  return {
    id: sheetId,
    name: layout.name,
    rows,
    cols,
    cells,
    colWidths: readSizes(
      mapOf<number>(tab, 'colWidths'),
      layout.cols.at,
      MIN_COL_WIDTH,
      MAX_COL_WIDTH,
    ),
    rowHeights: readSizes(
      mapOf<number>(tab, 'rowHeights'),
      layout.rows.at,
      MIN_ROW_HEIGHT,
      MAX_ROW_HEIGHT,
    ),
    frozenRows: readFrozen(tab.get('frozenRows'), layout.rows),
    frozenCols: readFrozen(tab.get('frozenCols'), layout.cols),
    merges: readMerges(mapOf<IdMerge>(tab, 'merges'), layout),
  };
}

/** A tab's sizes, merges and frozen counts, without reading its cells. */
export function readSheetMeta(
  doc: Y.Doc,
  sheetId: string,
  layouts: LayoutCache,
): Pick<
  Sheet,
  'name' | 'colWidths' | 'rowHeights' | 'merges' | 'frozenRows' | 'frozenCols'
> | null {
  const layout = layouts.get(sheetId);
  const tab = sheetTabs(doc).get(sheetId);
  if (!layout || !(tab instanceof Y.Map)) return null;
  return {
    name: layout.name,
    colWidths: readSizes(
      mapOf<number>(tab, 'colWidths'),
      layout.cols.at,
      MIN_COL_WIDTH,
      MAX_COL_WIDTH,
    ),
    rowHeights: readSizes(
      mapOf<number>(tab, 'rowHeights'),
      layout.rows.at,
      MIN_ROW_HEIGHT,
      MAX_ROW_HEIGHT,
    ),
    frozenRows: readFrozen(tab.get('frozenRows'), layout.rows),
    frozenCols: readFrozen(tab.get('frozenCols'), layout.cols),
    merges: readMerges(mapOf<IdMerge>(tab, 'merges'), layout),
  };
}

/** The positional book for the engine and the UI, formulas decoded. */
export function readBook(doc: Y.Doc): SheetBook {
  const layouts = new LayoutCache(doc);
  const sheets = layouts
    .tabs()
    .map((id) => readSheet(doc, id, layouts))
    .filter((s): s is Sheet => s !== null);
  return { version: 1, sheets, activeSheetId: sheets[0]?.id ?? '' };
}

function cloneFormat(f: CellFormat): CellFormat {
  return JSON.parse(JSON.stringify(f));
}

function writeCell(
  cells: Y.Map<unknown>,
  key: string,
  cell: Cell | null | undefined,
  ctx: RefContext,
): void {
  if (!cell || (cell.v === '' && !cell.f)) {
    if (cells.has(key)) cells.delete(key);
    return;
  }
  const text = typeof cell.v === 'string' ? cell.v.slice(0, MAX_TEXT) : '';
  const v = encodeFormula(text, ctx);
  const f = cell.f ? normalizeFormat(cloneFormat(cell.f)) : null;
  if (v === '' && !f) {
    if (cells.has(key)) cells.delete(key);
    return;
  }
  cells.set(key, f ? { v, f } : { v });
}

/**
 * Many cells of one tab in one transaction: the tab grows once and one layout
 * and reference context serve every cell (the server's setCells path).
 */
/**
 * Work one setCells call may do: one unit per cell and per reference in its
 * formulas. A request past it is refused before anything is written.
 */
export const SET_CELLS_BUDGET = 2_000_000;
let setCellsBudget = SET_CELLS_BUDGET;
/** Tests only: a smaller budget. Returns the previous one. */
export function setSetCellsBudgetForTests(n: number): number {
  const before = setCellsBudget;
  setCellsBudget = n;
  return before;
}

export function setCells(
  doc: Y.Doc,
  sheetId: string,
  writes: { row: number; col: number; cell: Cell | null }[],
  origin?: unknown,
): void {
  // Count the work, and find how far each tab is referenced, before writing:
  // each tab then grows once instead of once per reference past its end.
  const reach = new Map<string | null, { rows: number; cols: number }>();
  let work = 0;
  for (const w of writes) {
    work++;
    const v = w.cell?.v;
    if (typeof v !== 'string' || !v.startsWith('=')) continue;
    mapReferences(v, (ref, source) => {
      work++;
      const key =
        ref.sheetName == null ? null : ref.sheetName.trim().toLowerCase();
      const r = reach.get(key) ?? { rows: 0, cols: 0 };
      r.rows = Math.max(r.rows, Math.min(ref.row + 1, MAX_ROWS));
      r.cols = Math.max(r.cols, Math.min(ref.col + 1, MAX_COLS));
      reach.set(key, r);
      return source;
    });
    if (work > setCellsBudget) {
      throw new LiveBlockInputError(
        'These cells hold too many references to write in one request; send fewer at a time',
      );
    }
  }
  for (const w of writes) {
    if (w.row < 0 || w.col < 0 || w.row >= MAX_ROWS || w.col >= MAX_COLS) {
      throw new Error(
        `A sheet holds at most ${MAX_ROWS} rows and ${MAX_COLS} columns`,
      );
    }
  }
  doc.transact(() => {
    const tab = tabOf(doc, sheetId);
    const layouts = new LayoutCache(doc);
    const layout = layouts.get(sheetId);
    let rows = 0;
    let cols = 0;
    for (const w of writes) {
      rows = Math.max(rows, w.row + 1);
      cols = Math.max(cols, w.col + 1);
    }
    const own = reach.get(null);
    growLayout(
      doc,
      layout,
      Math.max(rows, own?.rows ?? 0),
      Math.max(cols, own?.cols ?? 0),
    );
    for (const [name, r] of reach) {
      if (name === null) continue;
      const id = layouts
        .tabs()
        .find((t) => layouts.get(t)?.name.toLowerCase() === name);
      const other = id ? layouts.get(id) : null;
      if (other) growLayout(doc, other, r.rows, r.cols);
    }
    const cells = mapOf<unknown>(tab, 'cells');
    const ctx = refContext(doc, layouts, sheetId, true);
    for (const w of writes) {
      writeCell(
        cells,
        `${layout.rows.ids[w.row]}:${layout.cols.ids[w.col]}`,
        w.cell,
        ctx,
      );
    }
  }, origin);
}

function createTab(doc: Y.Doc, sheet: Sheet): string {
  const tabs = sheetTabs(doc);
  const id =
    VALID_ID.test(sheet.id ?? '') && !tabs.has(sheet.id)
      ? sheet.id
      : newLayoutId();
  const tab = new Y.Map<unknown>();
  tabs.set(id, tab);
  const rows = Math.min(MAX_ROWS, Math.max(1, sheet.rows | 0));
  const cols = Math.min(MAX_COLS, Math.max(1, sheet.cols | 0));
  const rowIds = newIds(rows);
  const colIds = newIds(cols);
  tab.set('name', cleanTabName(sheet.name) || 'Sheet1');
  tab.set(
    'frozenRows',
    frozenValue(clampCount(sheet.frozenRows, rows), rowIds),
  );
  tab.set(
    'frozenCols',
    frozenValue(clampCount(sheet.frozenCols, cols), colIds),
  );
  const rowArr = new Y.Array<string>();
  const colArr = new Y.Array<string>();
  tab.set('rows', rowArr);
  tab.set('cols', colArr);
  rowArr.push(rowIds);
  colArr.push(colIds);
  tab.set('cells', new Y.Map());
  const colWidths = new Y.Map<number>();
  const rowHeights = new Y.Map<number>();
  const merges = new Y.Map<IdMerge>();
  tab.set('colWidths', colWidths);
  tab.set('rowHeights', rowHeights);
  tab.set('merges', merges);
  for (const [k, w] of Object.entries(sheet.colWidths ?? {})) {
    if (colIds[Number(k)]) colWidths.set(colIds[Number(k)], w);
  }
  for (const [k, h] of Object.entries(sheet.rowHeights ?? {})) {
    if (rowIds[Number(k)]) rowHeights.set(rowIds[Number(k)], h);
  }
  for (const m of sheet.merges ?? []) {
    if (rowIds[m.r2] && colIds[m.c2] && rowIds[m.r1] && colIds[m.c1]) {
      merges.set(newLayoutId(), {
        r1: rowIds[m.r1],
        c1: colIds[m.c1],
        r2: rowIds[m.r2],
        c2: colIds[m.c2],
      });
    }
  }
  return id;
}

/** Writes a positional sheet's cells into a tab created by createTab. */
function fillTab(doc: Y.Doc, layouts: LayoutCache, id: string, sheet: Sheet) {
  const layout = layouts.get(id);
  const cells = mapOf<unknown>(sheetTabs(doc).get(id), 'cells');
  const ctx = refContext(doc, layouts, id, true);
  for (const [key, cell] of Object.entries(sheet.cells ?? {})) {
    const pos = parseKey(key);
    if (!pos || pos.row >= MAX_ROWS || pos.col >= MAX_COLS) continue;
    growLayout(doc, layout, pos.row + 1, pos.col + 1);
    writeCell(
      cells,
      `${layout.rows.ids[pos.row]}:${layout.cols.ids[pos.col]}`,
      cell,
      ctx,
    );
  }
}

/** Adds every tab of a positional book to the document. */
export function seedSheet(doc: Y.Doc, book: SheetBook): void {
  doc.transact(() => {
    const created: [string, Sheet][] = [];
    for (const sheet of book.sheets) {
      const id = createTab(doc, sheet);
      sheetOrder(doc).push([id]);
      created.push([id, sheet]);
    }
    // cells after every tab exists, so cross-tab references can anchor
    const layouts = new LayoutCache(doc);
    for (const [id, sheet] of created) fillTab(doc, layouts, id, sheet);
  });
}

/** Grows a tab to at least this size. */
export function ensureSheetSize(
  doc: Y.Doc,
  sheetId: string,
  rows: number,
  cols: number,
  origin?: unknown,
): void {
  doc.transact(() => {
    tabOf(doc, sheetId);
    const layout = readLayout(doc, sheetId);
    growLayout(doc, layout, rows, cols);
  }, origin);
}

/** The fast path for typing: one map entry, after growing when needed. */
export function setCell(
  doc: Y.Doc,
  sheetId: string,
  row: number,
  col: number,
  cell: Cell | null,
  origin?: unknown,
): void {
  if (row < 0 || col < 0 || row >= MAX_ROWS || col >= MAX_COLS) {
    throw new Error(
      `A sheet holds at most ${MAX_ROWS} rows and ${MAX_COLS} columns`,
    );
  }
  doc.transact(() => {
    const tab = tabOf(doc, sheetId);
    const layouts = new LayoutCache(doc);
    const layout = layouts.get(sheetId);
    growLayout(doc, layout, row + 1, col + 1);
    writeCell(
      mapOf<unknown>(tab, 'cells'),
      `${layout.rows.ids[row]}:${layout.cols.ids[col]}`,
      cell,
      refContext(doc, layouts, sheetId, true),
    );
  }, origin);
}

function frozenKey(axis: Axis): string {
  return axis === 'rows' ? 'frozenRows' : 'frozenCols';
}

function insertAxis(
  doc: Y.Doc,
  sheetId: string,
  axis: Axis,
  at: number,
  count: number,
  origin: unknown,
): void {
  const max = axis === 'rows' ? MAX_ROWS : MAX_COLS;
  doc.transact(() => {
    const tab = tabOf(doc, sheetId);
    const layout = readLayout(doc, sheetId)[axis];
    const n = Math.max(1, Math.floor(count));
    if (layout.ids.length + n > max) {
      throw new Error(
        `A sheet holds at most ${max} ${axis === 'rows' ? 'rows' : 'columns'}`,
      );
    }
    const pos = Math.min(Math.max(0, Math.floor(at)), layout.ids.length);
    const arr = arrayOf(tab, axis);
    arr.insert(
      pos < layout.ids.length ? layout.raw[pos] : arr.length,
      newIds(n),
    );
    // a frozen pane anchored by id grows by itself when rows go in above it
    const stored = tab.get(frozenKey(axis));
    if (typeof stored === 'number') {
      const frozen = clampCount(stored, layout.ids.length);
      const ids = readLayout(doc, sheetId)[axis].ids;
      tab.set(
        frozenKey(axis),
        frozenValue(pos < frozen ? frozen + n : frozen, ids),
      );
    }
  }, origin);
}

function deleteAxis(
  doc: Y.Doc,
  sheetId: string,
  axis: Axis,
  at: number,
  count: number,
  origin: unknown,
): void {
  doc.transact(() => {
    const tab = tabOf(doc, sheetId);
    const layout = readLayout(doc, sheetId);
    const al = layout[axis];
    const pos = Math.max(0, Math.floor(at));
    // a tab keeps at least one row and one column
    const n = Math.min(
      Math.max(1, Math.floor(count)),
      al.ids.length - pos,
      al.ids.length - 1,
    );
    if (n <= 0) return;
    const gone = new Set(al.ids.slice(pos, pos + n));

    shrinkMerges(tab, layout, axis, gone);

    // ranges that lose only their first or last row (column) shrink; a
    // range deleted whole becomes #REF! when it is read
    for (const id of tabIds(doc)) {
      const cells = mapOf<unknown>(sheetTabs(doc).get(id), 'cells');
      if (!(cells instanceof Y.Map)) continue;
      for (const [key, value] of [...cells.entries()]) {
        const v = (value as { v?: unknown } | null)?.v;
        if (typeof v !== 'string' || !v.startsWith('=')) continue;
        const next = shrinkRanges(v, id, sheetId, axis, al.at, al.ids, gone);
        if (next !== v) cells.set(key, { ...(value as object), v: next });
      }
    }

    const frozen = readFrozen(tab.get(frozenKey(axis)), al);
    if (pos < frozen) {
      const left = Math.max(0, frozen - Math.min(n, frozen - pos));
      const kept = al.ids.filter((id) => !gone.has(id));
      tab.set(frozenKey(axis), frozenValue(left, kept));
    }

    // every occurrence of a deleted id, last first so indexes stay valid
    const arr = arrayOf(tab, axis);
    const raw = arr.toArray();
    for (let i = raw.length - 1; i >= 0; i--) {
      if (!gone.has(raw[i])) continue;
      let start = i;
      while (start > 0 && gone.has(raw[start - 1])) start--;
      arr.delete(start, i - start + 1);
      i = start;
    }
  }, origin);
}

/** A merge whose corner row or column is deleted shrinks to what is left. */
function shrinkMerges(
  tab: Tab,
  layout: TabLayout,
  axis: Axis,
  gone: Set<string>,
) {
  const merges = mapOf<IdMerge>(tab, 'merges');
  if (!(merges instanceof Y.Map)) return;
  const [k1, k2] =
    axis === 'rows' ? (['r1', 'r2'] as const) : (['c1', 'c2'] as const);
  const al = layout[axis];
  for (const [mergeId, m] of [...merges.entries()]) {
    if (!gone.has(m[k1]) && !gone.has(m[k2])) continue;
    const a = al.at.get(m[k1]);
    const b = al.at.get(m[k2]);
    if (a === undefined || b === undefined) continue;
    const left = al.ids
      .slice(Math.min(a, b), Math.max(a, b) + 1)
      .filter((id) => !gone.has(id));
    const next = { ...m, [k1]: left[0], [k2]: left[left.length - 1] };
    if (left.length === 0 || (next.r1 === next.r2 && next.c1 === next.c2)) {
      merges.delete(mergeId);
    } else {
      merges.set(mergeId, next);
    }
  }
}

export function insertRows(
  doc: Y.Doc,
  sheetId: string,
  at: number,
  count: number,
  origin?: unknown,
): void {
  insertAxis(doc, sheetId, 'rows', at, count, origin);
}

export function deleteRows(
  doc: Y.Doc,
  sheetId: string,
  at: number,
  count: number,
  origin?: unknown,
): void {
  deleteAxis(doc, sheetId, 'rows', at, count, origin);
}

export function insertCols(
  doc: Y.Doc,
  sheetId: string,
  at: number,
  count: number,
  origin?: unknown,
): void {
  insertAxis(doc, sheetId, 'cols', at, count, origin);
}

export function deleteCols(
  doc: Y.Doc,
  sheetId: string,
  at: number,
  count: number,
  origin?: unknown,
): void {
  deleteAxis(doc, sheetId, 'cols', at, count, origin);
}

function sameFormat(a: CellFormat | undefined, b: CellFormat | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.v === b.v && sameFormat(a.f, b.f);
}

function mergeKey(m: MergeRange): string {
  return `${m.r1}:${m.c1}:${m.r2}:${m.c2}`;
}

/**
 * Writes everything that is not structure: cells, formats, sizes, merges,
 * frozen counts. `prev` must be the tab as read from the document in the same
 * synchronous call; rows and columns change only through the functions above.
 */
export function writeSheetChange(
  doc: Y.Doc,
  prev: Sheet,
  next: Sheet,
  origin?: unknown,
): void {
  if (prev.rows !== next.rows || prev.cols !== next.cols) {
    throw new Error(
      'writeSheetChange cannot change the number of rows or columns',
    );
  }
  if (prev.id !== next.id) {
    throw new Error('writeSheetChange needs the same tab on both sides');
  }
  doc.transact(() => {
    const tab = tabOf(doc, prev.id);
    const layouts = new LayoutCache(doc);
    const layout = layouts.get(prev.id);
    // a tab emptied by concurrent deletes reads as 1x1; give that cell its ids
    if (layout.rows.ids.length === 0 || layout.cols.ids.length === 0) {
      growLayout(
        doc,
        layout,
        Math.max(1, layout.rows.ids.length),
        Math.max(1, layout.cols.ids.length),
      );
    }
    if (
      layout.rows.ids.length !== prev.rows ||
      layout.cols.ids.length !== prev.cols
    ) {
      throw new Error('The tab changed since it was read');
    }
    const rowIds = layout.rows.ids.slice();
    const colIds = layout.cols.ids.slice();

    if (next.name && next.name !== prev.name) {
      tab.set('name', cleanTabName(next.name) || prev.name);
    }
    for (const axis of ['rows', 'cols'] as const) {
      const key = frozenKey(axis);
      const want = clampCount(
        next[key as 'frozenRows' | 'frozenCols'],
        next[axis],
      );
      if (want !== prev[key as 'frozenRows' | 'frozenCols']) {
        tab.set(key, frozenValue(want, axis === 'rows' ? rowIds : colIds));
      }
    }

    const cells = mapOf<unknown>(tab, 'cells');
    const ctx = refContext(doc, layouts, prev.id, true);
    const keys = new Set([
      ...Object.keys(prev.cells),
      ...Object.keys(next.cells),
    ]);
    for (const key of keys) {
      const before = prev.cells[key];
      const after = next.cells[key];
      if (sameCell(before, after)) continue;
      const pos = parseKey(key);
      if (!pos || !rowIds[pos.row] || !colIds[pos.col]) continue;
      writeCell(cells, `${rowIds[pos.row]}:${colIds[pos.col]}`, after, ctx);
    }

    for (const [name, ids] of [
      ['colWidths', colIds],
      ['rowHeights', rowIds],
    ] as const) {
      const map = mapOf<number>(tab, name);
      const a = prev[name];
      const b = next[name];
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[k] === b[k]) continue;
        const id = ids[Number(k)];
        if (!id) continue;
        if (typeof b[k] === 'number') map.set(id, b[k]);
        else map.delete(id);
      }
    }

    const merges = mapOf<IdMerge>(tab, 'merges');
    const before = new Set(prev.merges.map(mergeKey));
    const after = new Set(next.merges.map(mergeKey));
    for (const [mergeId, m] of [...merges.entries()]) {
      const range = mergePositions(m, layout);
      if (range && before.has(mergeKey(range)) && !after.has(mergeKey(range))) {
        merges.delete(mergeId);
      }
    }
    for (const m of next.merges) {
      if (before.has(mergeKey(m))) continue;
      if (!rowIds[m.r1] || !rowIds[m.r2] || !colIds[m.c1] || !colIds[m.c2])
        continue;
      merges.set(newLayoutId(), {
        r1: rowIds[m.r1],
        c1: colIds[m.c1],
        r2: rowIds[m.r2],
        c2: colIds[m.c2],
      });
    }
  }, origin);
}

/** Tabs only: add, rename, reorder, delete. */
export function writeBookChange(
  doc: Y.Doc,
  prev: SheetBook,
  next: SheetBook,
  origin?: unknown,
): void {
  doc.transact(() => {
    const order = sheetOrder(doc);
    const prevIds = prev.sheets.map((s) => s.id);
    const nextIds = next.sheets.map((s) => s.id);
    const prevSet = new Set(prevIds);
    const nextSet = new Set(nextIds);

    // a deleted tab leaves the order only, so an undo restores it whole
    for (const id of prevIds) {
      if (nextSet.has(id)) continue;
      const raw = order.toArray();
      for (let i = raw.length - 1; i >= 0; i--) {
        if (raw[i] === id) order.delete(i, 1);
      }
    }

    const tabs = sheetTabs(doc);
    for (const sheet of next.sheets) {
      if (!prevSet.has(sheet.id)) continue;
      const before = prev.sheets.find((s) => s.id === sheet.id);
      const tab = tabs.get(sheet.id);
      if (tab && sheet.name && before && sheet.name !== before.name) {
        tab.set('name', cleanTabName(sheet.name) || 'Sheet');
      }
    }

    const added: [string, Sheet][] = [];
    const finalIds = nextIds.map((id, i) => {
      if (prevSet.has(id)) return id;
      const created = createTab(doc, next.sheets[i]);
      added.push([created, next.sheets[i]]);
      return created;
    });

    const kept = nextIds.filter((id) => prevSet.has(id));
    const keptBefore = prevIds.filter((id) => nextSet.has(id));
    // Only tabs that moved are deleted and inserted again: rewriting the
    // whole order would bring back a tab someone deleted meanwhile. The tabs
    // that stay put are the longest run already in order.
    const stay = longestInOrder(kept, keptBefore);
    for (let i = 0; i < finalIds.length; i++) {
      const id = finalIds[i];
      if (prevSet.has(nextIds[i]) && stay.has(id)) continue;
      const raw = order.toArray();
      for (let j = raw.length - 1; j >= 0; j--) {
        if (raw[j] === id) order.delete(j, 1);
      }
      const now = order.toArray();
      const before = i > 0 ? now.indexOf(finalIds[i - 1]) : -1;
      order.insert(before + 1, [id]);
    }

    const layouts = new LayoutCache(doc);
    for (const [id, sheet] of added) fillTab(doc, layouts, id, sheet);
  }, origin);
}

/** The ids of `next` that form the longest run in the same order as `prev`. */
function longestInOrder(next: string[], prev: string[]): Set<string> {
  const rank = next.map((id) => prev.indexOf(id));
  const len: number[] = [];
  const back: number[] = [];
  for (let i = 0; i < rank.length; i++) {
    len[i] = 1;
    back[i] = -1;
    for (let j = 0; j < i; j++) {
      if (rank[j] < rank[i] && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        back[i] = j;
      }
    }
  }
  let end = -1;
  for (let i = 0; i < len.length; i++)
    if (end < 0 || len[i] > len[end]) end = i;
  const out = new Set<string>();
  for (let i = end; i >= 0; i = back[i]) out.add(next[i]);
  return out;
}
