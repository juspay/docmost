import {
  type ClipboardEvent,
  forwardRef,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import clsx from "clsx";
import { sheet as S } from "@docmost/live-blocks";
import { useTranslation } from "react-i18next";
import {
  EDGE_BOTTOM,
  EDGE_LEFT,
  EDGE_RIGHT,
  EDGE_TOP,
  type CellKind,
  GridCell,
} from "./grid-cell";
import type { CellPos, GridSelectionApi } from "./use-grid-selection";
import { useGridWindow, type Viewport, windowIndexes } from "./use-grid-window";
import classes from "./sheet.module.css";

export const HEADER_HEIGHT = 24;
export const HEADER_WIDTH = S.HEADER_WIDTH;

export type GridDisplay = (
  row: number,
  col: number,
) => { text: string; kind: CellKind };

export type RemoteCursor = {
  row: number;
  col: number;
  color: string;
  name: string;
};

export type HeaderTarget = { kind: "row" | "col"; index: number };

export type GridHandle = {
  focus(): void;
  scrollToCell(pos: CellPos): void;
  /** the next selection change keeps the scroll position (e.g. a paste) */
  holdScroll(): void;
};

type GridProps = {
  sheet: S.Sheet;
  display: GridDisplay;
  sel: GridSelectionApi;
  readOnly?: boolean;
  /** the parent sees keys first; true when it handled the key */
  onKey?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** true when the parent consumed the press (e.g. a formula reference) */
  onCellPointerDown?: (pos: CellPos, e: ReactPointerEvent) => boolean;
  onCellPointerEnter?: (pos: CellPos) => boolean;
  onCellDoubleClick?: (pos: CellPos) => void;
  onCopy?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onCut?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** composed input-method text typed on the grid */
  onCompose?: (text: string) => void;
  onContextMenu?: (
    e: ReactMouseEvent,
    target: HeaderTarget | { kind: "cell"; pos: CellPos },
  ) => void;
  /** drawn inside the active cell, e.g. the editor */
  renderInActive?: () => ReactNode;
  remote?: RemoteCursor[];
  found?: Map<string, "match" | "current">;
  /** header decorations such as resize handles */
  renderHeaderExtra?: (target: HeaderTarget) => ReactNode;
  /** fill handle drag: the range it would fill to, while dragging */
  fillPreview?: S.MergeRange | null;
  onFillHandlePointerDown?: (e: ReactPointerEvent) => void;
  /** the cell under a viewport point, for drags handled by the parent */
  cellAtPointRef?: {
    current: ((x: number, y: number) => CellPos | null) | null;
  };
};

const PAGE_ROWS = 20;

function posFromTarget(target: EventTarget | null): CellPos | null {
  const el = (target as HTMLElement | null)?.closest?.("[data-r][data-c]");
  if (!el) return null;
  return {
    row: Number(el.getAttribute("data-r")),
    col: Number(el.getAttribute("data-c")),
  };
}

export const Grid = forwardRef<GridHandle, GridProps>(
  function Grid(props, ref) {
    const { sheet, sel, display } = props;
    const { t } = useTranslation();
    const rootRef = useRef<HTMLDivElement>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const sinkRef = useRef<HTMLTextAreaElement>(null);
    const [viewport, setViewport] = useState<Viewport>({
      scrollTop: 0,
      scrollLeft: 0,
      width: 600,
      height: 300,
    });
    const [scrollbar, setScrollbar] = useState({ x: 0, y: 0 });
    const win = useGridWindow(sheet, viewport);

    const measure = useCallback(() => {
      const el = scrollerRef.current;
      if (!el) return;
      setViewport({
        scrollTop: el.scrollTop,
        scrollLeft: el.scrollLeft,
        width: Math.max(0, el.clientWidth - HEADER_WIDTH),
        height: Math.max(0, el.clientHeight - HEADER_HEIGHT),
      });
      setScrollbar((prev) => {
        const next = {
          x: el.offsetWidth - el.clientWidth,
          y: el.offsetHeight - el.clientHeight,
        };
        return prev.x === next.x && prev.y === next.y ? prev : next;
      });
    }, []);

    useLayoutEffect(() => {
      measure();
      const el = scrollerRef.current;
      if (!el || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => measure());
      observer.observe(el);
      return () => observer.disconnect();
    }, [measure]);

    const frame = useRef(0);
    const onScroll = useCallback(() => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        measure();
      });
    }, [measure]);
    useEffect(() => () => cancelAnimationFrame(frame.current), []);

    const scrollToCell = useCallback(
      (
        pos: CellPos,
        axes: { rows: boolean; cols: boolean } = { rows: true, cols: true },
      ) => {
        const el = scrollerRef.current;
        if (!el) return;
        const bodyW = el.clientWidth - HEADER_WIDTH;
        const bodyH = el.clientHeight - HEADER_HEIGHT;
        if (axes.rows && pos.row >= sheet.frozenRows) {
          const top = win.rowTop(pos.row) - win.frozenHeight;
          const bottom = win.rowTop(pos.row + 1);
          if (top < el.scrollTop) el.scrollTop = top;
          else if (bottom > el.scrollTop + bodyH) el.scrollTop = bottom - bodyH;
        }
        if (axes.cols && pos.col >= sheet.frozenCols) {
          const left = win.colLeft(pos.col) - win.frozenWidth;
          const right = win.colLeft(pos.col + 1);
          if (left < el.scrollLeft) el.scrollLeft = left;
          else if (right > el.scrollLeft + bodyW) el.scrollLeft = right - bodyW;
        }
      },
      [sheet.frozenRows, sheet.frozenCols, win],
    );

    const focusSink = useCallback(() => {
      sinkRef.current?.focus({ preventScroll: true });
    }, []);

    const holdScrollRef = useRef(false);
    useImperativeHandle(
      ref,
      () => ({
        focus: focusSink,
        scrollToCell,
        holdScroll: () => {
          holdScrollRef.current = true;
        },
      }),
      [focusSink, scrollToCell],
    );

    // keep the moving end of the selection on screen
    // (a whole row or column selected from its header does not scroll along it)
    const { focus: selFocus, anchor: selAnchor } = sel.selection;
    useEffect(() => {
      if (holdScrollRef.current) {
        holdScrollRef.current = false;
        return;
      }
      const wholeCol = selAnchor.row === 0 && selFocus.row === sheet.rows - 1;
      const wholeRow = selAnchor.col === 0 && selFocus.col === sheet.cols - 1;
      scrollToCell(selFocus, { rows: !wholeCol, cols: !wholeRow });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selFocus.row, selFocus.col]);

    const cellAtPoint = useCallback(
      (x: number, y: number): CellPos | null => {
        const el = scrollerRef.current;
        if (!el) return null;
        const box = el.getBoundingClientRect();
        const bx = x - box.left - HEADER_WIDTH;
        const by = y - box.top - HEADER_HEIGHT;
        const row = win.rowAt(
          by < win.frozenHeight ? Math.max(0, by) : by + el.scrollTop,
        );
        const col = win.colAt(
          bx < win.frozenWidth ? Math.max(0, bx) : bx + el.scrollLeft,
        );
        return { row, col };
      },
      [win],
    );
    if (props.cellAtPointRef) props.cellAtPointRef.current = cellAtPoint;

    // pointer selection: a press, then the cells under the pointer while it moves
    const dragging = useRef(false);
    // the listeners read the latest callbacks through refs, so they are added once
    const latest = useRef({
      cellAtPoint,
      sel,
      onEnter: props.onCellPointerEnter,
    });
    latest.current = { cellAtPoint, sel, onEnter: props.onCellPointerEnter };
    useEffect(() => {
      const move = (e: PointerEvent) => {
        if (!dragging.current) return;
        const { cellAtPoint: at, sel: selection, onEnter } = latest.current;
        const pos = at(e.clientX, e.clientY);
        if (!pos) return;
        if (onEnter?.(pos)) return;
        selection.select(pos.row, pos.col, true);
      };
      const up = () => {
        dragging.current = false;
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      // the browser may take the gesture (touch scroll): selecting stops
      window.addEventListener("pointercancel", up);
      return () => {
        dragging.current = false;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
    }, []);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-sheet-ignore-pointer]")) return;
      if (target.closest("[data-fill-handle]")) {
        e.preventDefault();
        props.onFillHandlePointerDown?.(e);
        return;
      }
      if (target.closest("textarea, input")) return;
      const header = target.closest("[data-header]");
      if ((e.button ?? 0) !== 0) {
        if (!header && !posFromTarget(target)) return;
        // a right click outside the selection selects first, as in Sheets
        const pos = posFromTarget(target);
        if (pos) {
          const r = sel.range();
          const inside =
            pos.row >= r.r1 &&
            pos.row <= r.r2 &&
            pos.col >= r.c1 &&
            pos.col <= r.c2;
          if (!inside) sel.select(pos.row, pos.col, false);
        }
        return;
      }
      // the page editor must not see the press, or it selects the whole block
      e.preventDefault();
      const pos = posFromTarget(target);
      if (!header && pos && props.onCellPointerDown?.(pos, e)) {
        // the press went to the editor (a formula reference); focus stays there
        dragging.current = true;
        return;
      }
      focusSink();
      if (header) {
        const kind = header.getAttribute("data-header");
        const index = Number(header.getAttribute("data-index"));
        if (target.closest("[data-resize]")) return;
        if (kind === "all") {
          sel.setSelection({
            anchor: { row: 0, col: 0 },
            focus: { row: sheet.rows - 1, col: sheet.cols - 1 },
          });
        } else if (kind === "col") {
          const a = e.shiftKey ? sel.selection.anchor.col : index;
          sel.setSelection({
            anchor: { row: 0, col: a },
            focus: { row: sheet.rows - 1, col: index },
          });
        } else if (kind === "row") {
          const a = e.shiftKey ? sel.selection.anchor.row : index;
          sel.setSelection({
            anchor: { row: a, col: 0 },
            focus: { row: index, col: sheet.cols - 1 },
          });
        }
        return;
      }
      if (!pos) return;
      sel.select(pos.row, pos.col, e.shiftKey);
      dragging.current = true;
    };

    // headers and frozen panes sit over the scroller; they scroll it too
    const onWheel = (e: ReactWheelEvent) => {
      const el = scrollerRef.current;
      if (!el || el.contains(e.target as Node)) return;
      el.scrollTop += e.deltaY;
      el.scrollLeft += e.deltaX;
    };

    const onDoubleClick = (e: ReactMouseEvent) => {
      const pos = posFromTarget(e.target);
      if (pos) props.onCellDoubleClick?.(pos);
    };

    const onContextMenu = (e: ReactMouseEvent) => {
      if (!props.onContextMenu) return;
      const header = (e.target as HTMLElement).closest("[data-header]");
      if (header) {
        const kind = header.getAttribute("data-header");
        if (kind !== "row" && kind !== "col") return;
        e.preventDefault();
        props.onContextMenu(e, {
          kind,
          index: Number(header.getAttribute("data-index")),
        });
        return;
      }
      const pos = posFromTarget(e.target);
      if (!pos) return;
      e.preventDefault();
      props.onContextMenu(e, { kind: "cell", pos });
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (props.onKey?.(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const arrows: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      };
      if (arrows[e.key]) {
        handled();
        const [dr, dc] = arrows[e.key];
        if (mod) sel.jump(dr, dc, e.shiftKey);
        else sel.move(dr, dc, e.shiftKey);
        return;
      }
      switch (e.key) {
        case "Tab":
          handled();
          sel.move(0, e.shiftKey ? -1 : 1, false);
          return;
        case "Enter":
          handled();
          sel.move(e.shiftKey ? -1 : 1, 0, false);
          return;
        case "Home":
          handled();
          if (mod) sel.select(0, 0, e.shiftKey);
          else sel.edge("home", e.shiftKey);
          return;
        case "End":
          handled();
          if (mod) sel.select(sheet.rows - 1, sheet.cols - 1, e.shiftKey);
          else sel.edge("end", e.shiftKey);
          return;
        case "PageDown":
          handled();
          sel.move(PAGE_ROWS, 0, e.shiftKey);
          return;
        case "PageUp":
          handled();
          sel.move(-PAGE_ROWS, 0, e.shiftKey);
          return;
        case "Escape": {
          handled();
          const { anchor, focus } = sel.selection;
          if (anchor.row !== focus.row || anchor.col !== focus.col) {
            sel.select(anchor.row, anchor.col, false);
            return;
          }
          // the grid is not a keyboard trap: Escape on one cell hands the keys
          // back to the page (WCAG 2.1.2)
          const page = rootRef.current?.closest<HTMLElement>(
            '[contenteditable="true"], .ProseMirror',
          );
          if (page) page.focus();
          else sinkRef.current?.blur();
          return;
        }
      }
      if (mod && e.key.toLowerCase() === "a") {
        handled();
        sel.setSelection({
          anchor: { row: 0, col: 0 },
          focus: { row: sheet.rows - 1, col: sheet.cols - 1 },
        });
      }
    };

    // ---- drawing ----
    const range = sel.range();
    const anchor = sel.selection.anchor;
    const fill = props.fillPreview;
    const remoteAt = new Map<string, RemoteCursor>();
    for (const cursor of props.remote ?? [])
      remoteAt.set(`${cursor.row}:${cursor.col}`, cursor);

    const rowList = windowIndexes(win.rows, sheet.frozenRows);
    const colList = windowIndexes(win.cols, sheet.frozenCols);
    // the active cell stays drawn while it is being edited off screen
    if (props.renderInActive) {
      if (!rowList.includes(anchor.row)) rowList.push(anchor.row);
      if (!colList.includes(anchor.col)) colList.push(anchor.col);
    }

    const drawn = new Set<string>();
    const drawBlock = (
      r: number,
      c: number,
      r2: number,
      c2: number,
      dx: number,
      dy: number,
    ) => {
      const key = `${r}:${c}`;
      if (drawn.has(key)) return null;
      drawn.add(key);
      const inRange =
        r <= range.r2 && r2 >= range.r1 && c <= range.c2 && c2 >= range.c1;
      let edges = 0;
      if (inRange) {
        if (r === range.r1) edges |= EDGE_TOP;
        if (r2 === range.r2) edges |= EDGE_BOTTOM;
        if (c === range.c1) edges |= EDGE_LEFT;
        if (c2 === range.c2) edges |= EDGE_RIGHT;
      }
      if (fill) {
        const inFill =
          r <= fill.r2 && r2 >= fill.r1 && c <= fill.c2 && c2 >= fill.c1;
        if (inFill) {
          if (r === fill.r1) edges |= EDGE_TOP;
          if (r2 === fill.r2) edges |= EDGE_BOTTOM;
          if (c === fill.c1) edges |= EDGE_LEFT;
          if (c2 === fill.c2) edges |= EDGE_RIGHT;
        }
      }
      const active = r === anchor.row && c === anchor.col;
      const shown = display(r, c);
      const remote = remoteAt.get(key);
      return (
        <GridCell
          key={key}
          row={r}
          col={c}
          x={win.colLeft(c) + dx}
          y={win.rowTop(r) + dy}
          width={win.colLeft(c2 + 1) - win.colLeft(c)}
          height={win.rowTop(r2 + 1) - win.rowTop(r)}
          text={shown.text}
          kind={shown.kind}
          format={sheet.cells[key]?.f}
          selected={inRange}
          active={active}
          edges={edges}
          remoteColor={remote?.color}
          remoteName={remote?.name}
          fillHandle={
            !props.readOnly && r2 === range.r2 && c2 === range.c2 && !fill
          }
          found={props.found?.get(key)}
        >
          {active ? props.renderInActive?.() : null}
        </GridCell>
      );
    };

    const region = (rows: number[], cols: number[], dx: number, dy: number) => {
      const out: ReactNode[] = [];
      if (rows.length === 0 || cols.length === 0) return out;
      const rMin = Math.min(...rows);
      const rMax = Math.max(...rows);
      const cMin = Math.min(...cols);
      const cMax = Math.max(...cols);
      for (const m of sheet.merges) {
        if (m.r1 <= rMax && m.r2 >= rMin && m.c1 <= cMax && m.c2 >= cMin) {
          out.push(drawBlock(m.r1, m.c1, m.r2, m.c2, dx, dy));
        }
      }
      for (const r of rows) {
        for (const c of cols) {
          if (S.findMerge(sheet, r, c)) continue;
          out.push(drawBlock(r, c, r, c, dx, dy));
        }
      }
      return out;
    };

    const frozenRowList = rowList.filter((r) => r < sheet.frozenRows);
    const frozenColList = colList.filter((c) => c < sheet.frozenCols);
    const bodyRowList = rowList.filter((r) => r >= sheet.frozenRows);
    const bodyColList = colList.filter((c) => c >= sheet.frozenCols);
    const { scrollTop, scrollLeft } = viewport;
    const fw = win.frozenWidth;
    const fh = win.frozenHeight;

    const colHeader = (c: number, dx: number) => (
      <div
        key={`c${c}`}
        className={clsx(
          classes.header,
          c >= range.c1 && c <= range.c2 && classes.headerActive,
          c === sheet.frozenCols - 1 && classes.frozenEdgeCol,
        )}
        style={{
          left: win.colLeft(c) + dx,
          top: 0,
          width: win.colWidth(c),
          height: HEADER_HEIGHT,
        }}
        data-header="col"
        data-index={c}
      >
        {S.colToLetter(c)}
        {props.renderHeaderExtra?.({ kind: "col", index: c })}
      </div>
    );
    const rowHeader = (r: number, dy: number) => (
      <div
        key={`r${r}`}
        className={clsx(
          classes.header,
          r >= range.r1 && r <= range.r2 && classes.headerActive,
          r === sheet.frozenRows - 1 && classes.frozenEdgeRow,
        )}
        style={{
          top: win.rowTop(r) + dy,
          left: 0,
          height: win.rowHeight(r),
          width: HEADER_WIDTH,
        }}
        data-header="row"
        data-index={r}
      >
        {r + 1}
        {props.renderHeaderExtra?.({ kind: "row", index: r })}
      </div>
    );

    return (
      <div
        ref={rootRef}
        className={classes.grid}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
        role="grid"
        aria-rowcount={sheet.rows}
        aria-colcount={sheet.cols}
        data-sheet-grid
      >
        <textarea
          ref={sinkRef}
          className={classes.sink}
          aria-label={t("Spreadsheet")}
          aria-description={t(
            "Arrow keys move, typing edits a cell, Escape leaves the spreadsheet",
          )}
          data-sheet-sink
          // text from an input method (IME) arrives when composition ends
          onCompositionEnd={(e) => {
            if (e.data) props.onCompose?.(e.data);
          }}
          onKeyDown={onKeyDown}
          onCopy={props.onCopy}
          onCut={props.onCut}
          onPaste={props.onPaste}
          // a selected character, so the browser fires copy and cut here
          value=" "
          onFocus={(e) => e.currentTarget.select()}
          onKeyUp={(e) => e.currentTarget.select()}
          onChange={() => undefined}
          readOnly={props.readOnly}
        />
        <div
          ref={scrollerRef}
          className={classes.scroller}
          onScroll={onScroll}
          data-sheet-scroller
        >
          <div
            className={classes.content}
            style={{
              width: HEADER_WIDTH + win.totalWidth,
              height: HEADER_HEIGHT + win.totalHeight,
            }}
          >
            {region(bodyRowList, bodyColList, HEADER_WIDTH, HEADER_HEIGHT)}
          </div>
        </div>

        {/* frozen rows: scroll sideways only */}
        {fh > 0 && (
          <div
            className={clsx(classes.layer, classes.frozenBandRows)}
            style={{
              top: HEADER_HEIGHT,
              left: HEADER_WIDTH + fw,
              right: scrollbar.x,
              height: fh,
            }}
          >
            <div
              className={classes.layerInner}
              style={{ transform: `translateX(${-scrollLeft - fw}px)` }}
            >
              {region(frozenRowList, bodyColList, 0, 0)}
            </div>
          </div>
        )}
        {/* frozen columns: scroll up and down only */}
        {fw > 0 && (
          <div
            className={clsx(classes.layer, classes.frozenBandCols)}
            style={{
              top: HEADER_HEIGHT + fh,
              left: HEADER_WIDTH,
              width: fw,
              bottom: scrollbar.y,
            }}
          >
            <div
              className={classes.layerInner}
              style={{ transform: `translateY(${-scrollTop - fh}px)` }}
            >
              {region(bodyRowList, frozenColList, 0, 0)}
            </div>
          </div>
        )}
        {fh > 0 && fw > 0 && (
          <div
            className={classes.layer}
            style={{
              top: HEADER_HEIGHT,
              left: HEADER_WIDTH,
              width: fw,
              height: fh,
            }}
          >
            <div className={classes.layerInner}>
              {region(frozenRowList, frozenColList, 0, 0)}
            </div>
          </div>
        )}

        {/* column headers */}
        <div
          className={classes.layer}
          style={{
            top: 0,
            left: HEADER_WIDTH + fw,
            right: scrollbar.x,
            height: HEADER_HEIGHT,
            zIndex: 4,
          }}
        >
          <div
            className={classes.layerInner}
            style={{ transform: `translateX(${-scrollLeft - fw}px)` }}
          >
            {bodyColList.map((c) => colHeader(c, 0))}
          </div>
        </div>
        {fw > 0 && (
          <div
            className={classes.layer}
            style={{
              top: 0,
              left: HEADER_WIDTH,
              width: fw,
              height: HEADER_HEIGHT,
              zIndex: 4,
            }}
          >
            <div className={classes.layerInner}>
              {frozenColList.map((c) => colHeader(c, 0))}
            </div>
          </div>
        )}
        {/* row headers */}
        <div
          className={classes.layer}
          style={{
            top: HEADER_HEIGHT + fh,
            left: 0,
            width: HEADER_WIDTH,
            bottom: scrollbar.y,
            zIndex: 4,
          }}
        >
          <div
            className={classes.layerInner}
            style={{ transform: `translateY(${-scrollTop - fh}px)` }}
          >
            {bodyRowList.map((r) => rowHeader(r, 0))}
          </div>
        </div>
        {fh > 0 && (
          <div
            className={classes.layer}
            style={{
              top: HEADER_HEIGHT,
              left: 0,
              width: HEADER_WIDTH,
              height: fh,
              zIndex: 4,
            }}
          >
            <div className={classes.layerInner}>
              {frozenRowList.map((r) => rowHeader(r, 0))}
            </div>
          </div>
        )}
        <div
          className={classes.corner}
          style={{ width: HEADER_WIDTH, height: HEADER_HEIGHT }}
          data-header="all"
          data-index={0}
        />
      </div>
    );
  },
);
