import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { todo as B } from "@docmost/live-blocks";
import TodoReadOnly from "./todo-read-only";
import { task, useBrowserStubs } from "./test-harness";

useBrowserStubs();

const snapshot = (mutate: (board: B.TodoBoard) => void = () => {}) => {
  const board = B.createEmptyBoard();
  const parent = { ...task("p", "Parent"), done: true, priority: 3 as const };
  parent.children = [{ ...task("k", "Child"), done: true }];
  board.columns = [
    {
      ...B.newColumn("Sprint", 0, 0),
      id: "c1",
      nodes: [parent, { ...task("t", "Open"), done: false }],
    },
  ];
  mutate(board);
  return { kind: "todo" as const, board };
};

const show = (s: ReturnType<typeof snapshot> | undefined) =>
  render(
    <MantineProvider>
      <TodoReadOnly snapshot={s} />
    </MantineProvider>,
  );

describe("TodoReadOnly", () => {
  it("renders the cards, nested items and ticks as static content", () => {
    show(snapshot());
    expect(screen.getByText("Sprint")).toBeTruthy();
    expect(screen.getByText("Child")).toBeTruthy();
    expect(
      screen
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("aria-checked")),
    ).toEqual(["true", "true", "false"]);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("follows the board's hide-done setting", () => {
    show(snapshot((b) => B.setView(b, { sort: "manual", hideDone: true })));
    expect(screen.queryByText("Parent")).toBeNull();
    expect(screen.getByText("Open")).toBeTruthy();
  });

  it("says so when there is nothing to show", () => {
    show(undefined);
    expect(screen.getByText("No cards yet.")).toBeTruthy();
  });
});
