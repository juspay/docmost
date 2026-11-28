import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { sheet as S } from "@docmost/live-blocks";
import { useBlockUndo } from "../hooks/use-block-undo";
import { useSheetBook } from "./use-sheet-book";
import {
  applyBorders,
  bumpDecimals,
  clearFormatting,
  formatTargets,
  formatIsCut,
  formatWouldOverflow,
  MAX_FORMAT_BOX,
  setFormat,
  setNumberFormat,
  toggleFlag,
} from "./format-actions";

function tabWith(cells: Record<string, string>) {
  const sheet = S.newSheet("T", 20, 5);
  for (const [a1, v] of Object.entries(cells)) {
    const ref = S.parseA1(a1)!;
    S.setCellRaw(sheet, ref.row, ref.col, v);
  }
  return sheet;
}

const show = (sheet: S.Sheet, a1: string) => {
  const ref = S.parseA1(a1)!;
  const book = {
    version: 1 as const,
    sheets: [sheet],
    activeSheetId: sheet.id,
  };
  return new S.Engine(book).display(sheet.id, ref.row, ref.col);
};
const valueOf = (sheet: S.Sheet) => {
  const engine = new S.Engine({
    version: 1,
    sheets: [sheet],
    activeSheetId: sheet.id,
  });
  return (row: number, col: number) => engine.getValue(sheet.id, row, col);
};

