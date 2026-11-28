import { useEffect, useMemo, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { sheet as S } from "@docmost/live-blocks";
import { LOCAL_ORIGIN } from "../hooks/use-block-undo";

type Book = S.SheetBook;
type Sheet = S.Sheet;

const CELLS = "cells";
const META_KEYS = new Set(["colWidths", "rowHeights", "merges"]);

/**
 * One book in memory, kept current from the document's change events. A cell
 * change updates that cell only; rows, columns and tabs re-read the book,
 * because every position after them moves.
 */
class SheetStore {
  book: Book;
  engine: S.Engine;
  version = 0;
  private layouts: S.LayoutCache;
  private listeners = new Set<() => void>();

  constructor(private readonly doc: Y.Doc) {
    this.layouts = new S.LayoutCache(doc);
    this.book = S.readBook(doc);
    this.engine = new S.Engine(this.book);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  start() {
    const tabs = S.sheetTabs(this.doc);
    const order = S.sheetOrder(this.doc);
    const onDeep = (events: Y.YEvent<any>[]) => this.apply(events);
    const onOrder = () => this.reread();
    tabs.observeDeep(onDeep);
    order.observe(onOrder);
    // the document may have changed between construction and start
    this.reread();
    return () => {
      tabs.unobserveDeep(onDeep);
      order.unobserve(onOrder);
    };
  }

  private sheetOf(id: string): Sheet | undefined {
    return this.book.sheets.find((s) => s.id === id);
  }

  private reread() {
    this.layouts = new S.LayoutCache(this.doc);
    this.book = S.readBook(this.doc);
    this.changed();
  }

  private changed() {
    this.engine = new S.Engine(this.book);
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private apply(events: Y.YEvent<any>[]) {
    const meta = new Set<string>();
    const cellEvents: Y.YMapEvent<unknown>[] = [];
    for (const event of events) {
      const path = event.path as string[];
      if (path.length === 2 && path[1] === CELLS) {
        cellEvents.push(event as Y.YMapEvent<unknown>);
      } else if (path.length === 2 && META_KEYS.has(path[1])) {
        meta.add(path[0]);
      } else if (
        path.length === 1 &&
        [...(event as Y.YMapEvent<unknown>).keysChanged].every(
          (k) => k === "frozenRows" || k === "frozenCols",
        )
      ) {
        meta.add(path[0]);
      } else {
        // tabs, names (formulas show them), rows or columns
        return this.reread();
      }
    }

    for (const event of cellEvents) {
      const tabId = event.path[0] as string;
      const sheet = this.sheetOf(tabId);
      const layout = this.layouts.get(tabId);
      if (!sheet || !layout) continue;
      const ctx = S.refContext(this.doc, this.layouts, tabId);
      const map = event.target as Y.Map<unknown>;
      for (const key of event.keysChanged) {
        const split = key.indexOf(":");
        const r = layout.rows.at.get(key.slice(0, split));
        const c = layout.cols.at.get(key.slice(split + 1));
        if (r === undefined || c === undefined) continue;
        const cell = map.has(key) ? S.decodeCell(map.get(key), ctx) : null;
        if (cell) sheet.cells[`${r}:${c}`] = cell;
        else delete sheet.cells[`${r}:${c}`];
      }
    }
    for (const tabId of meta) {
      const sheet = this.sheetOf(tabId);
      const next = S.readSheetMeta(this.doc, tabId, this.layouts);
      if (sheet && next) Object.assign(sheet, next);
    }
    this.changed();
  }
}

export type SheetStructure = {
  insertRows(sheetId: string, at: number, count: number): void;
  deleteRows(sheetId: string, at: number, count: number): void;
  insertCols(sheetId: string, at: number, count: number): void;
  deleteCols(sheetId: string, at: number, count: number): void;
};

export type SheetBookApi = {
  book: Book;
  engine: S.Engine;
  /** changes whenever the book does */
  version: number;
  setCell(sheetId: string, row: number, col: number, input: string): void;
  applyToSheet(sheetId: string, mutate: (draft: Sheet) => void): void;
  applyToBook(mutate: (draft: Book) => void): void;
  structure: SheetStructure;
  /** the stable ids of a position, so work in progress can follow its cell */
  cellIds(sheetId: string, row: number, col: number): CellIds | null;
  /** where those ids are now; null when the row, column or tab is gone */
  cellAt(sheetId: string, ids: CellIds): { row: number; col: number } | null;
};

export type CellIds = { rowId: string; colId: string };

export function useSheetBook(doc: Y.Doc, readOnly: boolean): SheetBookApi {
  const store = useMemo(() => new SheetStore(doc), [doc]);
  useEffect(() => store.start(), [store]);
  const version = useSyncExternalStore(store.subscribe, store.getVersion);

  const actions = useMemo(() => {
    const local = (fn: () => void) => {
      if (readOnly) return;
      doc.transact(fn, LOCAL_ORIGIN);
    };
    const structure: SheetStructure = {
      insertRows: (id, at, n) => local(() => S.insertRows(doc, id, at, n)),
      deleteRows: (id, at, n) => local(() => S.deleteRows(doc, id, at, n)),
      insertCols: (id, at, n) => local(() => S.insertCols(doc, id, at, n)),
      deleteCols: (id, at, n) => local(() => S.deleteCols(doc, id, at, n)),
    };
    return {
      setCell(sheetId: string, row: number, col: number, input: string) {
        local(() => {
          const f = store.book.sheets.find((s) => s.id === sheetId)?.cells[
            `${row}:${col}`
          ]?.f;
          const cell =
            input === "" && !f ? null : f ? { v: input, f } : { v: input };
          S.setCell(doc, sheetId, row, col, cell);
        });
      },
      applyToSheet(sheetId: string, mutate: (draft: Sheet) => void) {
        local(() => {
          const current = S.readSheet(doc, sheetId);
          if (!current) return;
          const next = structuredClone(current);
          mutate(next);
          // the ported functions grow a tab in place; the document grows by id
          const rows = Math.min(S.MAX_ROWS, Math.max(current.rows, next.rows));
          const cols = Math.min(S.MAX_COLS, Math.max(current.cols, next.cols));
          if (rows > current.rows || cols > current.cols) {
            S.ensureSheetSize(doc, sheetId, rows, cols);
          }
          next.rows = rows;
          next.cols = cols;
          S.writeSheetChange(doc, { ...current, rows, cols }, next);
        });
      },
      applyToBook(mutate: (draft: Book) => void) {
        local(() => {
          const current = S.readBook(doc);
          const next = structuredClone(current);
          mutate(next);
          S.writeBookChange(doc, current, next);
        });
      },
      structure,
      cellIds(sheetId: string, row: number, col: number): CellIds | null {
        const layout = S.readLayout(doc, sheetId);
        const rowId = layout?.rows.ids[row];
        const colId = layout?.cols.ids[col];
        return rowId && colId ? { rowId, colId } : null;
      },
      cellAt(sheetId: string, ids: CellIds) {
        if (!S.tabIds(doc).includes(sheetId)) return null;
        const layout = S.readLayout(doc, sheetId);
        const row = layout?.rows.at.get(ids.rowId);
        const col = layout?.cols.at.get(ids.colId);
        return row === undefined || col === undefined ? null : { row, col };
      },
    };
  }, [doc, readOnly, store]);

  return { book: store.book, engine: store.engine, version, ...actions };
}
