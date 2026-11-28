import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { v7 as uuid7 } from "uuid";
import { liveBlockOrigin, withNewBlockId } from "@docmost/editor-ext";
import type { LiveBlockKind, LiveBlockSnapshot } from "@docmost/live-blocks";
import { useLiveBlockHost } from "../live-block-host";
import type { LiveBlockStatus, SnapshotState } from "../live-block.types";
import {
  cloneLiveBlock,
  ensureLiveBlock,
} from "../services/live-block-service";
import { useLiveBlockSnapshotQuery } from "../queries/live-block-query";
import { blockDocumentName } from "@docmost/live-blocks";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import {
  discardStoredBlock,
  hasStoredBlock,
} from "../components/block-provider-registry";
import { getPageById } from "@/features/page/services/page-service";
import { useEditorEditable } from "./use-editor-editable";
import { setAttrsQuietly } from "./set-attrs-quietly";

type HttpError = { response?: { status?: number; data?: { code?: string } } };
const FINAL_REFUSALS = new Set(["PAGE_NOT_FOUND", "PAGE_NOT_EDITABLE"]);
const statusOf = (err: unknown) => (err as HttpError)?.response?.status;
const codeOf = (err: unknown) => (err as HttpError)?.response?.data?.code;

// ids this editor already ensured or cloned; a block remounting does not call again
// one request per editor and id: an effect re-run (the block coming into view
// while its clone is out) joins the request instead of sending another
const inFlightByEditor = new WeakMap<object, Map<string, Promise<unknown>>>();
function once<T>(
  editor: object,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  let map = inFlightByEditor.get(editor);
  if (!map) inFlightByEditor.set(editor, (map = new Map()));
  const running = map.get(key) as Promise<T> | undefined;
  if (running) return running;
  const started = start();
  map.set(key, started);
  const done = () => {
    if (map!.get(key) === started) map!.delete(key);
  };
  started.then(done, done);
  return started;
}

const settledByEditor = new WeakMap<object, Set<string>>();
function settledIds(editor: object): Set<string> {
  let ids = settledByEditor.get(editor);
  if (!ids) settledByEditor.set(editor, (ids = new Set()));
  return ids;
}

export type UseLiveBlockResult = {
  status: LiveBlockStatus;
  blockId: string | null;
  pageId: string | null;
  retry(): void;
  replaceWithEmpty(): void;
  snapshot?: LiveBlockSnapshot;
  snapshotUpdatedAt?: string;
  snapshotState: SnapshotState;
};

/**
 * Decides whether a block is live, read-only or unavailable, and makes sure
 * its row exists before it goes live. `active` is false until the block is
 * about to go live (in view, or opened): nothing is sent before that.
 */
