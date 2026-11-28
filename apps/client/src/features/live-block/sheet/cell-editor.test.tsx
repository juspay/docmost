import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Awareness } from "y-protocols/awareness";
import { connect, docWithClientId, sheet as S } from "@docmost/live-blocks";
import { SheetWorkspace } from "./sheet-workspace";
import { insertReference } from "./cell-editor";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

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

function seededDoc(cells: Record<string, string> = {}, clientId = 1) {
  const book = S.createEmptyBook();
  book.sheets[0].id = "sheet1";
  book.activeSheetId = "sheet1";
  for (const [a1, v] of Object.entries(cells)) {
    const ref = S.parseA1(a1)!;
    S.setCellRaw(book.sheets[0], ref.row, ref.col, v);
  }
  const doc = docWithClientId(clientId);
  S.seedSheet(doc, book);
  return doc;
}

function setup(cells: Record<string, string> = {}) {
  const doc = seededDoc(cells);
  const awareness = new Awareness(doc);
  const provider: any = {
    awareness,
    setAwarenessField: (k: string, v: unknown) =>
      awareness.setLocalStateField(k, v),
  };
  const view = render(
    <MantineProvider>
      <SheetWorkspace doc={doc} provider={provider} readOnly={false} />
    </MantineProvider>,
  );
  const sink = () =>
    view.container.querySelector("[data-sheet-sink]") as HTMLTextAreaElement;
  const editor = () =>
    view.container.querySelector(
      "[data-cell-editor]",
    ) as HTMLTextAreaElement | null;
  const cellEl = (r: number, c: number) =>
    view.container.querySelector(
      `[data-sheet-grid] [data-r="${r}"][data-c="${c}"]`,
    ) as HTMLElement;
  const raw = (a1: string) => {
    const ref = S.parseA1(a1)!;
    return S.readBook(doc).sheets[0].cells[`${ref.row}:${ref.col}`]?.v ?? "";
  };
  const active = () => {
    const el = view.container.querySelector("[data-sheet-grid] [data-active]")!;
    return {
      row: Number(el.getAttribute("data-r")),
      col: Number(el.getAttribute("data-c")),
    };
  };
  const typeInto = (el: HTMLTextAreaElement, value: string) =>
    fireEvent.change(el, { target: { value, selectionStart: value.length } });
  return { doc, view, sink, editor, cellEl, raw, active, typeInto };
}

