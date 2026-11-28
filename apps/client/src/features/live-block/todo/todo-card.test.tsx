import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModalsProvider } from "@mantine/modals";
import { readBoard, todo as B } from "@docmost/live-blocks";
import { TodoCard } from "./todo-card";
import { seededDoc, task, TodoHarness, useBrowserStubs } from "./test-harness";

useBrowserStubs();

// jsdom has no PointerEvent; a mouse event carries the coordinates we need
(window as any).PointerEvent ??= MouseEvent;

function mount(doc = seededDoc(), zoom = 1) {
  render(
    <TodoHarness doc={doc}>
      {(board) => (
        <ModalsProvider>
          {board.columns.map((c) => (
            <TodoCard key={c.id} column={c} zoom={zoom} canDelete />
          ))}
        </ModalsProvider>
      )}
    </TodoHarness>,
  );
  return doc;
}

const handle = () => screen.getByRole("separator", { name: "Resize card" });
const column = (doc: ReturnType<typeof seededDoc>) => readBoard(doc).columns[0];

function drag(el: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1], button: 0 });
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1] });
}

describe("TodoCard", () => {
  it("dragging a card edge sets its width and double-click resets it", async () => {
    // frames are what batch the writes while dragging
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const doc = mount();
    expect(column(doc).width).toBeNull();

    drag(handle(), [100, 10], [260, 10]);
    const width = column(doc).width;
    expect(width).not.toBeNull();
    expect(width).toBeGreaterThanOrEqual(B.MIN_COLUMN_WIDTH);
    expect(width).toBeLessThanOrEqual(B.MAX_COLUMN_WIDTH);

    fireEvent.doubleClick(handle());
    expect(column(doc).width).toBeNull();
    vi.restoreAllMocks();
  });

  it("dragging the header moves the card, divided by the zoom", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const doc = mount(seededDoc(), 2);
    const head = screen.getByLabelText("Card title").parentElement!;
    drag(head, [0, 0], [100, 60]);
    expect(column(doc)).toMatchObject({ x: 50, y: 30 });
    vi.restoreAllMocks();
  });

  it("pressing a title or a rating does not start a drag", () => {
    const doc = mount();
    drag(screen.getByLabelText("Card title"), [0, 0], [100, 60]);
    expect(column(doc)).toMatchObject({ x: 0, y: 0 });
  });

  it("renames the card when the title loses focus", () => {
    const doc = mount();
    const input = screen.getByLabelText("Card title");
    fireEvent.change(input, { target: { value: "Sprint 4" } });
    fireEvent.blur(input);
    expect(column(doc).title).toBe("Sprint 4");
  });

  it("adds a task and a section at the end of the card", () => {
    const doc = mount();
    fireEvent.click(screen.getByRole("button", { name: /Task/ }));
    fireEvent.click(screen.getByRole("button", { name: /Section/ }));
    expect(column(doc).nodes.map((n) => n.kind)).toEqual([
      "task",
      "task",
      "task",
      "section",
    ]);
  });

  it("deletes a card with no items at once", () => {
    const doc = mount(seededDoc([]));
    const board = readBoard(doc);
    expect(board.columns).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete card" }));
    // the ported function leaves a fresh card behind when the last one goes
    expect(readBoard(doc).columns[0].id).not.toBe("c1");
  });

  it("asks before deleting a card that has items", async () => {
    const doc = mount(seededDoc([task("t1", "keep me")]));
    fireEvent.click(screen.getByRole("button", { name: "Delete card" }));
    expect(readBoard(doc).columns[0].id).toBe("c1");

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(readBoard(doc).columns[0].id).not.toBe("c1");
  });
});
