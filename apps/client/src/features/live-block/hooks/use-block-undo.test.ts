import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { LOCAL_ORIGIN, useBlockUndo } from "./use-block-undo";

describe("useBlockUndo", () => {
  it("undo reverts a local change and leaves a remote change alone", () => {
    const doc = new Y.Doc();
    const remote = new Y.Doc();
    const map = doc.getMap("m");
    const { result } = renderHook(() => useBlockUndo(doc, [map]));

    doc.transact(() => map.set("mine", 1), LOCAL_ORIGIN);
    remote.getMap("m").set("theirs", 2);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), "remote");
    expect(map.toJSON()).toEqual({ mine: 1, theirs: 2 });

    result.current.undo();
    expect(map.toJSON()).toEqual({ theirs: 2 });
    result.current.redo();
    expect(map.toJSON()).toEqual({ mine: 1, theirs: 2 });
  });

  it("Cmd+Z is handled and stopped", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("m");
    const { result } = renderHook(() => useBlockUndo(doc, [map]));
    doc.transact(() => map.set("mine", 1), LOCAL_ORIGIN);

    const event = (init: Partial<KeyboardEvent>) =>
      ({
        key: "z",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...init,
      }) as any;

    const undo = event({ metaKey: true });
    result.current.onKeyDown(undo);
    expect(undo.preventDefault).toHaveBeenCalled();
    expect(undo.stopPropagation).toHaveBeenCalled();
    expect(map.has("mine")).toBe(false);

    const redo = event({ ctrlKey: true, shiftKey: true, key: "Z" });
    result.current.onKeyDown(redo);
    expect(redo.stopPropagation).toHaveBeenCalled();
    expect(map.get("mine")).toBe(1);

    const other = event({ key: "a", metaKey: true });
    result.current.onKeyDown(other);
    expect(other.stopPropagation).not.toHaveBeenCalled();
  });
});
