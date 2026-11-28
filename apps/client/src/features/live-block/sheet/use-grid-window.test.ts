import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { sheet as S } from "@docmost/live-blocks";
import { useGridWindow, windowIndexes } from "./use-grid-window";

describe("useGridWindow", () => {
  it("the window holds only visible rows and columns for a 5,000-row sheet", () => {
    const sheet = S.newSheet("Big", 5000, 702);
    sheet.rowHeights["3"] = 260; // one tall row
    const viewport = { scrollTop: 0, scrollLeft: 0, width: 800, height: 400 };
    const { result, rerender } = renderHook(
      ({ v }) => useGridWindow(sheet, v),
      {
        initialProps: { v: viewport },
      },
    );
    const [r1, r2] = result.current.rows;
    const [c1, c2] = result.current.cols;
    expect(r1).toBe(0);
    // 3 rows of 26, one of 260, then rows of 26 to fill 400px, plus overscan
    expect(r2).toBeLessThan(15);
    expect(c2 - c1 + 1).toBeLessThan(15);

    rerender({
      v: {
        scrollTop: 26 * 4000,
        scrollLeft: 104 * 300,
        width: 800,
        height: 400,
      },
    });
    const [s1, s2] = result.current.rows;
    expect(s1).toBeGreaterThan(3900);
    expect(s2 - s1).toBeLessThan(25);
    expect(result.current.offsetTop).toBe(result.current.rowTop(s1));
    expect(result.current.cols[0]).toBeGreaterThan(290);
    expect(result.current.totalHeight).toBe(26 * 4999 + 260);
    // the bottom of the sheet ends the window
    rerender({
      v: { scrollTop: 10_000_000, scrollLeft: 0, width: 800, height: 400 },
    });
    expect(result.current.rows[1]).toBe(4999);
  });

  it("frozen rows and columns are always in the window", () => {
    const sheet = S.newSheet("F", 5000, 100);
    sheet.frozenRows = 2;
    sheet.frozenCols = 1;
    const { result } = renderHook(() =>
      useGridWindow(sheet, {
        scrollTop: 26 * 3000,
        scrollLeft: 104 * 50,
        width: 600,
        height: 300,
      }),
    );
    const rows = windowIndexes(result.current.rows, sheet.frozenRows);
    const cols = windowIndexes(result.current.cols, sheet.frozenCols);
    expect(rows.slice(0, 2)).toEqual([0, 1]);
    expect(cols[0]).toBe(0);
    expect(rows[2]).toBeGreaterThan(2900);
    expect(cols[1]).toBeGreaterThan(40);
    // the body window starts below the frozen band
    const visibleTop = 26 * 3000 + 2 * 26;
    expect(result.current.rowTop(result.current.rows[0] + 1)).toBeGreaterThan(
      visibleTop - 26 * 4,
    );
  });
});
