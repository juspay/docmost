import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { sheet as S } from "@docmost/live-blocks";
import { useBlockUndo } from "../hooks/use-block-undo";
import { useSheetBook } from "./use-sheet-book";
import {
  applyFill,
  applySort,
  freezeTo,
  mergeRange,
  unmergeRange,
} from "./structure-actions";

function seeded(cells: Record<string, string>) {
  const book = S.createEmptyBook();
  for (const [a1, v] of Object.entries(cells)) {
    const ref = S.parseA1(a1)!;
    S.setCellRaw(book.sheets[0], ref.row, ref.col, v);
  }
  const doc = new Y.Doc();
  S.seedSheet(doc, book);
  const { result } = renderHook(() => {
    const api = useSheetBook(doc, false);
    const undo = useBlockUndo(doc, [S.sheetOrder(doc), S.sheetTabs(doc)]);
    return { api, undo };
  });
  const sheetId = result.current.api.book.sheets[0].id;
  const raw = (a1: string) => {
    const ref = S.parseA1(a1)!;
    return (
      result.current.api.book.sheets[0].cells[`${ref.row}:${ref.col}`]?.v ?? ""
    );
  };
  const shown = (a1: string) => {
    const ref = S.parseA1(a1)!;
    return result.current.api.engine.display(sheetId, ref.row, ref.col);
  };
  return { doc, result, sheetId, raw, shown };
}

// The undo manager merges changes less than 300 ms apart, reading the clock
// through a reference fake timers cannot replace; separate actions really wait.
const later = () => new Promise((resolve) => setTimeout(resolve, 350));

