import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { readBoard, todo as B, writeBoardChange } from "@docmost/live-blocks";
import { TodoItem } from "./todo-item";
import { seededDoc, task, TodoHarness, useBrowserStubs } from "./test-harness";

useBrowserStubs();

function mount(doc = seededDoc(), readOnly = false) {
  render(
    <TodoHarness doc={doc} readOnly={readOnly}>
      {(board) => (
        <div data-todo-card="c1">
          {B.viewNodes(board.columns[0].nodes, board.view).map((n) => (
            <TodoItem key={n.id} node={n} depth={0} />
          ))}
        </div>
      )}
    </TodoHarness>,
  );
  return doc;
}

const inputs = () => screen.getAllByRole("textbox") as HTMLInputElement[];
const rootIds = (doc: ReturnType<typeof seededDoc>) =>
  readBoard(doc).columns[0].nodes.map((n) => n.id);

describe("TodoItem", () => {
  it("Enter adds a sibling below and focuses it", () => {
    const doc = mount();
    fireEvent.keyDown(inputs()[0], { key: "Enter" });

    const ids = rootIds(doc);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe("t1");
    expect(ids[2]).toBe("t2");
    expect(inputs()).toHaveLength(3);
    expect(document.activeElement).toBe(inputs()[1]);
  });

  it("Tab nests under the previous sibling; Shift+Tab un-nests", () => {
    const doc = mount();
    fireEvent.keyDown(inputs()[1], { key: "Tab" });
    let board = readBoard(doc);
    expect(board.columns[0].nodes.map((n) => n.id)).toEqual(["t1"]);
    expect(board.columns[0].nodes[0].children.map((n) => n.id)).toEqual(["t2"]);
    expect(document.activeElement).toBe(inputs()[1]);

    fireEvent.keyDown(inputs()[1], { key: "Tab", shiftKey: true });
    board = readBoard(doc);
    expect(board.columns[0].nodes.map((n) => n.id)).toEqual(["t1", "t2"]);
    expect(board.columns[0].nodes[0].children).toEqual([]);
  });

  it("Cmd+Enter toggles done", () => {
    const doc = mount();
    fireEvent.keyDown(inputs()[0], { key: "Enter", metaKey: true });
    expect(readBoard(doc).columns[0].nodes[0].done).toBe(true);
    expect(
      screen.getAllByRole("checkbox")[0].getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.keyDown(inputs()[0], { key: "Enter", ctrlKey: true });
    expect(readBoard(doc).columns[0].nodes[0].done).toBe(false);
    expect(rootIds(doc)).toEqual(["t1", "t2"]);
  });

  it("clicking a rating chip cycles 0, 1, 2, 3, 0", () => {
    mount();
    const chip = () =>
      screen.getAllByRole("button", { name: /^Effort:/ })[0] as HTMLElement;
    const seen = [chip().getAttribute("aria-label")];
    for (let i = 0; i < 4; i++) {
      fireEvent.click(chip());
      seen.push(chip().getAttribute("aria-label"));
    }
    expect(seen).toEqual([
      "Effort: Not set",
      "Effort: Low",
      "Effort: Medium",
      "Effort: High",
      "Effort: Not set",
    ]);
  });

  it("priority shows as flames and cycles like the others", () => {
    const doc = mount();
    const chip = () =>
      screen.getAllByRole("button", { name: /^Priority:/ })[0] as HTMLElement;
    fireEvent.click(chip());
    fireEvent.click(chip());
    expect(readBoard(doc).columns[0].nodes[0].priority).toBe(2);
    expect(chip().querySelectorAll("[data-lit]")).toHaveLength(2);
  });

  it("an item can be made a section heading and back", () => {
    const doc = mount();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Turn into a section heading" })[0],
    );
    expect(readBoard(doc).columns[0].nodes[0].kind).toBe("section");
    expect(screen.getAllByLabelText("Section title")).toHaveLength(1);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Turn into a to-do item" }),
    );
    expect(readBoard(doc).columns[0].nodes[0].kind).toBe("task");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("a collapsed item hides its children", () => {
    const parent = { ...task("p"), children: [task("k")] };
    mount(seededDoc([parent]));
    expect(inputs()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(inputs()).toHaveLength(1);
    expect(screen.getByText("0/1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(inputs()).toHaveLength(2);
  });

  it("Alt+Up moves an item above its previous sibling", () => {
    const doc = mount(seededDoc([task("t1"), task("t2"), task("t3")]));
    fireEvent.keyDown(inputs()[2], { key: "ArrowUp", altKey: true });
    expect(rootIds(doc)).toEqual(["t1", "t3", "t2"]);
    expect(document.activeElement).toBe(inputs()[1]);
    fireEvent.keyDown(inputs()[1], { key: "ArrowDown", altKey: true });
    expect(rootIds(doc)).toEqual(["t1", "t2", "t3"]);
  });

  it("Backspace on an empty item removes it and focuses the one above", () => {
    const doc = mount(seededDoc([task("t1"), task("t2", "")]));
    fireEvent.keyDown(inputs()[1], { key: "Backspace" });
    expect(rootIds(doc)).toEqual(["t1"]);
    expect(document.activeElement).toBe(inputs()[0]);
  });

  it("Backspace on an empty item that has children leaves it alone", () => {
    const parent = { ...task("p", ""), children: [task("k")] };
    const doc = mount(seededDoc([parent]));
    fireEvent.keyDown(inputs()[0], { key: "Backspace" });
    expect(rootIds(doc)).toEqual(["p"]);
  });

  it("writes typed text when the field loses focus, not on every key", () => {
    const doc = mount();
    const input = inputs()[0];
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.change(input, { target: { value: "first draft" } });
    expect(readBoard(doc).columns[0].nodes[0].text).toBe("t1");
    expect(input.value).toBe("first draft");

    fireEvent.blur(input);
    expect(readBoard(doc).columns[0].nodes[0].text).toBe("first draft");
  });

  it("writes typed text after 400 ms without typing", () => {
    vi.useFakeTimers();
    try {
      const doc = mount();
      fireEvent.change(inputs()[0], { target: { value: "typed" } });
      act(() => vi.advanceTimersByTime(399));
      expect(readBoard(doc).columns[0].nodes[0].text).toBe("t1");
      act(() => vi.advanceTimersByTime(2));
      expect(readBoard(doc).columns[0].nodes[0].text).toBe("typed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps what is typed when a remote change lands before it is written", () => {
    const doc = mount();
    fireEvent.change(inputs()[0], { target: { value: "mine" } });
    act(() => {
      const current = readBoard(doc);
      const next = structuredClone(current);
      B.toggleDone(next, "t2");
      // someone else, through the same document
      writeBoardChange(doc, current, next, "remote");
    });
    expect(inputs()[0].value).toBe("mine");
  });

  it("read-only: no keys, buttons or typing change anything", () => {
    const doc = mount(seededDoc(), true);
    expect(inputs()[0].readOnly).toBe(true);
    fireEvent.keyDown(inputs()[0], { key: "Enter" });
    fireEvent.keyDown(inputs()[0], { key: "Enter", metaKey: true });
    expect(rootIds(doc)).toEqual(["t1", "t2"]);
    expect(readBoard(doc).columns[0].nodes[0].done).toBe(false);
    expect(
      screen.queryAllByRole("button", { name: "Delete item" }),
    ).toHaveLength(0);
  });
});

describe("ratings at rest", () => {
  it("an unset rating is marked to stay hidden until the row is hovered or focused", () => {
    mount();
    const chips = screen.getAllByRole("button", {
      name: /^(Priority|Effort|Time): Not set$/,
    });
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips)
      expect(chip.hasAttribute("data-unset")).toBe(true);
    // the stylesheet hides them on a resting row and card header
    const css = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "todo.module.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.row:not\(:hover\):not\(:focus-within\) \.rating\[data-unset\]/,
    );
    expect(css).toMatch(
      /\.cardHead:not\(:hover\):not\(:focus-within\) \.rating\[data-unset\]/,
    );
  });

  it("a read-only board shows no unset ratings at all, so text keeps its room", () => {
    mount(seededDoc(), true);
    expect(screen.queryAllByRole("img", { name: /Not set$/ })).toHaveLength(0);
  });
});
