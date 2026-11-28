import { createContext, useContext } from "react";
import type { todo } from "@docmost/live-blocks";

export type TodoContextValue = {
  view: todo.TodoView;
  readOnly: boolean;
  apply(mutate: (draft: todo.TodoBoard) => void): void;
  /** The item or card title that should take keyboard focus next. */
  focusId: string | null;
  requestFocus(id: string | null): void;
  /** A field registers the write it has not made yet; returns the unregister. */
  registerFlush(fn: () => void): () => void;
};

export const TodoContext = createContext<TodoContextValue | null>(null);

export function useTodoContext(): TodoContextValue {
  const value = useContext(TodoContext);
  if (!value) throw new Error("useTodoContext needs a TodoContext provider");
  return value;
}
