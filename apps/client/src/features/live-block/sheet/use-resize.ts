import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useState,
} from "react";
import { sheet as S } from "@docmost/live-blocks";
import { useWindowDrag } from "./use-window-drag";

export type ResizeTarget = { kind: "row" | "col"; index: number };
export type ResizePreview = ResizeTarget & { size: number };

function clampSize(kind: ResizeTarget["kind"], size: number): number {
  return kind === "col"
    ? Math.min(S.MAX_COL_WIDTH, Math.max(S.MIN_COL_WIDTH, Math.round(size)))
    : Math.min(S.MAX_ROW_HEIGHT, Math.max(S.MIN_ROW_HEIGHT, Math.round(size)));
}

/** Dragging a header edge: a live preview, then one write when released. */
export function useResize(
  onCommit: (target: ResizeTarget, size: number) => void,
) {
  const [preview, setPreview] = useState<ResizePreview | null>(null);
  const drag = useWindowDrag();

  const start = useCallback(
    (e: ReactPointerEvent, target: ResizeTarget, current: number) => {
      e.preventDefault();
      e.stopPropagation();
      const origin = target.kind === "col" ? e.clientX : e.clientY;
      let size = current;
      drag(
        (ev) => {
          const at = target.kind === "col" ? ev.clientX : ev.clientY;
          size = clampSize(target.kind, current + at - origin);
          setPreview({ ...target, size });
        },
        (commit) => {
          setPreview(null);
          if (commit && size !== current) onCommit(target, size);
        },
      );
    },
    [onCommit, drag],
  );

  return { preview, start };
}

/** The tab as drawn during a resize drag. */
export function withResizePreview(
  sheet: S.Sheet,
  preview: ResizePreview | null,
): S.Sheet {
  if (!preview) return sheet;
  return preview.kind === "col"
    ? {
        ...sheet,
        colWidths: { ...sheet.colWidths, [preview.index]: preview.size },
      }
    : {
        ...sheet,
        rowHeights: { ...sheet.rowHeights, [preview.index]: preview.size },
      };
}
