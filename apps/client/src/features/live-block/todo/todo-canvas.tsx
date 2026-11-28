import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { todo as B } from "@docmost/live-blocks";
import { useBlockUndo } from "../hooks/use-block-undo";
import type { LiveBlockRenderContext } from "../live-block.types";
import { startPointerDrag } from "./pointer-drag";
import { TodoCard } from "./todo-card";
import { TodoContext, type TodoContextValue } from "./todo-context";
import { TodoToolbar } from "./todo-toolbar";
import { todoScope, useTodoBoard } from "./use-todo-board";
import classes from "./todo.module.css";

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.2;
const FIT_PADDING = 32;

type Viewport = { x: number; y: number; zoom: number };

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export default function TodoCanvas({
  ctx,
  height,
}: {
  ctx: LiveBlockRenderContext;
  /** Pixels for the inline block; the opened block fills its window. */
  height?: number;
}) {
  const { t } = useTranslation();
  const { doc, readOnly, opened } = ctx;
  const { board, apply } = useTodoBoard(doc, readOnly);
  const undo = useBlockUndo(doc, todoScope(doc));

  const [focusId, requestFocus] = useState<string | null>(null);
  const flushers = useRef(new Set<() => void>());
  const registerFlush = useCallback((fn: () => void) => {
    flushers.current.add(fn);
    return () => {
      flushers.current.delete(fn);
    };
  }, []);
  const flushAll = useCallback(() => {
    flushers.current.forEach((fn) => fn());
  }, []);
  const { registerFlush: registerWithRoom } = ctx;
  useEffect(() => registerWithRoom(flushAll), [registerWithRoom, flushAll]);

  // pan and zoom belong to this person; nothing about them is shared
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = viewportRef.current;
    const px = cx ?? (el ? el.clientWidth / 2 : 0);
    const py = cy ?? (el ? el.clientHeight / 2 : 0);
    setViewport((v) => {
      const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const wx = (px - v.x) / v.zoom;
      const wy = (py - v.y) / v.zoom;
      return { x: px - wx * zoom, y: py - wy * zoom, zoom };
    });
  }, []);

  const fit = useCallback((): boolean => {
    const el = viewportRef.current;
    const cards = Array.from(
      worldRef.current?.querySelectorAll<HTMLElement>("[data-todo-card]") ?? [],
    );
    if (!el || cards.length === 0 || el.clientWidth === 0) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const card of cards) {
      const x = parseFloat(card.style.left) || 0;
      const y = parseFloat(card.style.top) || 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + card.offsetWidth);
      maxY = Math.max(maxY, y + card.offsetHeight);
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const zoom = clamp(
      Math.min(
        (el.clientWidth - 2 * FIT_PADDING) / w,
        (el.clientHeight - 2 * FIT_PADDING) / h,
        1,
      ),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    setViewport({
      zoom,
      x:
        FIT_PADDING -
        minX * zoom +
        Math.max(0, (el.clientWidth - 2 * FIT_PADDING - w * zoom) / 2),
      y: FIT_PADDING - minY * zoom,
    });
    return true;
  }, []);

  // on open, frame the cards once they have arrived
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || !ctx.synced || board.columns.length === 0) return;
    fitted.current = fit();
  });

  // ctrl or cmd plus scroll zooms; a plain scroll pans only in the opened block,
  // so an inline board never traps the page's own scrolling
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        zoomAt(
          Math.exp(-e.deltaY * 0.0015),
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
      } else if (opened) {
        e.preventDefault();
        setViewport((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [opened, zoomAt]);

  // the page editor must not see mouse presses on the canvas: it would select
  // or start dragging the whole block
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener("mousedown", stop);
    return () => el.removeEventListener("mousedown", stop);
  }, []);

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("[data-todo-card]"))
      return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const origin = viewport;
    setPanning(true);
    startPointerDrag(
      e,
      (dx, dy) =>
        setViewport({ ...origin, x: origin.x + dx, y: origin.y + dy }),
      () => setPanning(false),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      flushAll();
      undo.onKeyDown(e);
    }
  };

  const context = useMemo<TodoContextValue>(
    () => ({
      view: board.view,
      readOnly,
      apply,
      focusId,
      requestFocus,
      registerFlush,
    }),
    [board.view, readOnly, apply, focusId, registerFlush],
  );

  const addCard = () => {
    const el = viewportRef.current;
    const position = el
      ? {
          x:
            (el.clientWidth / 2 - viewport.x) / viewport.zoom -
            B.DEFAULT_COLUMN_WIDTH / 2,
          y: (el.clientHeight / 2 - viewport.y) / viewport.zoom - 40,
        }
      : null;
    apply((d) => {
      B.addColumn(d, position);
    });
  };

  const progress = useMemo(
    () => B.countProgress(board.columns.flatMap((c) => c.nodes)),
    [board.columns],
  );
  const grid = 24 * viewport.zoom;

  return (
    <TodoContext.Provider value={context}>
      <div
        className={classes.root}
        style={{
          height: opened ? "100%" : (height ?? 480),
          flex: opened ? 1 : undefined,
        }}
        data-testid="todo-board"
        onKeyDown={onKeyDown}
      >
        <TodoToolbar
          view={board.view}
          progress={progress}
          zoom={viewport.zoom}
          canEdit={!readOnly}
          onSort={(sort) => apply((d) => B.setView(d, { ...d.view, sort }))}
          onHideDone={(hideDone) =>
            apply((d) => B.setView(d, { ...d.view, hideDone }))
          }
          onZoom={(factor) => zoomAt(factor)}
          onFit={() => {
            if (!fit()) setViewport({ x: 0, y: 0, zoom: 1 });
          }}
          onAddCard={addCard}
        />
        <div
          ref={viewportRef}
          className={clsx(classes.viewport, panning && classes.viewportPanning)}
          role="application"
          aria-label={t(
            "To-do board canvas. Drag to pan, Ctrl or Cmd plus scroll to zoom.",
          )}
          onPointerDown={startPan}
          style={{
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
            backgroundSize: `${grid}px ${grid}px`,
          }}
        >
          <div
            ref={worldRef}
            className={classes.world}
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            }}
          >
            {board.columns.map((column) => (
              <TodoCard
                key={column.id}
                column={column}
                zoom={viewport.zoom}
                canDelete={board.columns.length > 1}
              />
            ))}
          </div>
          {board.columns.length === 0 && (
            <div className={classes.emptyCanvas}>
              <span>{t("No cards yet.")}</span>
              {!readOnly && (
                <Button
                  size="compact-sm"
                  variant="light"
                  leftSection={<IconPlus size={14} />}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={addCard}
                >
                  {t("Add a card")}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </TodoContext.Provider>
  );
}
