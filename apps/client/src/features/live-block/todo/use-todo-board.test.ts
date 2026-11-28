import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import {
  readBoard,
  seedTodo,
  todo as B,
  writeBoardChange,
} from "@docmost/live-blocks";
import { useBlockUndo } from "../hooks/use-block-undo";
import { todoScope, useTodoBoard } from "./use-todo-board";

const task = (id: string, text = id): B.TodoNode => ({
  ...B.newTask(text),
  id,
});

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  const board = B.createEmptyBoard();
  board.columns = [
    { ...B.newColumn("Card"), id: "c1", nodes: [task("t1"), task("t2")] },
  ];
  seedTodo(doc, board);
  return doc;
}

const ids = (board: B.TodoBoard) => board.columns[0].nodes.map((n) => n.id);

describe("useTodoBoard", () => {
  it("apply writes the change and board reflects it", () => {
    const doc = seeded();
    const { result } = renderHook(() => useTodoBoard(doc, false));
    expect(ids(result.current.board)).toEqual(["t1", "t2"]);

    act(() => result.current.apply((d) => B.setText(d, "t1", "renamed")));

    expect(result.current.board.columns[0].nodes[0].text).toBe("renamed");
    expect(readBoard(doc).columns[0].nodes[0].text).toBe("renamed");
  });

  it("a remote change re-renders the board", () => {
    const doc = seeded();
    const { result } = renderHook(() => useTodoBoard(doc, false));
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const board = readBoard(remote);
    const next = structuredClone(board);
    B.toggleDone(next, "t2");
    // the other person writes through their own document
    writeBoardChange(remote, board, next);

    act(() => {
      Y.applyUpdate(
        doc,
        Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)),
      );
    });

    expect(result.current.board.columns[0].nodes[1].done).toBe(true);
  });

  it("read-only: apply does nothing", () => {
    const doc = seeded();
    const before = Y.encodeStateAsUpdate(doc);
    const { result } = renderHook(() => useTodoBoard(doc, true));

    act(() => result.current.apply((d) => B.removeNode(d, "t1")));

    expect(ids(result.current.board)).toEqual(["t1", "t2"]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("changes made through apply start from what the document holds now", () => {
    const doc = seeded();
    const { result } = renderHook(() => useTodoBoard(doc, false));
    const stale = result.current.apply;
    // a change from elsewhere that the hook has not rendered yet
    const other = readBoard(doc);
    const next = structuredClone(other);
    B.setText(next, "t2", "theirs");
    writeBoardChange(doc, other, next);

    act(() => stale((d) => B.toggleDone(d, "t1")));

    const board = readBoard(doc);
    expect(board.columns[0].nodes[0].done).toBe(true);
    expect(board.columns[0].nodes[1].text).toBe("theirs");
  });

  it("undo restores a deleted item", () => {
    const doc = seeded();
    const { result } = renderHook(() => ({
      board: useTodoBoard(doc, false),
      undo: useBlockUndo(doc, todoScope(doc)),
    }));

    act(() => result.current.board.apply((d) => B.removeNode(d, "t1")));
    expect(ids(result.current.board.board)).toEqual(["t2"]);

    act(() => result.current.undo.undo());
    expect(ids(result.current.board.board)).toEqual(["t1", "t2"]);

    act(() => result.current.undo.redo());
    expect(ids(result.current.board.board)).toEqual(["t2"]);
  });
});
