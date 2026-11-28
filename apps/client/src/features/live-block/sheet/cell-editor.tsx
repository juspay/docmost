import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { sheet as S } from "@docmost/live-blocks";
import { useTranslation } from "react-i18next";
import type { GridHandle } from "./grid";
import type { CellIds } from "./use-sheet-book";
import type { CellPos, GridSelectionApi } from "./use-grid-selection";
import classes from "./sheet.module.css";

// a reference may follow any of these (spaces ignored)
const REF_FOLLOWS = /[=(,+\-*/^&<>:;%]$/;

/**
 * Inserts a reference at the caret of a formula being typed. `span` is the
 * reference inserted by the previous click; clicking again replaces it.
 * Null when the text is not a formula or a reference cannot go there.
 */
export function insertReference(
  value: string,
  caret: number,
  ref: string,
  span: [number, number] | null,
): { value: string; span: [number, number] } | null {
  if (!value.startsWith("=")) return null;
  if (span && caret === span[1]) {
    const next = value.slice(0, span[0]) + ref + value.slice(span[1]);
    return { value: next, span: [span[0], span[0] + ref.length] };
  }
  const before = value.slice(0, caret).trimEnd();
  if (!REF_FOLLOWS.test(before)) return null;
  return {
    value: value.slice(0, caret) + ref + value.slice(caret),
    span: [caret, caret + ref.length],
  };
}

function a1Range(a: CellPos, b: CellPos): string {
  const r1 = Math.min(a.row, b.row);
  const r2 = Math.max(a.row, b.row);
  const c1 = Math.min(a.col, b.col);
  const c2 = Math.max(a.col, b.col);
  const start = S.toA1(r1, c1);
  return r1 === r2 && c1 === c2 ? start : `${start}:${S.toA1(r2, c2)}`;
}

export type EditState = {
  sheetId: string;
  row: number;
  col: number;
  original: string;
  value: string;
  /** "enter": started by typing, arrows leave the cell; "edit": arrows move the caret */
  mode: "enter" | "edit";
  source: "cell" | "bar";
  caret: number;
  refSpan: [number, number] | null;
  refStart: CellPos | null;
  /** the cell's stable ids: the edit follows its cell when rows or columns move */
  ids: CellIds | null;
};

type EditingArgs = {
  sheet: S.Sheet;
  sel: GridSelectionApi;
  readOnly: boolean;
  setCell(sheetId: string, row: number, col: number, input: string): void;
  gridRef: RefObject<GridHandle | null>;
  /** changes whenever the document does */
  version: number;
  cellIds(sheetId: string, row: number, col: number): CellIds | null;
  cellAt(sheetId: string, ids: CellIds): CellPos | null;
};

export function useCellEditing({
  sheet,
  sel,
  readOnly,
  setCell,
  gridRef,
  version,
  cellIds,
  cellAt,
}: EditingArgs) {
  const [edit, setEdit] = useState<EditState | null>(null);
  const editRef = useRef(edit);
  editRef.current = edit;
  // the input being typed in (cell editor or formula bar), for its caret
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  // switching tab or losing write access ends an edit without saving
  useEffect(() => {
    if (edit && (edit.sheetId !== sheet.id || readOnly)) setEdit(null);
  }, [sheet.id, readOnly, edit]);

  const start = useCallback(
    (initial?: string, source: "cell" | "bar" = "cell") => {
      if (readOnly) return;
      const { row, col } = sel.selection.anchor;
      const original = S.getRaw(sheet, row, col);
      const value = initial ?? original;
      setEdit({
        sheetId: sheet.id,
        row,
        col,
        original,
        value,
        mode: initial !== undefined ? "enter" : "edit",
        source,
        caret: value.length,
        refSpan: null,
        refStart: null,
        ids: cellIds(sheet.id, row, col),
      });
    },
    [readOnly, sel.selection.anchor, sheet, cellIds],
  );

  // another person inserted or deleted rows or columns: the edit follows its
  // cell, and ends unsaved if the cell itself was deleted
  useEffect(() => {
    const current = editRef.current;
    if (!current?.ids) return;
    const pos = cellAt(current.sheetId, current.ids);
    if (!pos) {
      setEdit(null);
      return;
    }
    if (pos.row !== current.row || pos.col !== current.col) {
      setEdit({ ...current, row: pos.row, col: pos.col });
      sel.select(pos.row, pos.col, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const commit = useCallback(
    (dRow: number, dCol: number) => {
      let current = editRef.current;
      if (!current) return;
      const pos = current.ids ? cellAt(current.sheetId, current.ids) : current;
      if (!pos) {
        setEdit(null);
        return;
      }
      current = { ...current, row: pos.row, col: pos.col };
      if (current.value !== current.original) {
        setCell(current.sheetId, current.row, current.col, current.value);
      }
      setEdit(null);
      sel.select(current.row, current.col, false);
      if (dRow || dCol) sel.move(dRow, dCol, false);
      gridRef.current?.focus();
    },
    [setCell, sel, gridRef, cellAt],
  );

  /** Commits without moving the selection or the focus (flush, unmount). */
  const flush = useCallback(() => {
    const current = editRef.current;
    if (!current) return;
    const pos = current.ids ? cellAt(current.sheetId, current.ids) : current;
    editRef.current = null;
    if (pos && current.value !== current.original) {
      setCell(current.sheetId, pos.row, pos.col, current.value);
    }
    setEdit(null);
  }, [cellAt, setCell]);

  /**
   * Leaving the editor keeps what was typed, as in Sheets. Focus moving to the
   * other input of the same edit (formula bar or cell) does not end it; a
   * press on a cell is handled by onCellPointerDown (a reference or a commit).
   */
  const blur = useCallback(
    (next: Element | null) => {
      if (!editRef.current) return;
      if (
        next?.closest?.(
          "[data-cell-editor], [data-formula-input], [data-sheet-grid]",
        )
      )
        return;
      // the value is kept, and the focus stays where the user put it
      flush();
    },
    [flush],
  );

  const cancel = useCallback(() => {
    editRef.current = null;
    setEdit(null);
    gridRef.current?.focus();
  }, [gridRef]);

  const change = useCallback((value: string, caret: number) => {
    setEdit((e) =>
      e ? { ...e, value, caret, refSpan: null, refStart: null } : e,
    );
  }, []);

  const setCaret = useCallback((caret: number) => {
    setEdit((e) => (e && e.caret !== caret ? { ...e, caret } : e));
  }, []);

  /** A press on a cell while editing: a formula takes a reference, anything else commits. */
  const onCellPointerDown = useCallback(
    (pos: CellPos, _e: ReactPointerEvent) => {
      const current = editRef.current;
      if (!current) return false;
      if (current.row === pos.row && current.col === pos.col) return true;
      const input = inputRef.current;
      const caret =
        input && document.activeElement === input
          ? (input.selectionStart ?? current.caret)
          : current.caret;
      const next = insertReference(
        current.value,
        caret,
        S.toA1(pos.row, pos.col),
        current.refSpan,
      );
      if (next) {
        setEdit({
          ...current,
          value: next.value,
          caret: next.span[1],
          refSpan: next.span,
          refStart: pos,
        });
        return true;
      }
      commit(0, 0);
      return false;
    },
    [commit],
  );

  /** Dragging after a reference click turns it into a range. */
  const onCellPointerEnter = useCallback((pos: CellPos) => {
    const current = editRef.current;
    if (!current?.refStart || !current.refSpan) return Boolean(current);
    const next = insertReference(
      current.value,
      current.refSpan[1],
      a1Range(current.refStart, pos),
      current.refSpan,
    );
    if (next)
      setEdit({
        ...current,
        value: next.value,
        caret: next.span[1],
        refSpan: next.span,
      });
    return true;
  }, []);

  return {
    edit,
    inputRef,
    start,
    commit,
    blur,
    flush,
    cancel,
    change,
    setCaret,
    onCellPointerDown,
    onCellPointerEnter,
  };
}

export type CellEditing = ReturnType<typeof useCellEditing>;

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/** Keys shared by the in-cell editor and the formula bar. True when handled. */
export function editorKey(
  e: KeyboardEvent<HTMLElement>,
  editing: CellEditing,
): boolean {
  const edit = editing.edit;
  if (!edit) return false;
  e.stopPropagation();
  if (e.key === "Enter" && !e.altKey) {
    e.preventDefault();
    editing.commit(e.shiftKey ? -1 : 1, 0);
    return true;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    editing.commit(0, e.shiftKey ? -1 : 1);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    editing.cancel();
    return true;
  }
  const arrow = ARROWS[e.key];
  if (arrow && edit.mode === "enter" && !edit.value.startsWith("=")) {
    e.preventDefault();
    editing.commit(arrow[0], arrow[1]);
    return true;
  }
  return false;
}

export function CellEditor({ editing }: { editing: CellEditing }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  const edit = editing.edit;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    editing.inputRef.current = el;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // keep the caret after a reference inserted by a click
  useEffect(() => {
    const el = ref.current;
    if (
      el &&
      edit &&
      el.selectionStart !== edit.caret &&
      document.activeElement === el
    ) {
      el.setSelectionRange(edit.caret, edit.caret);
    }
  }, [edit]);

  if (!edit) return null;
  return (
    <textarea
      ref={ref}
      className={classes.editor}
      data-cell-editor
      aria-label={t("Cell")}
      value={edit.value}
      spellCheck={false}
      onChange={(e) =>
        editing.change(
          e.target.value,
          e.target.selectionStart ?? e.target.value.length,
        )
      }
      onSelect={(e) => editing.setCaret(e.currentTarget.selectionStart ?? 0)}
      onKeyDown={(e) => {
        if (editorKey(e, editing)) return;
        if (e.key === "Enter" && e.altKey) {
          e.preventDefault();
          const el = e.currentTarget;
          const at = el.selectionStart ?? edit.value.length;
          const value =
            edit.value.slice(0, at) +
            "\n" +
            edit.value.slice(el.selectionEnd ?? at);
          editing.change(value, at + 1);
        }
      }}
      onBlur={(e) => editing.blur(e.relatedTarget as Element | null)}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