describe("format actions", () => {
  it("bold toggles on for a mixed selection and off when all cells are bold", () => {
    const sheet = tabWith({ A1: "a", A2: "b", A3: "c" });
    S.updateCellFormat(sheet, 0, 0, { bold: true });
    const range = { r1: 0, c1: 0, r2: 2, c2: 0 };
    toggleFlag(sheet, range, "bold");
    expect([0, 1, 2].map((r) => sheet.cells[`${r}:0`].f?.bold)).toEqual([
      true,
      true,
      true,
    ]);
    toggleFlag(sheet, range, "bold");
    expect(
      [0, 1, 2].map((r) => sheet.cells[`${r}:0`].f?.bold ?? false),
    ).toEqual([false, false, false]);
    expect(sheet.cells["1:0"]).toEqual({ v: "b" });
  });

  it("number format percent shows 0.5 as 50%", () => {
    const sheet = tabWith({ A1: "0.5", B1: "1234.5", C1: "45000" });
    setNumberFormat(sheet, { r1: 0, c1: 0, r2: 0, c2: 0 }, "percent");
    expect(show(sheet, "A1")).toBe("50%");
    setNumberFormat(sheet, { r1: 0, c1: 1, r2: 0, c2: 1 }, "currency");
    expect(show(sheet, "B1")).toBe("$1,234.50");
    setNumberFormat(sheet, { r1: 0, c1: 2, r2: 0, c2: 2 }, "date");
    expect(show(sheet, "C1")).toBe("Mar 15, 2023");
    setNumberFormat(sheet, { r1: 0, c1: 0, r2: 0, c2: 0 }, "auto");
    expect(show(sheet, "A1")).toBe("0.5");
    expect(sheet.cells["0:0"].f).toBeUndefined();
  });

  it("more decimals then fewer decimals returns to the start", () => {
    const sheet = tabWith({ A1: "0.5", A2: "3.14159", A3: "=1/8" });
    const range = { r1: 0, c1: 0, r2: 2, c2: 0 };
    const before = ["A1", "A2", "A3"].map((a) => show(sheet, a));
    const cellsBefore = structuredClone(sheet.cells);
    bumpDecimals(sheet, range, 1, valueOf(sheet));
    expect(["A1", "A2", "A3"].map((a) => show(sheet, a))).toEqual([
      "0.50",
      "3.141590",
      "0.1250",
    ]);
    bumpDecimals(sheet, range, -1, valueOf(sheet));
    expect(["A1", "A2", "A3"].map((a) => show(sheet, a))).toEqual(before);
    expect(sheet.cells).toEqual(cellsBefore);
    bumpDecimals(sheet, range, -1, valueOf(sheet));
    expect(show(sheet, "A2")).toBe("3.1416");
  });

  it("clear formatting removes format and keeps the value", () => {
    const sheet = tabWith({ A1: "x" });
    setFormat(
      sheet,
      { r1: 0, c1: 0, r2: 1, c2: 1 },
      { color: "#ff0000", bg: "#00ff00" },
    );
    applyBorders(sheet, { r1: 0, c1: 0, r2: 1, c2: 1 }, "outer", {
      style: "thin",
      color: "#000",
    });
    expect(sheet.cells["0:0"].f?.borders?.top).toBeTruthy();
    expect(sheet.cells["1:1"].f?.borders?.right).toBeTruthy();
    expect(sheet.cells["1:1"].f?.borders?.top).toBeUndefined();
    clearFormatting(sheet, { r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(sheet.cells["0:0"]).toEqual({ v: "x" });
    expect(sheet.cells["1:1"]).toBeUndefined();
  });

  it("a format change on 200 cells is one transaction and one undo step", () => {
    const book = S.createEmptyBook();
    for (let r = 0; r < 100; r++) {
      S.setCellRaw(book.sheets[0], r, 0, String(r));
      S.setCellRaw(book.sheets[0], r, 1, `t${r}`);
    }
    const doc = new Y.Doc();
    S.seedSheet(doc, book);
    const { result } = renderHook(() => {
      const api = useSheetBook(doc, false);
      const undo = useBlockUndo(doc, [S.sheetOrder(doc), S.sheetTabs(doc)]);
      return { api, undo };
    });
    const sheetId = result.current.api.book.sheets[0].id;
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);
    act(() =>
      result.current.api.applyToSheet(sheetId, (draft) =>
        toggleFlag(draft, { r1: 0, c1: 0, r2: 99, c2: 1 }, "italic"),
      ),
    );
    expect(transactions).toBe(1);
    const cells = () => result.current.api.book.sheets[0].cells;
    expect(Object.values(cells()).filter((c) => c.f?.italic)).toHaveLength(200);
    act(() => result.current.undo.undo());
    expect(Object.values(cells()).filter((c) => c.f?.italic)).toHaveLength(0);
    expect(cells()["5:0"]).toEqual({ v: "5" });
  });

  it("an empty selection up to the cap is formatted in full (refix2 I4)", () => {
    const sheet = S.newSheet("T", 5000, 702);
    // E1:Z1000 is 22,000 empty cells
    const range = { r1: 0, c1: 4, r2: 999, c2: 25 };
    setFormat(sheet, range, { bg: "#ffec99" });
    expect(Object.keys(sheet.cells)).toHaveLength(22_000);
    expect(sheet.cells["999:25"].f?.bg).toBe("#ffec99");
    expect(formatIsCut(range)).toBe(false);
    applyBorders(sheet, range, "outer", { style: "thin", color: "#000" });
    expect(sheet.cells["999:10"].f?.borders?.bottom).toBeTruthy();
  });

  it("past the cap, the used box is formatted, empty cells in it included", () => {
    const sheet = S.newSheet("T", 5000, 702);
    S.setCellRaw(sheet, 0, 0, "a");
    S.setCellRaw(sheet, 2, 2, "c");
    const all = { r1: 0, c1: 0, r2: 4999, c2: 701 };
    expect(formatIsCut(all)).toBe(true);
    expect(formatTargets(sheet, all)).toHaveLength(9);
    applyBorders(sheet, all, "outer", { style: "thin", color: "#000" });
    for (const [key, side] of [
      ["0:1", "top"],
      ["1:0", "left"],
      ["2:1", "bottom"],
      ["1:2", "right"],
    ] as const) {
      expect(sheet.cells[key].f?.borders?.[side], key).toBeTruthy();
    }
  });

  it("past the cap with data spread out, only the stored cells are formatted", () => {
    const sheet = S.newSheet("T", 5000, 702);
    S.setCellRaw(sheet, 0, 0, "a");
    S.setCellRaw(sheet, 4999, 701, "far");
    expect(formatTargets(sheet, { r1: 0, c1: 0, r2: 4999, c2: 701 })).toEqual([
      { row: 0, col: 0 },
      { row: 4999, col: 701 },
    ]);
  });

  it("merges are looked up once per action, not per cell (refix2 I3)", () => {
    const sheet = S.newSheet("T", 5000, 702);
    for (let i = 0; i < 1000; i++)
      sheet.merges.push({ r1: i * 2, c1: 0, r2: i * 2, c2: 1 });
    const scans = vi.spyOn(S, "findMerge");
    let reads = 0;
    const merges = sheet.merges;
    sheet.merges = new Proxy(merges, {
      get(target, key, recv) {
        if (key === Symbol.iterator) reads++;
        return Reflect.get(target, key, recv);
      },
    });
    try {
      const targets = formatTargets(sheet, { r1: 0, c1: 0, r2: 1999, c2: 99 });
      expect(targets).toHaveLength(2000 * 100 - 1000);
      expect(scans).not.toHaveBeenCalled();
      expect(reads).toBeLessThanOrEqual(2);
    } finally {
      scans.mockRestore();
      sheet.merges = merges;
    }
  });
  it("a format that would take the tab past 1,000,000 stored cells is refused (refix3 m2)", () => {
    const sheet = S.newSheet("T", 5000, 702);
    for (let i = 0; i < 900_000; i++)
      sheet.cells[`${Math.floor(i / 700)}:${i % 700}`] = {
        v: "",
        f: { bold: true },
      };
    // 200,000 empty cells in the rows below the stored ones
    expect(
      formatWouldOverflow(sheet, { r1: 2000, c1: 0, r2: 2399, c2: 499 }),
    ).toBe(true);
    expect(formatWouldOverflow(sheet, { r1: 0, c1: 0, r2: 9, c2: 9 })).toBe(
      false,
    );
  });
});