describe("cell editing", () => {
  it("typing then Enter writes the raw input and moves down", () => {
    const t = setup();
    fireEvent.keyDown(t.sink(), { key: "4" });
    expect(t.editor()).not.toBeNull();
    expect(t.editor()!.value).toBe("4");
    t.typeInto(t.editor()!, "42");
    fireEvent.keyDown(t.editor()!, { key: "Enter" });
    expect(t.raw("A1")).toBe("42");
    expect(t.editor()).toBeNull();
    expect(t.active()).toEqual({ row: 1, col: 0 });

    // Tab commits and moves right; F2 edits the existing value
    fireEvent.keyDown(t.sink(), { key: "F2" });
    t.typeInto(t.editor()!, "hello");
    fireEvent.keyDown(t.editor()!, { key: "Tab" });
    expect(t.raw("A2")).toBe("hello");
    expect(t.active()).toEqual({ row: 1, col: 1 });
  });

  it("Escape leaves the cell unchanged", () => {
    const t = setup({ A1: "keep" });
    fireEvent.keyDown(t.sink(), { key: "x" });
    t.typeInto(t.editor()!, "xyz");
    fireEvent.keyDown(t.editor()!, { key: "Escape" });
    expect(t.editor()).toBeNull();
    expect(t.raw("A1")).toBe("keep");
    // Delete clears the selection
    fireEvent.keyDown(t.sink(), { key: "Delete" });
    expect(t.raw("A1")).toBe("");
  });

  it("a formula shows its computed value and the formula bar shows the formula", () => {
    const t = setup({ A1: "2", A2: "=A1*3" });
    expect(t.cellEl(1, 0).textContent).toBe("6");
    fireEvent.keyDown(t.sink(), { key: "ArrowDown" });
    const bar = screen.getByLabelText("Formula") as HTMLInputElement;
    expect(bar.value).toBe("=A1*3");
    // editing in the bar writes the same cell
    fireEvent.focus(bar);
    fireEvent.change(bar, { target: { value: "=A1*5" } });
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(t.raw("A2")).toBe("=A1*5");
    expect(t.cellEl(1, 0).textContent).toBe("10");
  });

  it("clicking a cell while typing a formula inserts its A1 reference", () => {
    const t = setup({ B3: "7" });
    fireEvent.keyDown(t.sink(), { key: "=" });
    expect(t.editor()!.value).toBe("=");
    fireEvent.pointerDown(t.cellEl(2, 1), { button: 0 });
    expect(t.editor()!.value).toBe("=B3");
    // a second click replaces the reference just inserted
    fireEvent.pointerDown(t.cellEl(3, 2), { button: 0 });
    expect(t.editor()!.value).toBe("=C4");
    t.typeInto(t.editor()!, "=C4+");
    fireEvent.pointerDown(t.cellEl(2, 1), { button: 0 });
    expect(t.editor()!.value).toBe("=C4+B3");
    fireEvent.keyDown(t.editor()!, { key: "Enter" });
    expect(t.raw("A1")).toBe("=C4+B3");
    expect(t.cellEl(0, 0).textContent).toBe("7");
  });

  it("undo restores the previous value and does not undo another person's edit", () => {
    const t = setup({ A1: "old" });
    const other = docWithClientId(2);
    connect(t.doc, other);
    fireEvent.keyDown(t.sink(), { key: "n" });
    t.typeInto(t.editor()!, "new");
    fireEvent.keyDown(t.editor()!, { key: "Enter" });
    expect(t.raw("A1")).toBe("new");
    act(() => S.setCell(other, "sheet1", 4, 4, { v: "theirs" }));
    fireEvent.keyDown(t.sink(), { key: "z", metaKey: true });
    expect(t.raw("A1")).toBe("old");
    expect(t.raw("E5")).toBe("theirs");
    fireEvent.keyDown(t.sink(), { key: "z", metaKey: true, shiftKey: true });
    expect(t.raw("A1")).toBe("new");
  });

  it("an edit in progress follows its cell when another person inserts a row above it", () => {
    const t = setup({ A5: "five", A6: "six" });
    const other = docWithClientId(2);
    connect(t.doc, other);
    for (let i = 0; i < 4; i++)
      fireEvent.keyDown(t.sink(), { key: "ArrowDown" });
    fireEvent.keyDown(t.sink(), { key: "x" });
    t.typeInto(t.editor()!, "x typed");
    act(() => S.insertRows(other, "sheet1", 0, 2));
    expect(t.active()).toEqual({ row: 6, col: 0 });
    fireEvent.keyDown(t.editor()!, { key: "Enter" });
    expect(t.raw("A7")).toBe("x typed");
    expect(t.raw("A8")).toBe("six");
    expect(t.raw("A5")).toBe("");
  });

  it("Cmd+Z inside the sheet does not reach the page editor", () => {
    const t = setup({ A1: "1" });
    const pageEditor = vi.fn();
    document.addEventListener("keydown", pageEditor);
    try {
      fireEvent.keyDown(t.sink(), { key: "z", metaKey: true });
      fireEvent.keyDown(t.sink(), { key: "z", ctrlKey: true, shiftKey: true });
      expect(pageEditor).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", pageEditor);
    }
  });

  it("another person's selected cell is outlined in their colour", () => {
    const doc = seededDoc();
    const remoteDoc = docWithClientId(9);
    connect(doc, remoteDoc);
    const awareness = new Awareness(doc);
    const provider: any = {
      awareness,
      setAwarenessField: (k: string, v: unknown) =>
        awareness.setLocalStateField(k, v),
    };
    const view = render(
      <MantineProvider>
        <SheetWorkspace doc={doc} provider={provider} readOnly={false} />
      </MantineProvider>,
    );
    act(() => {
      const states = awareness.getStates();
      states.set(99, {
        user: { id: "u2", name: "Rita", color: "#ff8800" },
        selection: { sheetId: "sheet1", row: 2, col: 1 },
      });
      awareness.emit("change", [
        { added: [99], updated: [], removed: [] },
        "remote",
      ]);
    });
    const el = view.container.querySelector(
      '[data-r="2"][data-c="1"]',
    ) as HTMLElement;
    expect(el.style.outline).toContain("2px solid");
    expect(el.textContent).toContain("Rita");
    // our own selection is published for others
    expect(awareness.getLocalState()?.selection).toMatchObject({
      sheetId: "sheet1",
      row: 0,
      col: 0,
    });
  });
});

