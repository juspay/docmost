import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  blockDocumentName,
  buildSnapshot,
  type LiveBlockKind,
  type LiveBlockSnapshot,
} from "@docmost/live-blocks";
import {
  getBlockSaveState,
  getRetainedDoc,
  subscribeBlockSaveState,
  type BlockSaveState,
} from "./block-provider-registry";
import useCurrentUser from "@/features/user/hooks/use-current-user";

/** Whether this block has edits the server has not saved yet, from any of its views. */
export function useBlockSaveState(blockId: string | null): BlockSaveState {
  const name = blockId ? blockDocumentName(blockId) : "";
  const userId = useCurrentUser().data?.user?.id;
  const subscribe = useCallback(
    (listener: () => void) => subscribeBlockSaveState(name, listener),
    [name],
  );
  return useSyncExternalStore(subscribe, () => getBlockSaveState(name, userId));
}

/**
 * The block as this tab holds it, built the way the server builds the stored
 * snapshot, or null when the tab holds no document for it. Lets a closed block
 * show its kept edits while the server cannot be reached.
 */
export function useLocalBlockSnapshot(
  blockId: string | null,
  kind: LiveBlockKind,
  enabled: boolean,
): LiveBlockSnapshot | null {
  const name = blockId ? blockDocumentName(blockId) : "";
  const subscribe = useCallback(
    (listener: () => void) => subscribeBlockSaveState(name, listener),
    [name],
  );
  const doc = useSyncExternalStore(subscribe, () =>
    enabled ? getRetainedDoc(name) : null,
  );
  // the registry announces every local edit: rebuild then
  const [tick, bump] = useState(0);
  useEffect(
    () => (doc ? subscribe(() => bump((n) => n + 1)) : undefined),
    [doc, subscribe],
  );
  return useMemo(() => {
    if (!enabled || !doc) return null;
    try {
      return buildSnapshot(kind, doc);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, doc, kind, tick]);
}