export function useLiveBlock(
  props: NodeViewProps,
  kind: LiveBlockKind,
  active = true,
  /** an editor's view also wants the stored snapshot (e.g. a closed whiteboard) */
  wantSnapshot = false,
): UseLiveBlockResult {
  const { editor, node, updateAttributes } = props;
  const host = useLiveBlockHost();
  const editable = useEditorEditable(editor);
  const blockId: string | null = node.attrs.blockId ?? null;
  const pageId = "pageId" in host ? host.pageId : null;
  const live = host.mode === "page" && editable;

  const [result, setResult] = useState<{
    id: string | null;
    status: LiveBlockStatus;
  }>({ id: null, status: "ensuring" });
  const [attempt, setAttempt] = useState(0);
  const userIdRef = useRef<string | undefined>(undefined);
  userIdRef.current = useCurrentUser().data?.user?.id;
  const propsRef = useRef(props);
  propsRef.current = props;
  const nodeAttrsRef = useRef(node.attrs);
  nodeAttrsRef.current = node.attrs;
  // only the changed attributes: the id, and a preview file that belonged to the old id
  const newIdAttrs = (newId: string) => {
    const next = withNewBlockId(nodeAttrsRef.current, newId);
    const changes: Record<string, unknown> = { blockId: newId };
    for (const key of ["attachmentId", "src"]) {
      if (key in nodeAttrsRef.current) changes[key] = next[key];
    }
    return changes;
  };
  const updateRef = useRef(updateAttributes);
  updateRef.current = updateAttributes;

  useEffect(() => {
    if (!live || !blockId || !pageId) return;
    // a copy is made when it is inserted: the record of what it was copied
    // from lives only in this tab, and would be lost by a reload
    if (!active && !liveBlockOrigin(editor).copies.has(blockId)) return;
    const settled = settledIds(editor);
    if (settled.has(blockId)) {
      setResult({ id: blockId, status: "ready" });
      return;
    }
    let cancelled = false;
    const origin = liveBlockOrigin(editor);
    const set = (status: LiveBlockStatus) => {
      if (!cancelled) setResult({ id: blockId, status });
    };
    // a new id re-runs this effect for that id
    const moveTo = (newId: string) => {
      // not the person's edit: Ctrl+Z must not hand back the taken id
      if (!cancelled) setAttrsQuietly(propsRef.current, newIdAttrs(newId));
    };

    const run = async () => {
      set("ensuring");
      const source = origin.copies.get(blockId);
      if (source && source !== blockId) {
        try {
          await once(editor, `clone:${blockId}`, () =>
            cloneLiveBlock({ sourceBlockId: source, blockId, pageId }),
          );
          origin.copies.delete(blockId);
          settled.add(blockId);
          set("ready");
        } catch (err) {
          if (statusOf(err) === 404) return set("no-access");
          if (statusOf(err) === 409 && codeOf(err) === "BLOCK_ID_TAKEN") {
            const newId = uuid7();
            origin.copies.delete(blockId);
            origin.copies.set(newId, source);
            return moveTo(newId);
          }
          set(statusOf(err) === 403 ? "no-access" : "error");
        }
        return;
      }

      try {
        await once(editor, `ensure:${blockId}`, () =>
          ensureLiveBlock({ blockId, pageId, kind }),
        );
        settled.add(blockId);
        set("ready");
      } catch (err) {
        if (statusOf(err) === 409 && codeOf(err) === "BLOCK_ID_TAKEN") {
          if (origin.created.has(blockId)) {
            // someone else took the id first; nothing was stored under it
            const newId = uuid7();
            origin.created.delete(blockId);
            origin.created.add(newId);
            return moveTo(newId);
          }
          if (origin.copies.get(blockId) === blockId) {
            // pasted here from another page by this person: copy it
            const newId = uuid7();
            origin.copies.delete(blockId);
            origin.copies.set(newId, blockId);
            return moveTo(newId);
          }
          // never clone here: this person did not ask for a copy
          return set("foreign");
        }
        // Only the server's own coded refusals from its edit check are
        // final for this user: PAGE_NOT_FOUND and PAGE_NOT_EDITABLE. A bare
        // 403/404 (a proxy, a WAF challenge, a misrouted deploy) and
        // PAGE_IN_TRASH (a restore undoes it) never drop stored edits (N1).
        const status = statusOf(err);
        if (FINAL_REFUSALS.has(codeOf(err) ?? "") && userIdRef.current) {
          void discardStoredBlock(
            blockDocumentName(blockId),
            pageId,
            userIdRef.current,
          ).catch(() => undefined);
        }
        if (status === 403) return set("no-access");
        set("error");
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [live, active, blockId, pageId, kind, editor, attempt]);

  // A block shown read-only on a page that is open for editing elsewhere may
  // hold edits stored on this device. If a FRESH answer from the server (not
  // cached data, never while offline) says this user cannot edit the page and
  // the page is not in the trash, those edits can never be sent: drop them
  // now, before an edit right returns and a restore would replay them.
  const userId = userIdRef.current;
  useEffect(() => {
    if (host.mode !== "page" || editable || !blockId || !pageId || !userId)
      return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let cancelled = false;
    const name = blockDocumentName(blockId);
    void (async () => {
      if (!(await hasStoredBlock(name, pageId, userId)) || cancelled) return;
      const page = await getPageById({ pageId });
      if (cancelled) return;
      if (page.permissions?.canEdit === false && !page.deletedAt) {
        await discardStoredBlock(name, pageId, userId);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [host.mode, editable, blockId, pageId, userId]);

  const readOnly = host.mode !== "none" && !live;
  const ensured = live && result.id === blockId && result.status === "ready";
  const snapshotQuery = useLiveBlockSnapshotQuery({
    host,
    blockId,
    enabled: active && (readOnly || (ensured && wantSnapshot)),
  });

  let status: LiveBlockStatus;
  if (host.mode === "none") status = "unavailable";
  else if (readOnly) status = "read-only";
  else status = result.id === blockId ? result.status : "ensuring";

  let snapshotState: SnapshotState = "idle";
  if (readOnly || (ensured && wantSnapshot)) {
    if (snapshotQuery.data) snapshotState = "ready";
    else if (snapshotQuery.error) {
      snapshotState =
        statusOf(snapshotQuery.error) === 404
          ? host.mode === "history"
            ? "not-on-page"
            : "not-ready"
          : "error";
    } else if (snapshotQuery.isFetching || snapshotQuery.isLoading) {
      snapshotState = "loading";
    }
  }

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
    void snapshotQuery.refetch?.();
  }, [snapshotQuery]);

  const replaceWithEmpty = useCallback(() => {
    const origin = liveBlockOrigin(editor);
    const newId = uuid7();
    if (blockId) origin.copies.delete(blockId);
    origin.created.add(newId);
    updateRef.current(newIdAttrs(newId));
  }, [editor, blockId]);

  return {
    status,
    blockId,
    pageId,
    retry,
    replaceWithEmpty,
    snapshot: snapshotQuery.data?.snapshot,
    snapshotUpdatedAt: snapshotQuery.data?.updatedAt,
    snapshotState,
  };
}
