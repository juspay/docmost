import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWindowDrag } from "./use-window-drag";
import { useFillHandle } from "./fill-handle";
import { useResize } from "./use-resize";

const down = {
  clientX: 0,
  clientY: 0,
  preventDefault() {},
  stopPropagation() {},
} as any;
const fire = (type: string, x = 0, y = 0) =>
  act(() => {
    window.dispatchEvent(
      Object.assign(new Event(type), { clientX: x, clientY: y }),
    );
  });

describe("spreadsheet drags", () => {
  it("a drag ends on pointerup with commit, on pointercancel without", () => {
    const { result } = renderHook(() => useWindowDrag());
    const end = vi.fn();
    act(() => result.current(vi.fn(), end));
    fire("pointercancel");
    expect(end).toHaveBeenCalledWith(false);
    // a later tap does nothing
    fire("pointerup");
    expect(end).toHaveBeenCalledTimes(1);
    act(() => result.current(vi.fn(), end));
    fire("pointerup");
    expect(end).toHaveBeenLastCalledWith(true);
  });

  it("an unmount mid-drag removes the listeners and does not commit", () => {
    const { result, unmount } = renderHook(() => useWindowDrag());
    const move = vi.fn();
    const end = vi.fn();
    act(() => result.current(move, end));
    unmount();
    expect(end).toHaveBeenCalledWith(false);
    fire("pointermove", 5, 5);
    fire("pointerup");
    expect(move).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("a cancelled fill-handle drag fills nothing, and a later tap does not fill", () => {
    const onFill = vi.fn();
    const sel = { range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }) } as any;
    const cellAtPoint = { current: () => ({ row: 5, col: 0 }) };
    const { result } = renderHook(() =>
      useFillHandle({ sel, cellAtPoint, onFill }),
    );
    act(() => result.current.onPointerDown(down));
    fire("pointermove", 10, 200);
    expect(result.current.preview).toEqual({ r1: 0, c1: 0, r2: 5, c2: 0 });
    fire("pointercancel");
    expect(result.current.preview).toBeNull();
    fire("pointerup");
    expect(onFill).not.toHaveBeenCalled();
  });

  it("a cancelled resize keeps the old size", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useResize(onCommit));
    act(() => result.current.start(down, { kind: "col", index: 0 }, 100));
    fire("pointermove", 60, 0);
    fire("pointercancel");
    fire("pointerup");
    expect(onCommit).not.toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
  });
});
