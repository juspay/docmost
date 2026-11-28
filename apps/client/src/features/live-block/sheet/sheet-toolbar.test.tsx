import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { sheet as S } from "@docmost/live-blocks";
import { SheetWorkspace } from "./sheet-workspace";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as any;
});

function setup(cells: Record<string, string>, readOnly = false) {
  const book = S.createEmptyBook();
  for (const [a1, v] of Object.entries(cells)) {
    const ref = S.parseA1(a1)!;
    S.setCellRaw(book.sheets[0], ref.row, ref.col, v);
  }
  const doc = new Y.Doc();
  S.seedSheet(doc, book);
  const awareness = new Awareness(doc);
  const view = render(
    <MantineProvider>
      <SheetWorkspace
        doc={doc}
        provider={{ awareness } as any}
        readOnly={readOnly}
      />
    </MantineProvider>,
  );
  const sink = view.container.querySelector(
    "[data-sheet-sink]",
  ) as HTMLTextAreaElement;
  const cell = (a1: string) => {
    const ref = S.parseA1(a1)!;
    return S.readBook(doc).sheets[0].cells[`${ref.row}:${ref.col}`];
  };
  return { doc, view, sink, cell };
}

describe("sheet toolbar", () => {
  it("bold toggles on for a mixed selection and off when all cells are bold", () => {
    const t = setup({ A1: "a", A2: "b" });
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(t.cell("A1").f?.bold).toBe(true);
    // select A1:A2, one bold and one not
    fireEvent.keyDown(t.sink, { key: "ArrowDown", shiftKey: true });
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(bold);
    expect([t.cell("A1").f?.bold, t.cell("A2").f?.bold]).toEqual([true, true]);
    expect(
      screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect([t.cell("A1").f, t.cell("A2").f]).toEqual([undefined, undefined]);
  });

  it("Cmd+B, alignment and percent act on the selection", () => {
    const t = setup({ A1: "0.25" });
    fireEvent.keyDown(t.sink, { key: "b", metaKey: true });
    expect(t.cell("A1").f?.bold).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Align center" }));
    fireEvent.click(screen.getByRole("button", { name: "Format as percent" }));
    expect(t.cell("A1").f).toMatchObject({
      bold: true,
      align: "center",
      numFmt: "percent",
    });
    expect(
      t.view.container.querySelector('[data-r="0"][data-c="0"]')!.textContent,
    ).toBe("25%");
  });

  it("Cmd+Z with a toolbar button focused is the sheet's undo, not the page's", () => {
    const t = setup({ A1: "a" });
    const pageEditor = vi.fn();
    document.addEventListener("keydown", pageEditor);
    try {
      const bold = screen.getByRole("button", { name: "Bold" });
      fireEvent.click(bold);
      expect(t.cell("A1").f?.bold).toBe(true);
      bold.focus();
      fireEvent.keyDown(bold, { key: "z", metaKey: true });
      expect(t.cell("A1").f).toBeUndefined();
      expect(pageEditor).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", pageEditor);
    }
  });

  it("is hidden for a reader", () => {
    setup({ A1: "x" }, true);
    expect(screen.queryByRole("button", { name: "Bold" })).toBeNull();
  });
});
