import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { connect, docWithClientId, sheet as S } from "@docmost/live-blocks";
import { useSheetBook } from "./use-sheet-book";

const readBookSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@docmost/live-blocks", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    sheet: {
      ...actual.sheet,
      readBook: (doc: Y.Doc) => {
        readBookSpy.calls++;
        return actual.sheet.readBook(doc);
      },
    },
  };
});

function seeded(cells: Record<string, string>) {
  const book = S.createEmptyBook();
  for (const [a1, v] of Object.entries(cells)) {
    const ref = S.parseA1(a1)!;
    S.setCellRaw(book.sheets[0], ref.row, ref.col, v);
  }
  const doc = docWithClientId(1);
  S.seedSheet(doc, book);
  return { doc, sheetId: S.tabIds(doc)[0] };
}

describe("useSheetBook", () => {
  it("a remote edit recomputes dependent cells", () => {
    const { doc, sheetId } = seeded({ A1: "2", B1: "=A1*10" });
    const remote = docWithClientId(2);
    connect(doc, remote);
    const { result } = renderHook(() => useSheetBook(doc, false));
    expect(result.current.engine.display(sheetId, 0, 1)).toBe("20");
    act(() => S.setCell(remote, sheetId, 0, 0, { v: "7" }));
    expect(result.current.engine.display(sheetId, 0, 1)).toBe("70");
  });

  it("a remote single-cell edit updates the in-memory book without calling readBook again", () => {
    const { doc, sheetId } = seeded({ A1: "1", A3: "=A1+1" });
    const remote = docWithClientId(2);
    connect(doc, remote);
    const { result } = renderHook(() => useSheetBook(doc, false));
    const before = readBookSpy.calls;
    // the spy works: the hook read the book when it started
    expect(before).toBeGreaterThan(0);
    act(() => S.setCell(remote, sheetId, 4, 2, { v: "=A3*3" }));
    expect(readBookSpy.calls).toBe(before);
    const tab = result.current.book.sheets[0];
    expect(tab.cells["4:2"]).toEqual({ v: "=A3*3" });
    expect(result.current.engine.display(sheetId, 4, 2)).toBe("6");
    // a structural change may re-read; the result still matches the document
    act(() => S.insertRows(remote, sheetId, 0, 1));
    expect(result.current.book).toEqual(S.readBook(doc));
  });

  it("applyToSheet with a mutating function writes exactly the changed cells", () => {
    const { doc, sheetId } = seeded({ A1: "1", A2: "2", C3: "keep" });
    const { result } = renderHook(() => useSheetBook(doc, false));
    const cells = (S.sheetTabs(doc).get(sheetId) as Y.Map<any>).get(
      "cells",
    ) as Y.Map<any>;
    const changed: string[] = [];
    cells.observe((e) => changed.push(...e.keysChanged));
    act(() =>
      result.current.applyToSheet(sheetId, (draft) => {
        S.updateCellFormat(draft, 0, 0, { italic: true });
        S.setCellRaw(draft, 1, 0, "20");
      }),
    );
    expect(changed).toHaveLength(2);
    expect(result.current.book.sheets[0].cells["0:0"]).toEqual({
      v: "1",
      f: { italic: true },
    });
    expect(result.current.book.sheets[0].cells["1:0"]).toEqual({ v: "20" });
    // a mutation that writes past the end grows the tab first
    act(() =>
      result.current.applyToSheet(sheetId, (draft) =>
        S.setCellRaw(draft, 99, 30, "far"),
      ),
    );
    expect(result.current.book.sheets[0].rows).toBe(100);
    expect(result.current.book.sheets[0].cells["99:30"]).toEqual({ v: "far" });
  });

  it("read-only: setCell and applyToSheet do nothing", () => {
    const { doc, sheetId } = seeded({ A1: "1" });
    const updates = vi.fn();
    doc.on("update", updates);
    const { result } = renderHook(() => useSheetBook(doc, true));
    act(() => {
      result.current.setCell(sheetId, 0, 0, "changed");
      result.current.applyToSheet(sheetId, (draft) =>
        S.setCellRaw(draft, 1, 1, "x"),
      );
      result.current.applyToBook((draft) => S.addSheet(draft, "New"));
      result.current.structure.insertRows(sheetId, 0, 1);
    });
    expect(updates).not.toHaveBeenCalled();
    expect(result.current.book.sheets[0].cells["0:0"]).toEqual({ v: "1" });
  });

  it("setCell keeps the cell's format and writes the raw input", () => {
    const { doc, sheetId } = seeded({ A1: "1" });
    const { result } = renderHook(() => useSheetBook(doc, false));
    act(() =>
      result.current.applyToSheet(sheetId, (d) =>
        S.updateCellFormat(d, 0, 0, { bold: true }),
      ),
    );
    act(() => result.current.setCell(sheetId, 0, 0, "=2+2"));
    expect(result.current.book.sheets[0].cells["0:0"]).toEqual({
      v: "=2+2",
      f: { bold: true },
    });
    expect(result.current.engine.display(sheetId, 0, 0)).toBe("4");
  });
});
