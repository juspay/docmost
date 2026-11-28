import { useEffect, useState } from "react";
import type { RemoteCursor } from "./grid";
import { safeColor } from "./grid-cell";
import type { GridSelection } from "./use-grid-selection";

type AwarenessLike = {
  clientID: number;
  getStates(): Map<number, Record<string, any>>;
  on(event: "change", fn: () => void): void;
  off(event: "change", fn: () => void): void;
};

export type ProviderLike = {
  awareness?: AwarenessLike | null;
  setAwarenessField?(key: string, value: unknown): void;
};

/** Publishes this person's selection and returns the others' on this tab. */
export function useRemoteSelections(
  provider: ProviderLike | null | undefined,
  sheetId: string,
  selection: GridSelection,
): RemoteCursor[] {
  const { anchor, focus } = selection;
  useEffect(() => {
    provider?.setAwarenessField?.("selection", {
      sheetId,
      row: anchor.row,
      col: anchor.col,
      focusRow: focus.row,
      focusCol: focus.col,
    });
  }, [provider, sheetId, anchor.row, anchor.col, focus.row, focus.col]);
  // a closed sheet view stops showing this person's cursor to others
  useEffect(
    () => () => provider?.setAwarenessField?.("selection", null),
    [provider],
  );

  const [cursors, setCursors] = useState<RemoteCursor[]>([]);
  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness) return;
    const read = () => {
      const next: RemoteCursor[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const s = state?.selection;
        const user = state?.user;
        if (!s || !user || s.sheetId !== sheetId) return;
        if (!Number.isInteger(s.row) || !Number.isInteger(s.col)) return;
        next.push({
          row: s.row,
          col: s.col,
          color: safeColor(user.color) ?? "#868e96",
          name: String(user.name ?? ""),
        });
      });
      setCursors((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    };
    awareness.on("change", read);
    read();
    return () => awareness.off("change", read);
  }, [provider, sheetId]);
  return cursors;
}
