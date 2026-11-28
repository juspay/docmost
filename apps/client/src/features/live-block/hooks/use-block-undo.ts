import { useEffect, useMemo } from "react";
import * as Y from "yjs";

/** Every local write to a block document uses this origin. */
export const LOCAL_ORIGIN: unique symbol = Symbol("live-block-local");

type KeyEventLike = Pick<
  KeyboardEvent,
  | "key"
  | "metaKey"
  | "ctrlKey"
  | "shiftKey"
  | "preventDefault"
  | "stopPropagation"
>;

/** Undo of this person's own block edits only; the page editor never sees the keys. */
export function useBlockUndo(doc: Y.Doc, scope: Y.AbstractType<any>[]) {
  const manager = useMemo(
    () =>
      new Y.UndoManager(scope, {
        trackedOrigins: new Set([LOCAL_ORIGIN]),
        captureTimeout: 300,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, ...scope],
  );

  useEffect(() => () => manager.destroy(), [manager]);

  return useMemo(
    () => ({
      undo: () => {
        manager.undo();
      },
      redo: () => {
        manager.redo();
      },
      onKeyDown: (e: KeyEventLike) => {
        if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) manager.redo();
        else manager.undo();
      },
    }),
    [manager],
  );
}
