import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { sheet as S } from "@docmost/live-blocks";
import { useGridSelection } from "./use-grid-selection";

function tab(rows = 10, cols = 5) {
  const sheet = S.newSheet("T", rows, cols);
  return sheet;
}

describe("useGridSelection", () => {
  it("arrow keys move, Shift extends, movement stops at the sheet edge", () => {
    const sheet = tab(3, 3);
    const { result } = renderHook(() => useGridSelection(sheet));
    expect(result.current.selection.anchor).toEqual({ row: 0, col: 0 });
    act(() => result.current.move(1, 0, false));
    act(() => result.current.move(0, 1, false));
    expect(result.current.selection.anchor).toEqual({ row: 1, col: 1 });
    act(() => result.current.move(1, 0, true));
    act(() => result.current.move(0, 1, true));
    expect(result.current.selection.anchor).toEqual({ row: 1, col: 1 });
    expect(result.current.selection.focus).toEqual({ row: 2, col: 2 });
    expect(result.current.range()).toEqual({ r1: 1, c1: 1, r2: 2, c2: 2 });
    for (let i = 0; i < 5; i++) act(() => result.current.move(1, 1, true));
    expect(result.current.selection.focus).toEqual({ row: 2, col: 2 });
    act(() => result.current.move(0, -1, false));
    for (let i = 0; i < 5; i++) act(() => result.current.move(-1, -1, false));
    expect(result.current.selection.anchor).toEqual({ row: 0, col: 0 });
    expect(result.current.range()).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
  });

  it("selection treats a merged range as one cell", () => {
    const sheet = tab();
    S.mergeCells(sheet, 1, 1, 2, 3); // B2:D3
    const { result } = renderHook(() => useGridSelection(sheet));
    act(() => result.current.select(2, 2, false)); // inside the merge
    expect(result.current.selection.anchor).toEqual({ row: 1, col: 1 });
    expect(result.current.range()).toEqual({ r1: 1, c1: 1, r2: 2, c2: 3 });
    // one step right leaves the whole merge
    act(() => result.current.move(0, 1, false));
    expect(result.current.selection.anchor).toEqual({ row: 1, col: 4 });
    act(() => result.current.move(0, -1, false));
    expect(result.current.selection.anchor).toEqual({ row: 1, col: 1 });
    act(() => result.current.move(1, 0, false));
    expect(result.current.selection.anchor).toEqual({ row: 3, col: 1 });
    // a range touching the merge grows to cover it
    act(() => result.current.select(0, 0, false));
    act(() => result.current.select(1, 1, true));
    expect(result.current.range()).toEqual({ r1: 0, c1: 0, r2: 2, c2: 3 });
  });

  it("Ctrl+arrow jumps to the edge of the data, Home and End go to the row ends", () => {
    const sheet = tab(10, 5);
    for (let r = 0; r < 4; r++) S.setCellRaw(sheet, r, 0, String(r));
    S.setCellRaw(sheet, 8, 0, "far");
    const { result } = renderHook(() => useGridSelection(sheet));
    act(() => result.current.jump(1, 0, false));
    expect(result.current.selection.anchor).toEqual({ row: 3, col: 0 });
    act(() => result.current.jump(1, 0, false));
    expect(result.current.selection.anchor).toEqual({ row: 8, col: 0 });
    act(() => result.current.jump(1, 0, false));
    expect(result.current.selection.anchor).toEqual({ row: 9, col: 0 });
    act(() => result.current.edge("end", false));
    expect(result.current.selection.anchor).toEqual({ row: 9, col: 4 });
    act(() => result.current.edge("home", true));
    expect(result.current.range()).toEqual({ r1: 9, c1: 0, r2: 9, c2: 4 });
  });

  it("a selection is kept inside the tab when it shrinks", () => {
    let sheet = tab(10, 5);
    const { result, rerender } = renderHook(({ s }) => useGridSelection(s), {
      initialProps: { s: sheet },
    });
    act(() => result.current.select(9, 4, false));
    sheet = tab(5, 2);
    rerender({ s: sheet });
    expect(result.current.selection.anchor).toEqual({ row: 4, col: 1 });
  });
});
