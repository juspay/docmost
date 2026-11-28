import { describe, expect, it } from "vitest";
import { sheet as S } from "@docmost/live-blocks";
import {
  clampPaste,
  parseClipboard,
  pasteGrid,
  serializeRange,
  usedRange,
  PasteTooLarge,
} from "./clipboard";

function bookWith(cells: Record<string, string>) {
  const book = S.createEmptyBook();
  for (const [a1, v] of Object.entries(cells)) {
    const ref = S.parseA1(a1)!;
    S.setCellRaw(book.sheets[0], ref.row, ref.col, v);
  }
  return book;
}

describe("clipboard", () => {
  it("parseClipboard reads tab-separated rows and an HTML table", () => {
    expect(parseClipboard("a\tb\n1\t2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseClipboard('x\t"two\nlines"\r\ny\t"say ""hi"""')).toEqual([
      ["x", "two\nlines"],
      ["y", 'say "hi"'],
    ]);
    const html =
      '<meta charset="utf-8"><google-sheets-html-origin><table><tbody>' +
      "<tr><td>Name</td><td>Qty</td></tr>" +
      '<tr><td colspan="2">wide</td></tr>' +
      "<tr><td>Pens</td><td>3</td></tr></tbody></table>";
    expect(parseClipboard("ignored", html)).toEqual([
      ["Name", "Qty"],
      ["wide", ""],
      ["Pens", "3"],
    ]);
  });

  it("serializeRange round-trips through parseClipboard", () => {
    const book = bookWith({
      A1: "Item",
      B1: "Cost",
      A2: "Tea",
      B2: "2.5",
      A3: "Sum",
      B3: "=SUM(B2:B2)",
    });
    const range = { r1: 0, c1: 0, r2: 2, c2: 1 };
    const { text, html } = serializeRange(book, book.sheets[0].id, range);
    const expected = [
      ["Item", "Cost"],
      ["Tea", "2.5"],
      ["Sum", "2.5"],
    ];
    expect(parseClipboard(text)).toEqual(expected);
    expect(parseClipboard(text, html)).toEqual(expected);
  });

  it("a paste past the limits is cut and reports the dropped count", () => {
    const sheet = S.newSheet("T", 10, 10);
    const data = Array.from({ length: 4 }, () => ["a", "b", "c"]);
    const { data: kept, dropped } = clampPaste(
      sheet,
      { row: S.MAX_ROWS - 2, col: S.MAX_COLS - 1 },
      data,
    );
    expect(kept).toEqual([["a"], ["a"]]);
    expect(dropped).toBe(10);
    expect(clampPaste(sheet, { row: 0, col: 0 }, data).dropped).toBe(0);
  });

  it("pasting a copied formula shifts relative references", () => {
    const book = bookWith({
      A1: "1",
      A2: "2",
      B2: "=A2*$A$1",
      C2: "=SUM(A1:A2)",
    });
    const { text, html } = serializeRange(book, book.sheets[0].id, {
      r1: 1,
      c1: 1,
      r2: 1,
      c2: 2,
    });
    // pasted two rows down and one column right
    expect(pasteGrid(text, html, { row: 3, col: 2 })).toEqual([
      ["=B4*$A$1", "=SUM(B3:B4)"],
    ]);
    // from somewhere else, values come in as they look
    expect(pasteGrid("5\t6", undefined, { row: 0, col: 0 })).toEqual([
      ["5", "6"],
    ]);
  });

  it("a pasted table with rowspan puts each cell where it belongs", () => {
    const html =
      '<table><tr><td rowspan="2">Fruit</td><td>pears</td></tr>' +
      "<tr><td>figs</td></tr>" +
      '<tr><td>Veg</td><td colspan="2">kale</td></tr></table>';
    expect(parseClipboard("", html)).toEqual([
      ["Fruit", "pears"],
      ["", "figs"],
      ["Veg", "kale", ""],
    ]);
  });

  it("copying a whole-sheet selection serialises only the used part", () => {
    const book = bookWith({ A1: "a", B2: "b" });
    const sheet = book.sheets[0];
    sheet.rows = 5000;
    sheet.cols = 702;
    const { text, html } = serializeRange(book, sheet.id, {
      r1: 0,
      c1: 0,
      r2: 4999,
      c2: 701,
    });
    // two rows of two cells, not 5,000 rows of 702
    expect(text.split("\n")).toHaveLength(2);
    expect(html.match(/<tr>/g)).toHaveLength(2);
    expect(html.match(/<td /g)).toHaveLength(4);
    expect(parseClipboard(text)).toEqual([
      ["a", ""],
      ["", "b"],
    ]);
  });

  it("usedRange cuts a selection to the cells in use", () => {
    const book = bookWith({ A1: "a", C3: "c" });
    const sheet = book.sheets[0];
    expect(usedRange(sheet, { r1: 0, c1: 0, r2: 4999, c2: 701 })).toEqual({
      r1: 0,
      c1: 0,
      r2: 2,
      c2: 2,
    });
    expect(usedRange(sheet, { r1: 5, c1: 5, r2: 4999, c2: 701 })).toEqual({
      r1: 5,
      c1: 5,
      r2: 5,
      c2: 5,
    });
    expect(usedRange(sheet, { r1: 0, c1: 0, r2: 1, c2: 1 })).toEqual({
      r1: 0,
      c1: 0,
      r2: 1,
      c2: 1,
    });
  });

  it("a pasted table past the cell budget is refused whole, not cut silently", () => {
    const cells = Array.from(
      { length: 200 },
      () => '<td rowspan="5000" colspan="702">x</td>',
    ).join("");
    expect(() =>
      parseClipboard("", `<table><tr>${cells}</tr></table>`),
    ).toThrow(PasteTooLarge);
    // a table within the budget is pasted as before
    expect(
      parseClipboard("", '<table><tr><td colspan="2">a</td></tr></table>'),
    ).toEqual([["a", ""]]);
  });
});
