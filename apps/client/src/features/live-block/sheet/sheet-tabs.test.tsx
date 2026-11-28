import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { sheet as S } from "@docmost/live-blocks";
import { SheetWorkspace } from "./sheet-workspace";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (s: string, o?: any) => (o?.name ? s.replace("{{name}}", o.name) : s),
  }),
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
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});

function setup(extraTabs: string[] = [], cells: Record<string, string> = {}) {
  const book = S.createEmptyBook();
  for (const [a1, v] of Object.entries(cells)) {
    const ref = S.parseA1(a1)!;
    S.setCellRaw(book.sheets[0], ref.row, ref.col, v);
  }
  for (const name of extraTabs) S.addSheet(book, name);
  const doc = new Y.Doc();
  S.seedSheet(doc, book);
  const awareness = new Awareness(doc);
  const provider: any = { awareness, setAwarenessField: () => undefined };
  const view = render(
    <MantineProvider>
      <SheetWorkspace doc={doc} provider={provider} readOnly={false} />
    </MantineProvider>,
  );
  return { doc, view, names: () => S.readBook(doc).sheets.map((s) => s.name) };
}

async function openTabMenu(name: string) {
  fireEvent.contextMenu(screen.getByRole("tab", { name }));
  // the dropdown is still mid-transition in jsdom
  return screen.findByRole("menu", { hidden: true });
}

describe("sheet tabs", () => {
  it("adds a tab and switches to it", () => {
    const t = setup();
    fireEvent.click(screen.getByLabelText("Add sheet"));
    expect(t.names()).toEqual(["Sheet1", "Sheet2"]);
    expect(
      screen.getByRole("tab", { name: "Sheet2" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("a click switches tabs without opening the tab menu", () => {
    setup(["Data"]);
    fireEvent.click(screen.getByRole("tab", { name: "Data" }));
    expect(
      screen.getByRole("tab", { name: "Data" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
  });

  it("the last tab cannot be deleted", async () => {
    const t = setup();
    const menu = await openTabMenu("Sheet1");
    const del = within(menu).getByRole("menuitem", {
      name: "Delete",
      hidden: true,
    });
    expect(
      del.hasAttribute("disabled") ||
        del.getAttribute("data-disabled") === "true",
    ).toBe(true);
    fireEvent.click(del);
    expect(t.names()).toEqual(["Sheet1"]);
  });

  it("deletes a tab after confirmation", async () => {
    const t = setup(["Data"]);
    const menu = await openTabMenu("Data");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Delete", hidden: true }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete sheet" }),
    );
    expect(t.names()).toEqual(["Sheet1"]);
  });

  it("renaming a tab updates formulas that refer to it", async () => {
    const t = setup(["Data"], { A1: "=Data!A1+1" });
    const dataId = S.readBook(t.doc).sheets[1].id;
    act(() => S.setCell(t.doc, dataId, 0, 0, { v: "41" }));
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Data" }));
    const input = screen.getByLabelText("Sheet name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Facts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(t.names()).toEqual(["Sheet1", "Facts"]);
    const book = S.readBook(t.doc);
    expect(book.sheets[0].cells["0:0"].v).toBe("=Facts!A1+1");
    expect(new S.Engine(book).getValue(book.sheets[0].id, 0, 0)).toBe(42);
  });

  it("reorders tabs by dragging", () => {
    const t = setup(["Two", "Three"]);
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      effectAllowed: "move",
      dropEffect: "move",
    };
    fireEvent.dragStart(screen.getByRole("tab", { name: "Three" }), {
      dataTransfer,
    });
    fireEvent.dragOver(screen.getByRole("tab", { name: "Sheet1" }), {
      dataTransfer,
    });
    fireEvent.drop(screen.getByRole("tab", { name: "Sheet1" }), {
      dataTransfer,
    });
    expect(t.names()).toEqual(["Three", "Sheet1", "Two"]);
  });
});
