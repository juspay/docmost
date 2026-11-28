import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as Y from "yjs";
import type { LiveBlockKind, LiveBlockSnapshot } from "@docmost/live-blocks";

export type LiveBlockStatus =
  | "ensuring"
  | "ready"
  | "read-only"
  | "foreign"
  | "no-access"
  | "unavailable"
  | "error";

export type SnapshotState =
  | "idle"
  | "loading"
  | "ready"
  | "not-ready"
  | "not-on-page"
  | "error";

export type BlockPeer = {
  clientId: number;
  user: { id: string; name: string; color: string };
};

export type LiveBlockRoomContext = {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  synced: boolean;
  readOnly: boolean;
  peers: BlockPeer[];
  /** A view registers its pending-write flush; returns the unregister. */
  registerFlush(fn: () => void): () => void;
  /** Work that will still write to the document (an upload); the room outlives the view until it settles. */
  keepAlive(work: Promise<unknown>): void;
};

export type LiveBlockRenderContext = LiveBlockRoomContext & {
  blockId: string;
  pageId: string;
  opened: boolean;
};

export type LiveBlockSnapshotResponse = {
  kind: LiveBlockKind;
  snapshot: LiveBlockSnapshot;
  updatedAt: string;
};
