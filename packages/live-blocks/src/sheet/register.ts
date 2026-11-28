import * as Y from 'yjs';
import {
  MAX_CELLS_PER_OP,
  type LiveBlockOp,
  type SheetSetCellsOp,
} from '../ops';
import { registerKind } from '../registry';
import {
  LiveBlockInputError,
  SNAPSHOT_BUDGET_MS,
  SNAPSHOT_DISPLAY_CELLS,
  type SheetSnapshot,
} from '../snapshot';
import { parseCellAddress } from './address';
import { Engine, ERR_PARSE } from './engine';
import {
  createEmptyBook,
  MAX_COLS,
  MAX_ROWS,
  newSheet,
  parseBook,
  parseKey,
  type SheetBook,
} from './model';
import { sheetToTableNodes } from './table';
import {
  FIRST_TAB_ID,
  cleanTabName,
  MAX_TAB_NAME,
  MAX_MERGES_READ,
  MAX_TABS_READ,
  MAX_TEXT,
  readBook,
  seedSheet,
  setCells,
  writeBookChange,
} from './ydoc';

/** Shown under a table whose snapshot stops before its last cell. */
export const TRUNCATED_TABLE_NOTICE = 'This table is too large to show in full';

/** Text (display plus raw input) a snapshot keeps before it stops. */
const SNAPSHOT_MAX_CHARS = 4_000_000;
/** Cells with a format and no value a snapshot keeps. */
const SNAPSHOT_FORMAT_ONLY_CELLS = 10_000;
/** Tabs a book from outside may have. */
export const MAX_TABS = MAX_TABS_READ;
/** Cells a whole book from outside may have (validate seeds it once). */
export const MAX_BOOK_CELLS = 1_000_000;
/** Merged ranges a sheet from outside may have. */
export const MAX_MERGES = MAX_MERGES_READ;

function emptyBook(): SheetBook {
  const book = createEmptyBook();
  book.sheets[0].id = FIRST_TAB_ID;
  book.activeSheetId = FIRST_TAB_ID;
  return book;
}

/**
 * Display strings of filled cells, row by row, within the cell cap, the size
 * cap and the time budget. The stored book keeps only what the display shows
 * (and a capped number of format-only cells), so a snapshot stays small.
 */
function snapshotOf(
  book: SheetBook,
  budgetMs: number = SNAPSHOT_BUDGET_MS,
): SheetSnapshot {
  const started = Date.now();
  const engine = new Engine(book, { deadline: started + budgetMs });
  const display: SheetSnapshot['display'] = Object.create(null);
  const kept: SheetBook = { ...book, sheets: [] };
  let shown = 0;
  let chars = 0;
  let formatOnly = 0;
  let truncated = false;
  let valuesStopped = false;
  for (const sheet of book.sheets) {
    const values: Record<string, string> = {};
    const cells: SheetBook['sheets'][number]['cells'] = {};
    display[sheet.id] = values;
    kept.sheets.push({ ...sheet, cells });
    const keys = Object.keys(sheet.cells)
      .map((key) => ({ key, pos: parseKey(key) }))
      .filter((k) => k.pos)
      .sort((a, b) => a.pos.row - b.pos.row || a.pos.col - b.pos.col);
    for (const { key, pos } of keys) {
      const cell = sheet.cells[key];
      if (cell.v === '') {
        // format-only cells have their own cap: dropping them never stops
        // the values that come after
        if (formatOnly < SNAPSHOT_FORMAT_ONLY_CELLS) {
          cells[key] = cell;
          formatOnly++;
        } else {
          truncated = true;
        }
        continue;
      }
      if (
        valuesStopped ||
        shown >= SNAPSHOT_DISPLAY_CELLS ||
        chars > SNAPSHOT_MAX_CHARS ||
        Date.now() - started > budgetMs
      ) {
        truncated = true;
        valuesStopped = true;
        continue;
      }
      let text: string;
      try {
        text = engine.display(sheet.id, pos.row, pos.col);
      } catch {
        text = ERR_PARSE;
      }
      values[key] = text;
      cells[key] = cell;
      chars += text.length + cell.v.length;
      shown++;
    }
  }
  // formulas the budget refused are not their real values
  if (engine.outOfBudget) truncated = true;
  return { kind: 'sheet', book: kept, display, truncated };
}

