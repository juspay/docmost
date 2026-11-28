import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useState,
} from "react";
import { sheet as S } from "@docmost/live-blocks";
import type { CellPos, GridSelectionApi } from "./use-grid-selection";
import { useWindowDrag } from "./use-window-drag";

/** Where dragging the fill handle to `pos` fills: one direction, the farther one. */
export function fillTarget(
  source: S.MergeRange,
  pos: CellPos,
): S.MergeRange | null {
  const down = pos.row - source.r2;
  const up = source.r1 - pos.row;
  const right = pos.col - source.c2;
  const left = source.c1 - pos.col;
  const vertical = Math.max(down, up);
  const horizontal = Math.max(right, left);
  if (vertical <= 0 && horizontal <= 0) return null;
  if (vertical >= horizontal) {
    return down > 0 ? { ...source, r2: pos.row } : { ...source, r1: pos.row };
  }
  return right > 0 ? { ...source, c2: pos.col } : { ...source, c1: pos.col };
}

/** Dragging the square at the selection's corner; fills on release. */
export function useFillHandle(args: {
  sel: GridSelectionApi;
  cellAtPoint: { current: ((x: number, y: number) => CellPos | null) | null };
  onFill(source: S.MergeRange, target: S.MergeRange): void;
}) {
  const { sel, cellAtPoint, onFill } = args;
  const [preview, setPreview] = useState<S.MergeRange | null>(null);
  const drag = useWindowDrag();

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const source = sel.range();
      let target: S.MergeRange | null = null;
      drag(
        (ev) => {
          const pos = cellAtPoint.current?.(ev.clientX, ev.clientY);
          if (!pos) return;
          target = fillTarget(source, pos);
          setPreview(target);
        },
        (commit) => {
          setPreview(null);
          if (commit && target) onFill(source, target);
        },
      );
    },
    [sel, cellAtPoint, onFill, drag],
  );

  return { preview, onPointerDown };
}
