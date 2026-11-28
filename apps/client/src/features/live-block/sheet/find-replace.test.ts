import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { sheet as S } from "@docmost/live-blocks";
import { useBlockUndo } from "../hooks/use-block-undo";
import { useSheetBook } from "./use-sheet-book";
import { findMatches, replaceAll, replaceInText } from "./find-replace";

function seeded(cells: Record<string, string>) {
  const book = S.createEmptyBook();
  for (const [a1, v] of Object.entries(cells)) {
    const ref = S.parseA1(a1)!;
    S.setCellRaw(book.sheets[0], ref.row, ref.col, v);
  }
  const doc = new Y.Doc();
  S.seedSheet(doc, book);
  return doc;
}

describe("find and replace", () => {
  it("findMatches finds values, and formulas only when asked", () => {
    const sheet = S.newSheet("T", 10, 5);
    S.setCellRaw(sheet, 0, 0, "Apple pie");
    S.setCellRaw(sheet, 2, 1, "apple");
    S.setCellRaw(sheet, 1, 0, '=CONCAT("apple", A1)');
    S.setCellRaw(sheet, 3, 3, "banana");
    expect(
      findMatches(sheet, "apple", { matchCase: false, inFormulas: false }),
    ).toEqual([
      { row: 0, col: 0 },
      { row: 2, col: 1 },
    ]);
    expect(
      findMatches(sheet, "apple", { matchCase: true, inFormulas: false }),
    ).toEqual([{ row: 2, col: 1 }]);
    expect(
      findMatches(sheet, "apple", { matchCase: false, inFormulas: true }),
    ).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 2, col: 1 },
    ]);
    expect(
      findMatches(sheet, "", { matchCase: false, inFormulas: true }),
    ).toEqual([]);
    expect(replaceInText("Apple apple", "apple", "pear", false)).toBe(
      "pear pear",
    );
    expect(replaceInText("Apple apple", "apple", "pear", true)).toBe(
      "Apple pear",
    );
    expect(replaceInText("a.b", ".", "$&", false)).toBe("a$&b");
  });

  it("replace all is undone in one step", () => {
    const doc = seeded({ A1: "cat", A2: "cat food", B3: "dog", C1: "Cat" });
    const { result } = renderHook(() => {
      const api = useSheetBook(doc, false);
      const scope = [S.sheetOrder(doc), S.sheetTabs(doc)];
      const undo = useBlockUndo(doc, scope);
      return { api, undo };
    });
    const sheetId = result.current.api.book.sheets[0].id;
    act(() =>
      result.current.api.applyToSheet(sheetId, (draft) => {
        const matches = findMatches(draft, "cat", {
          matchCase: false,
          inFormulas: false,
        });
        replaceAll(draft, matches, "cat", "bird", false);
      }),
    );
    const after = result.current.api.book.sheets[0].cells;
    expect([after["0:0"].v, after["1:0"].v, after["0:2"].v]).toEqual([
      "bird",
      "bird food",
      "bird",
    ]);
    act(() => result.current.undo.undo());
    const back = result.current.api.book.sheets[0].cells;
    expect([
      back["0:0"].v,
      back["1:0"].v,
      back["0:2"].v,
      back["2:1"].v,
    ]).toEqual(["cat", "cat food", "Cat", "dog"]);
  });
});
