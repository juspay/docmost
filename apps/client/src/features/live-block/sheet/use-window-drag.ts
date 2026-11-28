import { useCallback, useEffect, useRef } from "react";

type End = (commit: boolean) => void;

/**
 * Follows the pointer on the window until it is released. A release commits;
 * pointercancel (the browser took the gesture, e.g. to scroll) and unmount end
 * the drag without committing, and the listeners never outlive it.
 */
export function useWindowDrag() {
  const stop = useRef<((commit: boolean) => void) | null>(null);

  useEffect(() => () => stop.current?.(false), []);

  return useCallback((onMove: (e: PointerEvent) => void, onEnd?: End) => {
    stop.current?.(false);
    const move = (e: PointerEvent) => onMove(e);
    const up = () => finish(true);
    const cancel = () => finish(false);
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      stop.current = null;
      onEnd?.(commit);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    stop.current = finish;
  }, []);
}
