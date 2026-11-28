import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { sheet as S, type SheetSnapshot } from "@docmost/live-blocks";
import { SheetWorkspace } from "./sheet-workspace";
import SheetReadOnly from "./sheet-read-only";
import { SheetLive } from "./sheet-view";
import { useRemoteSelections } from "./use-remote-selections";
import * as formatActions from "./format-actions";
import { renderHook } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("./format-actions", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, allHave: vi.fn(actual.allHave) };
});

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

function seeded(
  cells: Record<string, string>,
  size?: { rows: number; cols: number },
) {
  const book = S.createEmptyBook();
  if (size) Object.assign(book.sheets[0], size);
  for (const [a1, v] of Object.entries(cells)) {
    const ref = S.parseA1(a1)!;
    S.setCellRaw(book.sheets[0], ref.row, ref.col, v);
  }
  const doc = new Y.Doc();
  S.seedSheet(doc, book);
  return doc;
}

function mount(doc: Y.Doc) {
  const awareness = new Awareness(doc);
  const provider: any = {
    awareness,
    setAwarenessField: (k: string, v: unknown) =>
      awareness.setLocalStateField(k, v),
  };
  const view = render(
    <MantineProvider>
      <div
        className="ProseMirror"
        contentEditable
        suppressContentEditableWarning
        tabIndex={0}
      >
        <SheetWorkspace doc={doc} provider={provider} readOnly={false} />
      </div>
    </MantineProvider>,
  );
  const sink = view.container.querySelector(
    "[data-sheet-sink]",
  ) as HTMLTextAreaElement;
  const raw = (a1: string) => {
    const ref = S.parseA1(a1)!;
    return S.readBook(doc).sheets[0].cells[`${ref.row}:${ref.col}`]?.v ?? "";
  };
  return { view, sink, raw, awareness };
}

const clipboard = (data: Record<string, string>) => {
  const store = new Map(Object.entries(data));
  return {
    getData: (k: string) => store.get(k) ?? "",
    setData: (k: string, v: string) => store.set(k, v),
    store,
  };
};

