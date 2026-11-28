import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Follows the pointer from a pointerdown until it is released. Listens on the
 * window, so it keeps working when the pointer leaves the element or the
 * browser has no pointer capture.
 */
export function startPointerDrag(
  start: Pick<ReactPointerEvent, "clientX" | "clientY">,
  onMove: (dx: number, dy: number) => void,
  onEnd?: () => void,
): void {
  const { clientX, clientY } = start;
  const move = (e: PointerEvent) =>
    onMove(e.clientX - clientX, e.clientY - clientY);
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    onEnd?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}
