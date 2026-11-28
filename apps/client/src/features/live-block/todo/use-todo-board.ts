import { useCallback, useEffect, useState } from "react";
import type * as Y from "yjs";
import { readBoard, writeBoardChange, type todo } from "@docmost/live-blocks";
import { LOCAL_ORIGIN } from "../hooks/use-block-undo";

/** The shared types a person's undo history covers. */
export function todoScope(doc: Y.Doc): Y.AbstractType<any>[] {
  return [doc.getMap("meta"), doc.getMap("columns"), doc.getMap("nodes")];
}

export function useTodoBoard(doc: Y.Doc, readOnly: boolean) {
  const [board, setBoard] = useState<todo.TodoBoard>(() => readBoard(doc));

  useEffect(() => {
    const read = () => setBoard(readBoard(doc));
    read();
    doc.on("update", read);
    return () => doc.off("update", read);
  }, [doc]);

  const apply = useCallback(
    (mutate: (draft: todo.TodoBoard) => void) => {
      if (readOnly) return;
      // always diff against what the document holds now, never an older read
      const current = readBoard(doc);
      const next = structuredClone(current);
      mutate(next);
      writeBoardChange(doc, current, next, LOCAL_ORIGIN);
    },
    [doc, readOnly],
  );

  return { board, apply };
}