function limitError(): LiveBlockInputError {
  return new LiveBlockInputError(
    `A spreadsheet holds at most ${MAX_ROWS} rows and ${MAX_COLS} columns`,
  );
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function countOk(v: unknown, max: number): boolean {
  return (
    v === undefined ||
    (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max)
  );
}

/**
 * Refuses a book from outside that is malformed or over the limits, instead
 * of letting parseBook cut or empty it silently.
 */
function checkBook(raw: unknown): void {
  const bad = (why: string) =>
    new LiveBlockInputError(`Not a valid spreadsheet: ${why}`);
  if (!isObject(raw) || !Array.isArray(raw.sheets)) {
    throw new LiveBlockInputError('A spreadsheet needs a list of sheets');
  }
  if (raw.sheets.length === 0) throw bad('it has no sheets');
  if (raw.sheets.length > MAX_TABS) throw bad(`more than ${MAX_TABS} sheets`);
  const ids = new Set<string>();
  const names = new Set<string>();
  let cellCount = 0;
  for (const sheet of raw.sheets) {
    if (!isObject(sheet)) throw bad('a sheet is not an object');
    // the snapshot must match the document seeded from it: ids the document
    // would replace, and names it would number, are refused here
    if (sheet.id !== undefined) {
      if (
        typeof sheet.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(sheet.id) ||
        sheet.id === '__proto__'
      ) {
        throw bad(
          `the sheet id ${short(sheet.id)} is not letters, digits, - or _`,
        );
      }
      if (ids.has(sheet.id)) throw bad(`the sheet id ${sheet.id} repeats`);
      ids.add(sheet.id);
    }
    if (typeof sheet.name === 'string') {
      const key = cleanTabName(sheet.name).toLowerCase();
      if (key && names.has(key))
        throw bad(`the sheet name ${short(sheet.name)} repeats`);
      names.add(key);
    }
    if (
      sheet.name !== undefined &&
      (typeof sheet.name !== 'string' ||
        sheet.name.trim().length > MAX_TAB_NAME)
    ) {
      throw bad('a sheet name is not text');
    }
    if (typeof sheet.rows === 'number' && sheet.rows > MAX_ROWS)
      throw limitError();
    if (typeof sheet.cols === 'number' && sheet.cols > MAX_COLS)
      throw limitError();
    if (!countOk(sheet.rows, MAX_ROWS) || !countOk(sheet.cols, MAX_COLS)) {
      throw bad('rows and cols must be whole numbers from 1');
    }
    if (sheet.cells !== undefined && !isObject(sheet.cells))
      throw bad('cells is not an object');
    for (const [key, cell] of Object.entries((sheet.cells ?? {}) as object)) {
      // checked before the book is seeded into a scratch document
      if (++cellCount > MAX_BOOK_CELLS) {
        throw bad(`more than ${MAX_BOOK_CELLS} cells`);
      }
      const pos = parseKey(key);
      if (!pos) throw bad(`the cell key ${key} is not "row:col"`);
      if (pos.row >= MAX_ROWS || pos.col >= MAX_COLS) throw limitError();
      if (
        !isObject(cell) ||
        (cell.v !== undefined && typeof cell.v !== 'string')
      ) {
        throw bad(`the cell ${key} has no text value`);
      }
      if (typeof cell.v === 'string' && cell.v.length > MAX_TEXT) {
        throw bad(`the cell ${key} is longer than ${MAX_TEXT} characters`);
      }
    }
    if (sheet.merges !== undefined) {
      if (!Array.isArray(sheet.merges)) throw bad('merges is not a list');
      if (sheet.merges.length > MAX_MERGES) {
        throw bad(`more than ${MAX_MERGES} merged ranges in a sheet`);
      }
      for (const m of sheet.merges) {
        const ok =
          isObject(m) &&
          ['r1', 'c1', 'r2', 'c2'].every(
            (k) => Number.isInteger(m[k]) && (m[k] as number) >= 0,
          );
        if (!ok) throw bad('a merge is not four cell positions');
      }
    }
  }
}

function validate(input: unknown): SheetSnapshot {
  // a caller's display values are never trusted: they are computed here
  const raw = isObject(input) && 'book' in input ? input.book : input;
  let text: string;
  try {
    text = JSON.stringify(raw);
  } catch {
    throw new LiveBlockInputError('The spreadsheet is not valid JSON');
  }
  checkBook(raw);
  // The snapshot is built from the book as a seeded document reads it back:
  // names trimmed and numbered, ids kept, exactly what the seed will hold.
  const scratch = new Y.Doc();
  try {
    seedSheet(scratch, parseBook(text));
    return snapshotOf(readBook(scratch));
  } finally {
    scratch.destroy();
  }
}

function isSetCells(op: LiveBlockOp): op is SheetSetCellsOp {
  return op?.type === 'sheet.setCells';
}

/** Caller text in an error message, cut short. */
function short(text: unknown): string {
  const s = String(text);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

function applySetCells(doc: Y.Doc, op: SheetSetCellsOp): void {
  if (op.sheetId !== undefined && typeof op.sheetId !== 'string') {
    throw new LiveBlockInputError('sheetId must be text');
  }
  if (op.sheetName !== undefined && typeof op.sheetName !== 'string') {
    throw new LiveBlockInputError('sheetName must be text');
  }
  if (!Array.isArray(op.cells)) {
    throw new LiveBlockInputError('sheet.setCells needs a list of cells');
  }
  if (op.cells.length > MAX_CELLS_PER_OP) {
    throw new LiveBlockInputError(
      `sheet.setCells takes at most ${MAX_CELLS_PER_OP} cells; got ${op.cells.length}`,
    );
  }

  let book = readBook(doc);
  // names are compared the way they are stored: trimmed, capped, any case
  const norm = (name: string) => cleanTabName(name).toLowerCase();
  // a name that would be cut is refused: two cut names could be the same tab
  const checkLength = (name: unknown) => {
    if (typeof name === 'string' && name.trim().length > MAX_TAB_NAME) {
      throw new LiveBlockInputError(
        `A tab name holds at most ${MAX_TAB_NAME} characters`,
      );
    }
  };
  checkLength(op.sheetName);
  const byName = (name: string) =>
    book.sheets.find((s) => s.name.toLowerCase() === norm(name)) ?? null;
  // an empty document reports its first tab as FIRST_TAB_ID; that id is
  // accepted and the tab is made below
  const firstOfEmpty = book.sheets.length === 0 && op.sheetId === FIRST_TAB_ID;
  let target: string | null = null;
  if (op.sheetId !== undefined) {
    target = firstOfEmpty
      ? FIRST_TAB_ID
      : (book.sheets.find((s) => s.id === op.sheetId)?.id ?? null);
    if (!target)
      throw new LiveBlockInputError(`No tab with id ${short(op.sheetId)}`);
  } else if (op.sheetName !== undefined) {
    if (!cleanTabName(op.sheetName)) {
      throw new LiveBlockInputError('sheetName must not be empty');
    }
    target = byName(op.sheetName)?.id ?? null;
  }

  // check everything before writing: a refused op must leave the doc alone
  const writes: {
    tab: string | null;
    name: string | null;
    row: number;
    col: number;
    value: string;
  }[] = [];
  const missing = new Set<string>();
  let outside = 0;
  for (const cell of op.cells) {
    if (typeof cell?.value !== 'string') {
      throw new LiveBlockInputError(
        `The value of ${short(cell?.a1)} must be text`,
      );
    }
    if (cell.value.length > MAX_TEXT) {
      throw new LiveBlockInputError(
        `The value of ${short(cell.a1)} is longer than ${MAX_TEXT} characters`,
      );
    }
    if (typeof cell.a1 !== 'string') {
      throw new LiveBlockInputError('Every cell needs an a1 address');
    }
    const address = parseCellAddress(cell.a1);
    if (!address)
      throw new LiveBlockInputError(`Not a cell address: ${short(cell?.a1)}`);
    if (address.row >= MAX_ROWS || address.col >= MAX_COLS) {
      outside++;
      continue;
    }
    let tab = target;
    let name: string | null = null;
    if (address.sheetName !== undefined) {
      checkLength(address.sheetName);
      tab = byName(address.sheetName)?.id ?? null;
      if (!tab) name = cleanTabName(address.sheetName);
    } else if (!tab && op.sheetName !== undefined) {
      name = cleanTabName(op.sheetName);
    }
    if (name !== null && !name) {
      throw new LiveBlockInputError('A tab name must not be empty');
    }
    if (name) missing.add(name);
    writes.push({
      tab,
      name,
      row: address.row,
      col: address.col,
      value: cell.value,
    });
  }
  if (outside > 0) {
    throw new LiveBlockInputError(
      `${outside} ${outside === 1 ? 'cell is' : 'cells are'} outside ${MAX_ROWS} rows and ${MAX_COLS} columns`,
    );
  }
  if (missing.size > 0 && !op.createSheet) {
    throw new LiveBlockInputError(
      `No tab named ${short([...missing].join(', '))}; set createSheet to add it`,
    );
  }

  // an empty document also gets its first tab, unless a missing name is it
  const addsFirst = book.sheets.length === 0 && !missing.has('Sheet1') ? 1 : 0;
  if (book.sheets.length + missing.size + addsFirst > MAX_TABS) {
    throw new LiveBlockInputError(
      `A spreadsheet holds at most ${MAX_TABS} tabs`,
    );
  }
  if (missing.size > 0 || book.sheets.length === 0) {
    const next = structuredClone(book);
    if (book.sheets.length === 0) {
      // the same first tab an editor would make, so both converge on one
      const first = newSheet('Sheet1');
      first.id = FIRST_TAB_ID;
      next.sheets.push(first);
    }
    for (const name of missing) {
      if (!next.sheets.some((s) => s.name.toLowerCase() === norm(name))) {
        next.sheets.push(newSheet(name));
      }
    }
    writeBookChange(doc, book, next);
    book = readBook(doc);
    // the first tab of an empty document may have got another id (a stale
    // entry held 'sheet1'): writes addressed to 'sheet1' go to it
    if (target === FIRST_TAB_ID && !book.sheets.some((s) => s.id === target)) {
      target = book.sheets[0]?.id ?? null;
      for (const w of writes) if (w.tab === FIRST_TAB_ID) w.tab = target;
    }
  }
  const byTab = new Map<
    string,
    { row: number; col: number; cell: { v: string } | null }[]
  >();
  for (const w of writes) {
    // never the first tab by default: a write goes where it was addressed
    const tab =
      w.tab ??
      (w.name ? (byName(w.name)?.id ?? null) : null) ??
      (op.sheetId === undefined && op.sheetName === undefined && w.name === null
        ? book.sheets[0]?.id
        : null);
    if (!tab) {
      throw new LiveBlockInputError(
        `No tab named ${short(w.name ?? String(op.sheetName))}`,
      );
    }
    if (!byTab.has(tab)) byTab.set(tab, []);
    byTab.get(tab).push({
      row: w.row,
      col: w.col,
      cell: w.value === '' ? null : { v: w.value },
    });
  }
  for (const [tab, list] of byTab) setCells(doc, tab, list);
}

registerKind<SheetSnapshot>({
  kind: 'sheet',
  empty: () => snapshotOf(emptyBook()),
  build: (doc, options) => {
    const book = readBook(doc);
    return snapshotOf(
      book.sheets.length > 0 ? book : emptyBook(),
      options?.budgetMs,
    );
  },
  seed: (doc, snapshot) => {
    // a truncated snapshot keeps only part of the book: seeding from it would
    // lose the rest without a word
    if (snapshot.truncated) {
      throw new LiveBlockInputError(
        'This spreadsheet snapshot is incomplete and cannot be used to create a sheet',
      );
    }
    seedSheet(doc, snapshot.book);
  },
  validate,
  staticNodes: (snapshot, ctx) => {
    const sheets = (snapshot.book?.sheets ?? []).slice(0, MAX_TABS);
    const nodes: unknown[] = [];
    for (const sheet of sheets) {
      const table = sheetToTableNodes(snapshot, sheet);
      if (sheets.length > 1) {
        nodes.push({
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: sheet.name }],
        });
      }
      nodes.push(...table);
    }
    if (snapshot.truncated) {
      nodes.push({
        type: 'paragraph',
        content: [{ type: 'text', text: TRUNCATED_TABLE_NOTICE }],
      });
    }
    if (nodes.length === 0) {
      return [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `Spreadsheet: ${ctx.title || 'Untitled'}` },
          ],
        },
      ];
    }
    return nodes;
  },
  applyOp: (doc, op) => {
    if (!isSetCells(op)) {
      throw new LiveBlockInputError(
        `Unknown spreadsheet operation: ${String(op?.type)}`,
      );
    }
    applySetCells(doc, op);
  },
});