describe("structure actions", () => {
  it("insert row above moves the rows below down and formulas still point at the same cells", () => {
    const t = seeded({
      A1: "1",
      A2: "2",
      A3: "3",
      B1: "=SUM(A1:A3)",
      B4: "=A2*10",
    });
    act(() => t.result.current.api.structure.insertRows(t.sheetId, 1, 2));
    expect([
      t.raw("A1"),
      t.raw("A2"),
      t.raw("A3"),
      t.raw("A4"),
      t.raw("A5"),
    ]).toEqual(["1", "", "", "2", "3"]);
    expect(t.raw("B1")).toBe("=SUM(A1:A5)");
    expect(t.raw("B6")).toBe("=A4*10");
    expect(t.shown("B1")).toBe("6");
    expect(t.shown("B6")).toBe("20");
  });

  it("delete column turns references into it into #REF!", () => {
    const t = seeded({ A1: "5", B1: "7", C1: "=B1*2", D1: "=A1+1" });
    act(() => t.result.current.api.structure.deleteCols(t.sheetId, 1, 1));
    expect(t.raw("B1")).toBe("=#REF!*2");
    expect(t.raw("C1")).toBe("=A1+1");
    expect(t.shown("C1")).toBe("6");
  });

  it("undo of a row delete brings the row and its values back", async () => {
    const t = seeded({ A1: "top", A2: "gone", B2: "=A2", A3: '=A2&"!"' });
    act(() => t.result.current.api.structure.deleteRows(t.sheetId, 1, 1));
    expect(t.raw("A2")).toBe('=#REF!&"!"');
    await later();
    act(() => t.result.current.undo.undo());
    expect([t.raw("A1"), t.raw("A2"), t.raw("B2"), t.raw("A3")]).toEqual([
      "top",
      "gone",
      "=A2",
      '=A2&"!"',
    ]);
    expect(t.shown("A3")).toBe("gone!");
  });

  it("merge writes one MergeRange and keeps the top-left value", async () => {
    const t = seeded({ A1: "keep", B1: "drop", A2: "drop too" });
    const merges = t.doc
      .getMap<Y.Map<any>>("sheets")
      .get(t.sheetId)!
      .get("merges") as Y.Map<any>;
    act(() =>
      t.result.current.api.applyToSheet(t.sheetId, (d) =>
        mergeRange(d, { r1: 0, c1: 0, r2: 1, c2: 1 }),
      ),
    );
    expect(merges.size).toBe(1);
    expect(t.result.current.api.book.sheets[0].merges).toEqual([
      { r1: 0, c1: 0, r2: 1, c2: 1 },
    ]);
    expect([t.raw("A1"), t.raw("B1"), t.raw("A2")]).toEqual(["keep", "", ""]);
    await later();
    act(() =>
      t.result.current.api.applyToSheet(t.sheetId, (d) =>
        unmergeRange(d, { r1: 0, c1: 0, r2: 0, c2: 0 }),
      ),
    );
    expect(merges.size).toBe(0);
  });

  it("applyFill writes through to the shared document in one transaction", () => {
    const t = seeded({ A1: "1", A2: "2", B1: "=A1*2" });
    let transactions = 0;
    t.doc.on("afterTransaction", () => transactions++);
    act(() =>
      t.result.current.api.applyToSheet(t.sheetId, (d) =>
        applyFill(
          d,
          { r1: 0, c1: 0, r2: 1, c2: 1 },
          { r1: 0, c1: 0, r2: 4, c2: 1 },
        ),
      ),
    );
    expect(transactions).toBe(1);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(t.doc));
    const cells = S.readBook(other).sheets[0].cells;
    expect([cells["2:0"].v, cells["3:0"].v, cells["4:0"].v]).toEqual([
      "3",
      "4",
      "5",
    ]);
    expect(cells["2:1"].v).toBe("=A3*2");
    expect(t.shown("B5")).toBe("10");
  });

  it("applySort reorders rows of the range and leaves cells outside it alone", async () => {
    const t = seeded({
      A1: "Name",
      B1: "Qty",
      A2: "pears",
      B2: "3",
      C2: "=B2*2",
      A3: "apples",
      B3: "10",
      C3: "=B3*2",
      A4: "figs",
      B4: "=2*3",
      C4: "=B4*2",
      D2: "outside",
      A6: "below",
    });
    act(() =>
      t.result.current.api.applyToSheet(t.sheetId, (d) =>
        applySort(d, { r1: 1, c1: 0, r2: 3, c2: 2 }, 1, true),
      ),
    );
    expect([t.raw("A2"), t.raw("A3"), t.raw("A4")]).toEqual([
      "pears",
      "figs",
      "apples",
    ]);
    // each row's formula still reads its own row
    expect([t.raw("C2"), t.raw("C3"), t.raw("C4")]).toEqual([
      "=B2*2",
      "=B3*2",
      "=B4*2",
    ]);
    expect([t.shown("C2"), t.shown("C3"), t.shown("C4")]).toEqual([
      "6",
      "12",
      "20",
    ]);
    expect([t.raw("A1"), t.raw("D2"), t.raw("A6")]).toEqual([
      "Name",
      "outside",
      "below",
    ]);
    await later();
    act(() =>
      t.result.current.api.applyToSheet(t.sheetId, (d) =>
        applySort(d, { r1: 1, c1: 0, r2: 3, c2: 2 }, 0, true),
      ),
    );
    // a second sort by another key gives another order, formulas still on their rows
    expect([t.raw("A2"), t.raw("A3"), t.raw("A4")]).toEqual([
      "apples",
      "figs",
      "pears",
    ]);
    expect([t.shown("C2"), t.shown("C3"), t.shown("C4")]).toEqual([
      "20",
      "12",
      "6",
    ]);
    // a merge in the range refuses the sort
    act(() =>
      t.result.current.api.applyToSheet(t.sheetId, (d) => {
        mergeRange(d, { r1: 1, c1: 0, r2: 2, c2: 0 });
        expect(applySort(d, { r1: 1, c1: 0, r2: 3, c2: 2 }, 1, true)).toBe(
          false,
        );
      }),
    );
  });

  it("each structure action is one undo step", async () => {
    const t = seeded({ A1: "a", A2: "b", A3: "c" });
    const api = () => t.result.current.api;
    const snapshot = () => JSON.stringify(api().book.sheets[0]);
    const states = [snapshot()];
    const steps: (() => void)[] = [
      () => api().structure.insertRows(t.sheetId, 0, 2),
      () => api().structure.deleteRows(t.sheetId, 3, 1),
      () => api().structure.insertCols(t.sheetId, 0, 1),
      () => api().structure.deleteCols(t.sheetId, 0, 1),
      () =>
        api().applyToSheet(t.sheetId, (d) =>
          mergeRange(d, { r1: 0, c1: 0, r2: 1, c2: 1 }),
        ),
      () => api().applyToSheet(t.sheetId, (d) => freezeTo(d, 2, 1)),
      () =>
        api().applyToSheet(t.sheetId, (d) =>
          applyFill(
            d,
            { r1: 2, c1: 0, r2: 3, c2: 0 },
            { r1: 2, c1: 0, r2: 6, c2: 0 },
          ),
        ),
      () =>
        api().applyToSheet(t.sheetId, (d) =>
          applySort(d, { r1: 2, c1: 0, r2: 6, c2: 0 }, 0, false),
        ),
      () => api().applyToSheet(t.sheetId, (d) => S.setColWidth(d, 0, 220)),
    ];
    for (const step of steps) {
      await later();
      act(step);
      states.push(snapshot());
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      await later();
      act(() => t.result.current.undo.undo());
      expect(snapshot()).toBe(states[i]);
    }
  }, 20_000);
});
