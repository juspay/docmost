import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { beforeAll, vi } from "vitest";
import { MantineProvider } from "@mantine/core";
import * as Y from "yjs";
import { seedTodo, todo as B } from "@docmost/live-blocks";
import { TodoContext } from "./todo-context";
import { useTodoBoard } from "./use-todo-board";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (s: string, vars?: Record<string, unknown>) =>
      vars ? s.replace(/{{(\w+)}}/g, (_, k) => String(vars[k])) : s,
  }),
}));

export const task = (id: string, text = id): B.TodoNode => ({
  ...B.newTask(text),
  id,
});

export function seededDoc(
  nodes: B.TodoNode[] = [task("t1"), task("t2")],
): Y.Doc {
  const doc = new Y.Doc();
  const board = B.createEmptyBoard();
  board.columns = [{ ...B.newColumn("Card", 0, 0), id: "c1", nodes }];
  seedTodo(doc, board);
  return doc;
}

export function useBrowserStubs() {
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
    (globalThis as any).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });
}

/** What the canvas provides, around whatever part is under test. */
export function TodoHarness({
  doc,
  readOnly = false,
  children,
}: {
  doc: Y.Doc;
  readOnly?: boolean;
  children: (board: B.TodoBoard) => ReactNode;
}) {
  const { board, apply } = useTodoBoard(doc, readOnly);
  const [focusId, requestFocus] = useState<string | null>(null);
  const flushers = useRef(new Set<() => void>());
  const registerFlush = useCallback((fn: () => void) => {
    flushers.current.add(fn);
    return () => {
      flushers.current.delete(fn);
    };
  }, []);
  const value = useMemo(
    () => ({
      view: board.view,
      readOnly,
      apply,
      focusId,
      requestFocus,
      registerFlush,
    }),
    [board.view, readOnly, apply, focusId, registerFlush],
  );
  return (
    <MantineProvider>
      <TodoContext.Provider value={value}>
        {children(board)}
      </TodoContext.Provider>
    </MantineProvider>
  );
}