describe("sheet workspace", () => {
  it("Escape on a single cell hands the keys back to the page (no keyboard trap)", () => {
    const t = mount(seeded({ A1: "x" }));
    const page = t.view.container.querySelector(".ProseMirror") as HTMLElement;
    t.sink.focus();
    fireEvent.keyDown(t.sink, { key: "ArrowDown", shiftKey: true });
    // first Escape collapses the selection and keeps the focus
    fireEvent.keyDown(t.sink, { key: "Escape" });
    expect(document.activeElement).toBe(t.sink);
    fireEvent.keyDown(t.sink, { key: "Escape" });
    expect(document.activeElement).toBe(page);
  });

  it("text from an input method starts an edit with that text", () => {
    const t = mount(seeded({}));
    fireEvent.compositionEnd(t.sink, { data: "日本" });
    const editor = t.view.container.querySelector(
      "[data-cell-editor]",
    ) as HTMLTextAreaElement;
    expect(editor.value).toBe("日本");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(t.raw("A1")).toBe("日本");
  });

  it("clearing a whole-sheet selection clears the cells in use", () => {
    const doc = seeded({ A1: "a", C3: "c" }, { rows: 5000, cols: 702 });
    const t = mount(doc);
    fireEvent.keyDown(t.sink, { key: "a", metaKey: true });
    // the clamp to the used part is usedRange, tested in clipboard.test.ts
    fireEvent.keyDown(t.sink, { key: "Delete" });
    expect([t.raw("A1"), t.raw("C3")]).toEqual(["", ""]);
  });

  it("a pasted table that expands past the budget shows a notice and pastes nothing", () => {
    const t = mount(seeded({ A1: "kept" }));
    vi.mocked(notifications.show).mockClear();
    const cells = Array.from(
      { length: 200 },
      () => '<td rowspan="5000" colspan="702">x</td>',
    ).join("");
    fireEvent.paste(t.sink, {
      clipboardData: clipboard({
        "text/plain": "x",
        "text/html": `<table><tr>${cells}</tr></table>`,
      }),
    });
    expect(notifications.show).toHaveBeenCalled();
    expect(t.raw("A1")).toBe("kept");
  });

  it("a paste too large to handle is refused before it is parsed", () => {
    const t = mount(seeded({ A1: "kept" }));
    const huge = "x\t".repeat(4_100_000);
    fireEvent.paste(t.sink, {
      clipboardData: clipboard({ "text/plain": huge }),
    });
    expect(notifications.show).toHaveBeenCalled();
    expect(t.raw("A1")).toBe("kept");
  });

  it("the toolbar works out its pressed states once per change, not per render", () => {
    const doc = seeded({ A1: "a" });
    const t = mount(doc);
    const sheetId = S.tabIds(doc)[0];
    const allHave = vi.mocked(formatActions.allHave);
    allHave.mockClear();
    // another person's cursor moving re-renders the sheet but changes no cell
    for (let i = 0; i < 5; i++) {
      act(() => {
        t.awareness.getStates().set(100, {
          user: { id: "u", name: "U", color: "#ff0000" },
          selection: { sheetId, row: i % 3, col: 1 + (i % 2) },
        });
        t.awareness.emit("change", [
          { added: [], updated: [100], removed: [] },
          "remote",
        ]);
      });
    }
    expect(
      t.view.container.querySelector('[data-r="1"][data-c="1"]')!.textContent,
    ).toContain("U");
    expect(allHave).not.toHaveBeenCalled();
    // a new selection works them out again: once for the five toggles
    fireEvent.keyDown(t.sink, { key: "ArrowRight", shiftKey: true });
    expect(allHave).toHaveBeenCalledTimes(5);
  });

  it("a reader can copy what they see", () => {
    const book = S.createEmptyBook();
    S.setCellRaw(book.sheets[0], 0, 0, "=2+3");
    const snapshot: SheetSnapshot = {
      kind: "sheet",
      book,
      display: { [book.sheets[0].id]: { "0:0": "5" } },
      truncated: false,
    };
    const view = render(
      <MantineProvider>
        <SheetReadOnly snapshot={snapshot} height={300} />
      </MantineProvider>,
    );
    const sink = view.container.querySelector(
      "[data-sheet-sink]",
    ) as HTMLTextAreaElement;
    const data = clipboard({});
    fireEvent.copy(sink, { clipboardData: data });
    expect(data.store.get("text/plain")).toBe("5");
  });

  it("while the full window is open, the inline view steps aside", () => {
    const doc = seeded({ A1: "x" });
    const ctx: any = {
      doc,
      provider: { awareness: new Awareness(doc), setAwarenessField: vi.fn() },
      synced: true,
      readOnly: false,
      peers: [],
      registerFlush: () => () => undefined,
      blockId: "b-1",
      pageId: "p-1",
      opened: false,
    };
    const nodeProps: any = {
      node: { attrs: {} },
      editor: { isEditable: true },
      updateAttributes: vi.fn(),
    };
    const inline = (url: string) =>
      render(
        <MantineProvider>
          <MemoryRouter initialEntries={[url]}>
            <SheetLive ctx={ctx} nodeProps={nodeProps} mode="inline" />
          </MemoryRouter>
        </MantineProvider>,
      );
    const open = inline("/p?block=b-1");
    expect(open.container.querySelector("[data-sheet-live]")).toBeNull();
    expect(screen.getByText("Open in the full window")).toBeTruthy();
    open.unmount();
    const closed = inline("/p");
    expect(closed.container.querySelector("[data-sheet-live]")).not.toBeNull();
  });

  it("a closed sheet view clears this person's cursor for others", () => {
    const setAwarenessField = vi.fn();
    const sel = { anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } };
    const hook = renderHook(() =>
      useRemoteSelections({ setAwarenessField }, "s1", sel),
    );
    hook.unmount();
    expect(setAwarenessField).toHaveBeenLastCalledWith("selection", null);
  });
});
