import {
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as Y from "yjs";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { sheet as S } from "@docmost/live-blocks";
import { useBlockUndo } from "../hooks/use-block-undo";
import { CellEditor, useCellEditing } from "./cell-editor";
import {
  clampPaste,
  MAX_PASTE_CHARS,
  pasteGrid,
  PasteTooLarge,
  serializeRange,
  usedRange,
} from "./clipboard";
import { engineDisplay } from "./display";
import { FindReplaceBar } from "./find-replace.tsx";
import { FormulaBar } from "./formula-bar";
import { Grid, type GridHandle } from "./grid";
import { SheetTabs } from "./sheet-tabs";
import { SheetToolbar, StructureTools } from "./sheet-toolbar";
import { type ContextMenuState, GridContextMenu } from "./grid-context-menu";
import { ResizeHandle } from "./grid-headers";
import { useFillHandle } from "./fill-handle";
import {
  applyFill,
  applySort,
  freezeTo,
  mergeRange,
  sortRange,
  unmergeRange,
} from "./structure-actions";
import { type ResizeTarget, useResize, withResizePreview } from "./use-resize";
import { type FlagKey, toggleFlag } from "./format-actions";
import { type CellPos, useGridSelection } from "./use-grid-selection";
import {
  type ProviderLike,
  useRemoteSelections,
} from "./use-remote-selections";
import { useSheetBook } from "./use-sheet-book";
import classes from "./sheet.module.css";

type WorkspaceProps = {
  doc: Y.Doc;
  provider?: ProviderLike | null;
  readOnly: boolean;
  style?: CSSProperties;
  /** the room's flush: runs before the block's provider goes away */
  registerFlush?: (fn: () => void) => () => void;
};

const NO_MATCHES = new Map<string, "match" | "current">();

/** The live spreadsheet: formula bar, grid and tabs over one document. */
export function SheetWorkspace({
  doc,
  provider,
  readOnly,
  style,
  registerFlush,
}: WorkspaceProps) {
  const { t } = useTranslation();
  const api = useSheetBook(doc, readOnly);
  const { book, engine, version } = api;
  const fallback = useMemo(() => S.createEmptyBook(), []);
  const sheets = book.sheets.length > 0 ? book.sheets : fallback.sheets;

  // the active tab belongs to this person only
  const [activeId, setActiveId] = useState<string | null>(null);
  const sheet = sheets.find((s) => s.id === activeId) ?? sheets[0];
  const sel = useGridSelection(sheet);
  const gridRef = useRef<GridHandle>(null);
  const display = useMemo(
    () => engineDisplay(engine, sheet),
    // cells change in place; version marks each change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, sheet, version],
  );

  const undoScope = useMemo(() => [S.sheetOrder(doc), S.sheetTabs(doc)], [doc]);
  const undo = useBlockUndo(doc, undoScope);
  const editing = useCellEditing({
    sheet,
    sel,
    readOnly,
    setCell: api.setCell,
    gridRef,
    version,
    cellIds: api.cellIds,
    cellAt: api.cellAt,
  });
  // a value being typed is written before the block goes away: on the room's
  // flush, and when this view unmounts (the full window opening, scrolling off)
  const flushEdit = useRef(editing.flush);
  flushEdit.current = editing.flush;
  useEffect(() => {
    const flush = () => flushEdit.current();
    const unregister = registerFlush?.(flush);
    return () => {
      unregister?.();
      flush();
    };
  }, [registerFlush]);
  const remote = useRemoteSelections(provider, sheet.id, sel.selection);
  const [findOpen, setFindOpen] = useState(false);
  const [found, setFound] = useState(NO_MATCHES);

  /** A change to the selected range, made on a copy of the tab: one undo step. */
  const applyToRange = useCallback(
    (mutate: (draft: S.Sheet, range: S.MergeRange) => void) => {
      const range = sel.range();
      api.applyToSheet(sheet.id, (draft) => mutate(draft, range));
      // after a menu closes, keys belong to the grid again, not the page
      requestAnimationFrame(() => gridRef.current?.focus());
    },
    [api, sel, sheet.id],
  );
  const valueAt = useCallback(
    (row: number, col: number) => engine.getValue(sheet.id, row, col),
    [engine, sheet.id],
  );

  // ---- structure ----
  const resize = useResize(
    useCallback(
      (target: ResizeTarget, size: number) =>
        api.applyToSheet(sheet.id, (draft) =>
          target.kind === "col"
            ? S.setColWidth(draft, target.index, size)
            : S.setRowHeight(draft, target.index, size),
        ),
      [api, sheet.id],
    ),
  );
  const drawnSheet = withResizePreview(sheet, resize.preview);
  const cellAtPoint = useRef<((x: number, y: number) => CellPos | null) | null>(
    null,
  );
  const fill = useFillHandle({
    sel,
    cellAtPoint,
    onFill: useCallback(
      (source: S.MergeRange, target: S.MergeRange) => {
        api.applyToSheet(sheet.id, (draft) => applyFill(draft, source, target));
        sel.setSelection({
          anchor: { row: target.r1, col: target.c1 },
          focus: { row: target.r2, col: target.c2 },
        });
      },
      [api, sheet.id, sel],
    ),
  });
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const structureActions = useMemo(() => {
    const r = () => sel.range();
    return {
      insertRows: (where: "above" | "below") => {
        const range = r();
        const n = range.r2 - range.r1 + 1;
        api.structure.insertRows(
          sheet.id,
          where === "above" ? range.r1 : range.r2 + 1,
          n,
        );
      },
      insertCols: (where: "left" | "right") => {
        const range = r();
        const n = range.c2 - range.c1 + 1;
        api.structure.insertCols(
          sheet.id,
          where === "left" ? range.c1 : range.c2 + 1,
          n,
        );
      },
      deleteRows: () => {
        const range = r();
        api.structure.deleteRows(sheet.id, range.r1, range.r2 - range.r1 + 1);
      },
      deleteCols: () => {
        const range = r();
        api.structure.deleteCols(sheet.id, range.c1, range.c2 - range.c1 + 1);
      },
      clear: () => {
        api.applyToSheet(sheet.id, (d) => {
          const range = usedRange(d, r());
          S.clearRangeContents(d, range.r1, range.c1, range.r2, range.c2);
        });
      },
      merge: () => applyToRange((d, range) => mergeRange(d, range)),
      unmerge: () => applyToRange((d, range) => unmergeRange(d, range)),
    };
  }, [api, sel, sheet.id, applyToRange]);
  const sortBy = useCallback(
    (ascending: boolean) => {
      const range = sortRange(sheet, sel.range());
      const col = Math.min(
        Math.max(sel.selection.anchor.col, range.c1),
        range.c2,
      );
      let ok = true;
      api.applyToSheet(sheet.id, (d) => {
        ok = applySort(d, range, col, ascending, valueAt);
      });
      if (!ok) {
        notifications.show({
          color: "yellow",
          message: t("A range with merged cells cannot be sorted"),
        });
      }
    },
    [api, sheet, sel, valueAt, t],
  );

  // clears only the part of the selection that holds cells (a whole-sheet
  // selection would otherwise walk 3.5 million positions)
  const clearSelection = useCallback(() => {
    api.applyToSheet(sheet.id, (draft) => {
      const r = usedRange(draft, sel.range());
      S.clearRangeContents(draft, r.r1, r.c1, r.r2, r.c2);
    });
  }, [api, sel, sheet.id]);

  const gotoCell = useCallback(
    (pos: CellPos) => {
      sel.select(pos.row, pos.col, false);
      gridRef.current?.scrollToCell(pos);
    },
    [sel],
  );

  // ---- clipboard ----
  const onCopy = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const { text, html } = serializeRange(book, sheet.id, sel.range());
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData.setData("text/plain", text);
      e.clipboardData.setData("text/html", html);
    },
    [book, sheet.id, sel],
  );

  const onCut = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      onCopy(e);
      if (!readOnly) clearSelection();
    },
    [onCopy, readOnly, clearSelection],
  );

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (readOnly) return;
      const r = sel.range();
      const at = { row: r.r1, col: r.c1 };
      const html = e.clipboardData.getData("text/html") || undefined;
      const text = e.clipboardData.getData("text/plain");
      if (text.length + (html?.length ?? 0) > MAX_PASTE_CHARS) {
        notifications.show({
          color: "yellow",
          message: t("This is too much to paste into a spreadsheet at once"),
        });
        return;
      }
      let parsed: string[][];
      try {
        parsed = pasteGrid(text, html, at);
      } catch (err) {
        if (!(err instanceof PasteTooLarge)) throw err;
        notifications.show({
          color: "yellow",
          message: t("This is too much to paste into a spreadsheet at once"),
        });
        return;
      }
      const { data, dropped } = clampPaste(sheet, at, parsed);
      if (data.length === 0) return;
      api.applyToSheet(sheet.id, (draft) => {
        data.forEach((row, i) =>
          row.forEach((value, j) =>
            S.setCellRaw(draft, at.row + i, at.col + j, value),
          ),
        );
      });
      const width = Math.max(...data.map((row) => row.length));
      // the pasted range is selected; the view stays where the paste began
      gridRef.current?.holdScroll();
      sel.setSelection({
        anchor: at,
        focus: {
          row: at.row + data.length - 1,
          col: at.col + Math.max(0, width - 1),
        },
      });
      if (dropped > 0) {
        notifications.show({
          color: "yellow",
          message: t(
            "{{count}} cells did not fit in the sheet and were not pasted",
            {
              count: dropped,
            },
          ),
        });
      }
    },
    [readOnly, sel, sheet, api, t],
  );

  // ---- tabs ----
  const addTab = useCallback(() => {
    let created: string | null = null;
    api.applyToBook((draft) => {
      created = S.addSheet(draft).id;
    });
    if (created) setActiveId(created);
  }, [api]);
  const renameTab = useCallback(
    (id: string, name: string) =>
      api.applyToBook((draft) => S.renameSheet(draft, id, name)),
    [api],
  );
  const deleteTab = useCallback(
    (id: string) => api.applyToBook((draft) => S.removeSheet(draft, id)),
    [api],
  );
  const moveTab = useCallback(
    (id: string, beforeId: string) =>
      api.applyToBook((draft) => {
        const from = draft.sheets.findIndex((s) => s.id === id);
        if (from < 0) return;
        const [moved] = draft.sheets.splice(from, 1);
        const to = draft.sheets.findIndex((s) => s.id === beforeId);
        draft.sheets.splice(to < 0 ? draft.sheets.length : to, 0, moved);
      }),
    [api],
  );

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
        return true;
      };
      if (mod && key === "z") {
        undo.onKeyDown(e);
        return true;
      }
      if (mod && key === "y") {
        undo.redo();
        return handled();
      }
      if (mod && key === "f") {
        setFindOpen(true);
        return handled();
      }
      const flags: Record<string, FlagKey> = {
        b: "bold",
        i: "italic",
        u: "underline",
      };
      if (mod && !e.shiftKey && flags[key] && !readOnly) {
        applyToRange((draft, range) => toggleFlag(draft, range, flags[key]));
        return handled();
      }
      // copy, cut and paste come as clipboard events
      if (mod && (key === "c" || key === "x" || key === "v")) {
        e.stopPropagation();
        return true;
      }
      if (readOnly) return false;
      if (e.key === "F2") {
        editing.start();
        return handled();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        clearSelection();
        return handled();
      }
      if (e.key.length === 1 && !mod && !e.altKey) {
        editing.start(e.key);
        return handled();
      }
      return false;
    },
    [undo, readOnly, editing, clearSelection, applyToRange],
  );

  const edit = editing.edit;
  const anchor = sel.selection.anchor;
  const editingHere =
    edit &&
    edit.source === "cell" &&
    edit.row === anchor.row &&
    edit.col === anchor.col;

  return (
    <div
      className={classes.workspace}
      style={style}
      data-sheet-live
      // Cmd+Z on a toolbar button or tab is this sheet's undo (the grid stops its own keys first)
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("input, textarea")) return;
        const key = e.key.toLowerCase();
        if (!(e.metaKey || e.ctrlKey) || (key !== "z" && key !== "y")) return;
        e.preventDefault();
        e.stopPropagation();
        if (key === "y" || e.shiftKey) undo.redo();
        else undo.undo();
      }}
    >
      {!readOnly && (
        <SheetToolbar
          sheet={sheet}
          range={sel.range()}
          active={anchor}
          apply={applyToRange}
          valueAt={valueAt}
          version={version}
        >
          <StructureTools
            merged={sheet.merges.some((m) => {
              const range = sel.range();
              return (
                m.r1 <= range.r2 &&
                m.r2 >= range.r1 &&
                m.c1 <= range.c2 &&
                m.c2 >= range.c1
              );
            })}
            canMerge={(() => {
              const range = sel.range();
              return range.r1 !== range.r2 || range.c1 !== range.c2;
            })()}
            active={anchor}
            frozen={{ rows: sheet.frozenRows, cols: sheet.frozenCols }}
            onMerge={structureActions.merge}
            onUnmerge={structureActions.unmerge}
            onFreeze={(rows, cols) =>
              api.applyToSheet(sheet.id, (d) => freezeTo(d, rows, cols))
            }
            onSort={sortBy}
          />
        </SheetToolbar>
      )}
      <FormulaBar
        sheet={sheet}
        active={anchor}
        editing={editing}
        readOnly={readOnly}
      />
      <Grid
        ref={gridRef}
        sheet={drawnSheet}
        display={display}
        sel={sel}
        readOnly={readOnly}
        onKey={onKey}
        onCopy={onCopy}
        onCut={onCut}
        onPaste={onPaste}
        onCompose={(text) => {
          if (!readOnly && !editing.edit) editing.start(text);
        }}
        onCellPointerDown={editing.onCellPointerDown}
        onCellPointerEnter={(pos) =>
          edit ? editing.onCellPointerEnter(pos) : false
        }
        onCellDoubleClick={() => editing.start()}
        renderInActive={
          editingHere ? () => <CellEditor editing={editing} /> : undefined
        }
        remote={remote}
        found={found}
        cellAtPointRef={cellAtPoint}
        fillPreview={fill.preview}
        onFillHandlePointerDown={readOnly ? undefined : fill.onPointerDown}
        renderHeaderExtra={
          readOnly
            ? undefined
            : (target) => (
                <ResizeHandle
                  target={target}
                  onStart={(e) =>
                    resize.start(
                      e,
                      target,
                      target.kind === "col"
                        ? (sheet.colWidths[target.index] ?? S.DEFAULT_COL_WIDTH)
                        : (sheet.rowHeights[target.index] ??
                            S.DEFAULT_ROW_HEIGHT),
                    )
                  }
                />
              )
        }
        onContextMenu={
          readOnly
            ? undefined
            : (e, target) => {
                if (target.kind === "row") {
                  const r = sel.range();
                  if (target.index < r.r1 || target.index > r.r2) {
                    sel.setSelection({
                      anchor: { row: target.index, col: 0 },
                      focus: { row: target.index, col: sheet.cols - 1 },
                    });
                  }
                } else if (target.kind === "col") {
                  const r = sel.range();
                  if (target.index < r.c1 || target.index > r.c2) {
                    sel.setSelection({
                      anchor: { row: 0, col: target.index },
                      focus: { row: sheet.rows - 1, col: target.index },
                    });
                  }
                }
                setMenu({ x: e.clientX, y: e.clientY, kind: target.kind });
              }
        }
      />
      {!readOnly && (
        <GridContextMenu
          state={menu}
          range={sel.range()}
          sheet={sheet}
          onClose={() => {
            setMenu(null);
            gridRef.current?.focus();
          }}
          actions={structureActions}
        />
      )}
      {findOpen && (
        <FindReplaceBar
          sheet={sheet}
          version={version}
          readOnly={readOnly}
          onClose={() => {
            setFindOpen(false);
            gridRef.current?.focus();
          }}
          onGoto={gotoCell}
          setCell={(row, col, input) => api.setCell(sheet.id, row, col, input)}
          applyToSheet={(mutate) => api.applyToSheet(sheet.id, mutate)}
          onHighlight={setFound}
        />
      )}
      <SheetTabs
        sheets={sheets}
        activeId={sheet.id}
        onSelect={(id) => {
          if (edit) editing.commit(0, 0);
          setActiveId(id);
          // keys go back to the grid, unless a rename box opened meanwhile
          requestAnimationFrame(() => {
            if (!document.activeElement?.closest("input, textarea"))
              gridRef.current?.focus();
          });
        }}
        readOnly={readOnly}
        onAdd={addTab}
        onRename={renameTab}
        onDelete={deleteTab}
        onMove={moveTab}
      />
    </div>
  );
}