describe("insertReference", () => {
  it("inserts at the caret only where a reference may go", () => {
    expect(insertReference("=SUM(", 5, "A1", null)).toEqual({
      value: "=SUM(A1",
      span: [5, 7],
    });
    expect(insertReference("=A1+", 4, "B2", null)).toEqual({
      value: "=A1+B2",
      span: [4, 6],
    });
    expect(insertReference("=A1+B2", 6, "C3:C9", [4, 6])).toEqual({
      value: "=A1+C3:C9",
      span: [4, 9],
    });
    expect(insertReference("=A1", 3, "B2", null)).toBeNull();
    expect(insertReference("text", 4, "B2", null)).toBeNull();
  });
});

describe("an edit in progress is kept", () => {
  function mountWith(registerFlush?: (fn: () => void) => () => void) {
    const doc = seededDoc({ A1: "old" });
    const awareness = new Awareness(doc);
    const provider: any = { awareness, setAwarenessField: () => undefined };
    const view = render(
      <MantineProvider>
        <SheetWorkspace
          doc={doc}
          provider={provider}
          readOnly={false}
          registerFlush={registerFlush}
        />
        <button type="button">elsewhere</button>
      </MantineProvider>,
    );
    const sink = view.container.querySelector(
      "[data-sheet-sink]",
    ) as HTMLTextAreaElement;
    const editor = () =>
      view.container.querySelector(
        "[data-cell-editor]",
      ) as HTMLTextAreaElement | null;
    const raw = () => S.readBook(doc).sheets[0].cells["0:0"]?.v;
    return { view, sink, editor, raw };
  }

  it("leaving the cell editor commits the value", () => {
    const t = mountWith();
    fireEvent.keyDown(t.sink, { key: "n" });
    fireEvent.change(t.editor()!, {
      target: { value: "new", selectionStart: 3 },
    });
    fireEvent.blur(t.editor()!, {
      relatedTarget: screen.getByText("elsewhere"),
    });
    expect(t.raw()).toBe("new");
    expect(t.editor()).toBeNull();
  });

  it("clicking into an input outside the sheet keeps the focus there", () => {
    const t = mountWith();
    const outside = document.createElement("input");
    outside.setAttribute("aria-label", "page title");
    document.body.appendChild(outside);
    try {
      fireEvent.keyDown(t.sink, { key: "n" });
      fireEvent.change(t.editor()!, {
        target: { value: "typed", selectionStart: 5 },
      });
      // the browser moves the focus, then fires blur with relatedTarget
      outside.focus();
      fireEvent.blur(t.editor()!, { relatedTarget: outside });
      expect(t.raw()).toBe("typed");
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it("the room's flush commits the value before the block goes away", () => {
    const flushes: (() => void)[] = [];
    const t = mountWith((fn) => {
      flushes.push(fn);
      return () => flushes.splice(flushes.indexOf(fn), 1);
    });
    fireEvent.keyDown(t.sink, { key: "n" });
    fireEvent.change(t.editor()!, {
      target: { value: "kept", selectionStart: 4 },
    });
    expect(flushes.length).toBeGreaterThan(0);
    act(() => flushes.forEach((fn) => fn()));
    expect(t.raw()).toBe("kept");
  });

  it("unmounting the sheet commits the value", () => {
    const t = mountWith();
    fireEvent.keyDown(t.sink, { key: "n" });
    fireEvent.change(t.editor()!, {
      target: { value: "on unmount", selectionStart: 10 },
    });
    t.view.unmount();
    expect(t.raw()).toBe("on unmount");
  });

  it("Escape still throws the edit away", () => {
    const t = mountWith();
    fireEvent.keyDown(t.sink, { key: "n" });
    fireEvent.change(t.editor()!, {
      target: { value: "discard", selectionStart: 7 },
    });
    fireEvent.keyDown(t.editor()!, { key: "Escape" });
    t.view.unmount();
    expect(t.raw()).toBe("old");
  });
});
