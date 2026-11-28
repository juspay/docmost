import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MessageType } from "@hocuspocus/provider";
import { messageYjsSyncStep2 } from "y-protocols/sync";
import { PageCollabSocket } from "@/features/editor/collab-socket";
import { deleteLocalPageData } from "@/lib/local-page-data";
import { PageDraftCache } from "@/features/editor/hooks/page-draft-cache";
import {
  acquireBlockProvider,
  closeBlockStorageForTests,
  discardStoredBlock,
  discardStoredBlocksOfPage,
  getBlockSaveState,
} from "./block-provider-registry";

const pageAnswer = vi.hoisted(() => ({
  get: vi.fn(
    async (): Promise<any> => ({
      permissions: { canEdit: true },
      deletedAt: null,
    }),
  ),
}));
vi.mock("@/features/page/services/page-service", () => ({
  getPageById: pageAnswer.get,
}));
vi.mock("@/lib/config.ts", () => ({
  getCollaborationUrl: () => "ws://localhost",
}));
const notices = vi.hoisted(() => ({ show: vi.fn(), hide: vi.fn() }));
vi.mock("@mantine/notifications", () => ({ notifications: notices }));

let block: string;
const sockets: PageCollabSocket[] = [];

function installLocks() {
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      async request(name: string, _o: unknown, cb: (lock: unknown) => any) {
        if (held.has(name)) return cb(null);
        held.add(name);
        try {
          await cb({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  });
}

/** one browser tab: its own socket and registry */
const PAGE = "page-1";
async function tab(
  user = "u1",
  canEdit = true,
  given?: PageCollabSocket,
  pageId = PAGE,
) {
  const socket =
    given ??
    new PageCollabSocket({ url: "ws://localhost", autoConnect: false });
  if (!given) sockets.push(socket);
  const handle = acquireBlockProvider({
    socket,
    name: block,
    token: "t",
    canEdit: () => canEdit,
    userId: user,
    pageId,
  });
  await handle.entry.ready;
  const entry: any = handle.entry;
  return { socket, handle, entry, doc: entry.doc as Y.Doc };
}

/** the tab is closed: its storage locks go, nothing is discarded */
function closeTab(t: { socket: PageCollabSocket }) {
  closeBlockStorageForTests(t.socket);
}

const items = (doc: Y.Doc) => [...doc.getMap("m").keys()].sort();
const warns = () => {
  const ev = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
};
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  pageAnswer.get.mockReset();
  pageAnswer.get.mockResolvedValue({
    permissions: { canEdit: false },
    deletedAt: null,
  });
  block = `block.${crypto.randomUUID()}`;
  installLocks();
  notices.show.mockClear();
});
afterEach(async () => {
  for (const s of sockets.splice(0)) closeBlockStorageForTests(s);
  Reflect.deleteProperty(navigator, "locks");
  vi.restoreAllMocks();
  await deleteLocalPageData();
});

describe("block edits kept on the device", () => {
  it("an edit made offline survives the tab closing and is there in the next tab (req 1, 11)", async () => {
    const a = await tab();
    a.doc.getMap("m").set("drawn", 1);
    await settle();
    a.handle.release(); // the 30 s out-of-view release keeps the copy
    closeTab(a);
    const b = await tab();
    expect(items(b.doc)).toEqual(["drawn"]);
    // still unsent: it goes out with the next handshake
    expect(b.entry.storage.hasPending).toBe(true);
  });

  it("acknowledged edits are not replayed again", async () => {
    const a = await tab();
    a.doc.getMap("m").set("x", 1);
    await settle();
    a.entry.storage.sent(messageYjsSyncStep2, true);
    a.entry.storage.incoming(
      { readVarUint: () => 1 } as any,
      MessageType.SyncStatus,
    );
    await settle();
    closeTab(a);
    const b = await tab();
    expect(b.entry.storage.hasPending).toBe(false);
  });

  it("another account in the same browser never sees it (req 2)", async () => {
    const a = await tab("u1");
    a.doc.getMap("m").set("mine", 1);
    await settle();
    closeTab(a);
    const b = await tab("u2");
    expect(items(b.doc)).toEqual([]);
  });

  it("sign-out removes it (req 3)", async () => {
    const a = await tab();
    a.doc.getMap("m").set("mine", 1);
    await settle();
    closeTab(a);
    await deleteLocalPageData();
    const b = await tab();
    expect(items(b.doc)).toEqual([]);
  });

  it("a reader writes no local copy (req 4)", async () => {
    const a = await tab("u1", false);
    expect(a.entry.storage).toBeUndefined();
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names.some((n) => n?.includes(block))).toBe(false);
  });

  it("a refusal for good discards the copy instead of replaying it later (req 5)", async () => {
    const a = await tab();
    a.doc.getMap("m").set("refused", 1);
    await settle();
    a.entry.provider.receiveStateless(
      JSON.stringify({ type: "page.permissions", access: "read" }),
    );
    await settle();
    closeTab(a);
    const b = await tab();
    expect(items(b.doc)).toEqual([]);
    expect(notices.show).toHaveBeenCalledTimes(1);
  });

  it("storage that cannot be opened: the block works in memory and warns before closing (req 6, 7)", async () => {
    vi.spyOn(IDBFactory.prototype, "open").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const a = await tab();
    expect(a.entry.storage).toBeUndefined();
    a.doc.getMap("m").set("k", 1);
    expect(warns()).toBe(true);
    expect(getBlockSaveState(block, "u1").dirty).toBe(true);
  });

  it("edits stored on the device do not raise the leave-page warning (req 7)", async () => {
    const a = await tab();
    a.doc.getMap("m").set("k", 1);
    await settle();
    expect(warns()).toBe(false);
    // and the block still does not claim to be saved
    expect(getBlockSaveState(block, "u1").dirty).toBe(true);
  });

  it("two tabs editing offline: both edits come back, once each (req 9)", async () => {
    const a = await tab();
    const b = await tab();
    a.doc.getMap("m").set("from-a", 1);
    b.doc.getMap("m").set("from-b", 1);
    a.doc.getText("t").insert(0, "A");
    b.doc.getText("t").insert(0, "B");
    await settle();
    closeTab(a);
    closeTab(b);
    const c = await tab();
    expect(items(c.doc)).toEqual(["from-a", "from-b"]);
    expect(c.doc.getText("t").toString().length).toBe(2);
  });

  it("a replayed copy merges with what others changed meanwhile, without duplicates (req 10)", async () => {
    const server = new Y.Doc();
    server.getMap("m").set("base", 1);
    const a = await tab();
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(server), a.entry.provider);
    a.entry.storage.incoming(
      {
        readVarUint: () => messageYjsSyncStep2,
        readVarUint8Array: () => Y.encodeStateAsUpdate(server),
      } as any,
      MessageType.Sync,
    );
    a.doc.getMap("m").set("offline", 1);
    await settle();
    closeTab(a);
    // meanwhile someone else edits the same block on the server
    server.getMap("m").set("other", 1);
    const b = await tab();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(server), b.entry.provider);
    expect(items(b.doc)).toEqual(["base", "offline", "other"]);
    // what the replay sends to the server: only the offline edit
    const diff = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(server));
    Y.applyUpdate(server, diff);
    expect(items(server)).toEqual(["base", "offline", "other"]);
    expect(server.getMap("m").size).toBe(3);
  });
});

/** a real SyncStatus or Sync message for this block, as the server sends it */
function wire(...parts: number[][]) {
  const name = [...new TextEncoder().encode(block)];
  return new Uint8Array([name.length, ...name, ...parts.flat()]);
}
function varBytes(bytes: Uint8Array) {
  return [bytes.length, ...bytes];
}

describe("fix round 1", () => {
  it("re-acquiring a block whose confirmed state is on the device leaves it clean and releasable (finding 1)", async () => {
    const a = await tab();
    const server = new Y.Doc();
    server.getMap("m").set("base", 1);
    // the server's state arrives and is confirmed on disk
    a.entry.provider.onMessage({
      data: wire([0, 1], varBytes(Y.encodeStateAsUpdate(server))),
    });
    await settle();
    expect(getBlockSaveState(block, "u1").dirty).toBe(false);
    a.handle.release();
    // offline, out of view: destroyed; then scrolled back
    const b = await tab("u1", true, a.socket);
    expect(items(b.doc)).toEqual(["base"]);
    await settle();
    expect(getBlockSaveState(block, "u1")).toMatchObject({
      dirty: false,
      unsaved: false,
    });
    expect(warns()).toBe(false);
    const destroy = vi.spyOn(b.entry.provider, "destroy");
    b.handle.release();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("restored drafts from a closed tab are unsent but stored: no leave-page warning (finding 1)", async () => {
    const a = await tab();
    a.doc.getMap("m").set("offline", 1);
    await settle();
    closeTab(a);
    const b = await tab();
    expect(getBlockSaveState(b.entry.name, "u1")).toMatchObject({
      dirty: true,
      storedLocally: true,
    });
    expect(warns()).toBe(false);
  });

  it("an acknowledgement parsed from the wire removes the acknowledged draft (finding 8)", async () => {
    const a = await tab();
    a.doc.getMap("m").set("x", 1);
    await settle();
    a.entry.storage.sent(messageYjsSyncStep2, true);
    // SyncStatus(1): applied
    a.entry.provider.onMessage({ data: wire([8, 1]) });
    await settle();
    closeTab(a);
    const b = await tab();
    expect(b.entry.storage.hasPending).toBe(false);
  });

  it("a refusal for good deletes drafts inherited from a closed tab too; nothing replays later (finding 2)", async () => {
    const a = await tab();
    a.doc.getMap("m").set("from-closed-tab", 1);
    await settle();
    closeTab(a);
    const b = await tab();
    expect(items(b.doc)).toEqual(["from-closed-tab"]);
    b.entry.provider.receiveStateless(
      JSON.stringify({ type: "page.permissions", access: "read" }),
    );
    await settle();
    closeTab(b);
    // access comes back weeks later
    const c = await tab();
    await c.entry.storage.authenticated(true);
    await settle();
    expect(items(c.doc)).toEqual([]);
    expect(c.entry.storage.hasPending).toBe(false);
  });

  it("the page cache keeps an inherited draft on an ordinary discard, as before (pages unchanged)", async () => {
    const name = `page.${crypto.randomUUID()}`;
    const one = new PageDraftCache(name, "u1", () => undefined);
    await one.restore();
    one.ydoc.getMap("m").set("draft", 1);
    await settle();
    one.close();
    const two = new PageDraftCache(name, "u1", () => undefined);
    await two.restore();
    await two.discard();
    two.close();
    const three = new PageDraftCache(name, "u1", () => undefined);
    await three.restore();
    await three.authenticated(true);
    expect([...three.ydoc.getMap("m").keys()]).toEqual(["draft"]);
    three.close();
  });

  it("a definite no-access answer discards the stored copy at once, with no view open (finding 3)", async () => {
    const a = await tab();
    a.doc.getMap("m").set("offline", 1);
    await settle();
    closeTab(a);
    const removed = await discardStoredBlock(block, PAGE, "u1");
    expect(removed).toBeGreaterThan(0);
    expect(getBlockSaveState(block, "u1")).toMatchObject({ lost: true });
    const b = await tab();
    expect(items(b.doc)).toEqual([]);
  });

  it("nothing stored: a no-access answer reports nothing lost", async () => {
    expect(await discardStoredBlock(block, PAGE, "u1")).toBe(0);
    expect(getBlockSaveState(block, "u1").lost).toBe(false);
  });

  it("stored only when every outstanding edit is on disk (finding 4)", async () => {
    const a = await tab();
    a.doc.getMap("m").set("one", 1);
    a.doc.getMap("m").set("two", 1);
    expect(a.entry.unstoredDrafts).toBe(2);
    expect(warns()).toBe(true);
    await settle();
    expect(a.entry.unstoredDrafts).toBe(0);
    expect(warns()).toBe(false);
  });

  it("a restore that has not finished in time is given up, so no edit can miss the cache (finding 4)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(PageDraftCache.prototype, "restore").mockImplementation(
      () => new Promise(() => undefined),
    );
    const socket = new PageCollabSocket({
      url: "ws://localhost",
      autoConnect: false,
    });
    sockets.push(socket);
    const handle = acquireBlockProvider({
      socket,
      name: block,
      token: "t",
      canEdit: () => true,
      userId: "u1",
    });
    await vi.advanceTimersByTimeAsync(2_100);
    await handle.entry.ready;
    expect(handle.entry.storage).toBeUndefined();
    handle.entry.doc.getMap("m").set("k", 1);
    expect(warns()).toBe(true);
    vi.useRealTimers();
  });

  it("a late callback from an old closed cache does not touch a newer entry (finding 5)", async () => {
    const a = await tab();
    const oldStorage = a.entry.storage;
    a.handle.release();
    const b = await tab("u1", true, a.socket);
    b.doc.getMap("m").set("new", 1);
    expect(b.entry.unstoredDrafts).toBe(1);
    // the old cache reports late, after it was replaced
    (oldStorage as any).onWriteError();
    (oldStorage as any).onDraftStored?.();
    expect(b.entry.storageFailed).toBe(false);
    expect(b.entry.unstoredDrafts).toBe(1);
  });

  it("a different signed-in user never reuses the previous user's document (user switch)", async () => {
    const a = await tab("u1");
    a.doc.getMap("m").set("ada", 1);
    await settle();
    a.handle.release();
    const b = await tab("u2", true, a.socket);
    expect(b.doc).not.toBe(a.doc);
    expect(items(b.doc)).toEqual([]);
    b.doc.getMap("m").set("grace", 1);
    await settle();
    closeTab(b);
    // u1's stored copy is untouched by u2
    const c = await tab("u1");
    expect(items(c.doc)).toEqual(["ada"]);
  });
});

describe("fix round 2", () => {
  it("the device copy is stored under its page: another page never loads it (moved block)", async () => {
    const a = await tab("u1", true, undefined, "page-A");
    a.doc.getMap("m").set("on-A", 1);
    await settle();
    closeTab(a);
    const b = await tab("u1", true, undefined, "page-B");
    expect(items(b.doc)).toEqual([]);
    closeTab(b);
    const c = await tab("u1", true, undefined, "page-A");
    expect(items(c.doc)).toEqual(["on-A"]);
  });

  it("a refused page drops its blocks' stored copies for this user only, and says so per block", async () => {
    const other = `block.${crypto.randomUUID()}`;
    const a = await tab();
    a.doc.getMap("m").set("ada", 1);
    await settle();
    closeTab(a);
    const g = await tab("u2");
    g.doc.getMap("m").set("grace", 1);
    await settle();
    closeTab(g);
    // a block of another page keeps its copy
    const saved = block;
    block = other;
    const elsewhere = await tab("u1", true, undefined, "page-2");
    elsewhere.doc.getMap("m").set("kept", 1);
    await settle();
    closeTab(elsewhere);
    block = saved;

    expect(await discardStoredBlocksOfPage(PAGE, "u1")).toBe(1);
    expect(getBlockSaveState(block, "u1").lost).toBe(true);
    // D2: the notice is per user
    expect(getBlockSaveState(block, "u2").lost).toBe(false);
    expect(items((await tab("u1")).doc)).toEqual([]);
    expect(items((await tab("u2")).doc)).toEqual(["grace"]);
    block = other;
    expect(items((await tab("u1", true, undefined, "page-2")).doc)).toEqual([
      "kept",
    ]);
    block = saved;
  });

  it("without indexedDB.databases nothing is dropped, as for pages", async () => {
    const a = await tab();
    a.doc.getMap("m").set("ada", 1);
    await settle();
    closeTab(a);
    const original = indexedDB.databases;
    (indexedDB as any).databases = undefined;
    try {
      expect(await discardStoredBlocksOfPage(PAGE, "u1")).toBe(0);
    } finally {
      (indexedDB as any).databases = original;
    }
    expect(items((await tab()).doc)).toEqual(["ada"]);
  });

  it("drafts claimed after the listener is attached count as stored, never as unstored for good (D1)", async () => {
    const a = await tab();
    a.doc.getMap("m").set("from-a", 1);
    await settle();
    // B opens while A still holds its drafts, then A closes
    const b = await tab();
    expect(items(b.doc)).toEqual([]);
    closeTab(a);
    await b.entry.storage.authenticated(true);
    await settle();
    expect(items(b.doc)).toEqual(["from-a"]);
    expect(b.entry.unstoredDrafts).toBe(0);
    expect(getBlockSaveState(block, "u1")).toMatchObject({
      dirty: true,
      storedLocally: true,
    });
    expect(warns()).toBe(false);
  });
});

describe("fix round 3: a read-only answer on the live connection", () => {
  const trashed = { permissions: { canEdit: false }, deletedAt: "2026-11-27" };
  const cannotEdit = { permissions: { canEdit: false }, deletedAt: null };

  async function offlineEdit() {
    const a = await tab();
    a.doc.getMap("m").set("offline", 1);
    await settle();
    return a;
  }

  it("read-only scope on a trashed page keeps the drafts; a later writable open replays them", async () => {
    pageAnswer.get.mockResolvedValue(trashed);
    const a = await offlineEdit();
    a.entry.provider.authenticatedHandler("readonly");
    await settle();
    expect(getBlockSaveState(block, "u1")).toMatchObject({
      keptOnDevice: true,
      lost: false,
      unsaved: false,
    });
    expect(warns()).toBe(false);
    expect(notices.show).not.toHaveBeenCalled();
    const destroy = vi.spyOn(a.entry.provider, "destroy");
    a.handle.release();
    expect(destroy).toHaveBeenCalledTimes(1);
    // still said after the provider is gone (the read-only view stays)
    expect(getBlockSaveState(block, "u1").keptOnDevice).toBe(true);
    expect(getBlockSaveState(block, "u2").keptOnDevice).toBe(false);
    closeTab(a);
    // the page is restored: write access again
    const b = await tab();
    expect(items(b.doc)).toEqual(["offline"]);
    expect(b.entry.storage.hasPending).toBe(true);
  });

  it("read-only scope with a fresh 'cannot edit, not in the trash' answer deletes them", async () => {
    pageAnswer.get.mockResolvedValue(cannotEdit);
    const a = await offlineEdit();
    a.entry.provider.authenticatedHandler("readonly");
    await settle();
    await settle();
    expect(pageAnswer.get).toHaveBeenCalledWith({ pageId: PAGE });
    expect(getBlockSaveState(block, "u1")).toMatchObject({
      lost: true,
      keptOnDevice: false,
    });
    closeTab(a);
    expect(items((await tab()).doc)).toEqual([]);
  });

  it("a failed page request keeps them", async () => {
    pageAnswer.get.mockRejectedValue(new Error("offline"));
    const a = await offlineEdit();
    a.entry.provider.authenticatedHandler("readonly");
    await settle();
    expect(getBlockSaveState(block, "u1").keptOnDevice).toBe(true);
    closeTab(a);
    expect(items((await tab()).doc)).toEqual(["offline"]);
  });

  it("a page.permissions read on an open block: kept for the trash, deleted for no edit right", async () => {
    pageAnswer.get.mockResolvedValue(trashed);
    const a = await offlineEdit();
    a.entry.provider.receiveStateless(
      JSON.stringify({ type: "page.permissions", access: "read" }),
    );
    await settle();
    expect(getBlockSaveState(block, "u1").keptOnDevice).toBe(true);
    closeTab(a);
    expect(items((await tab()).doc)).toEqual(["offline"]);

    block = `block.${crypto.randomUUID()}`;
    pageAnswer.get.mockResolvedValue(cannotEdit);
    const c = await offlineEdit();
    c.entry.provider.receiveStateless(
      JSON.stringify({ type: "page.permissions", access: "read" }),
    );
    await settle();
    await settle();
    expect(getBlockSaveState(block, "u1").lost).toBe(true);
    closeTab(c);
    expect(items((await tab()).doc)).toEqual([]);
  });

  it("without a device copy, today's behaviour stays: the edits cannot be saved and the user is told", async () => {
    vi.spyOn(IDBFactory.prototype, "open").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const a = await tab();
    a.doc.getMap("m").set("k", 1);
    a.entry.provider.authenticatedHandler("readonly");
    expect(getBlockSaveState(block, "u1")).toMatchObject({
      lost: true,
      keptOnDevice: false,
    });
    expect(notices.show).toHaveBeenCalledTimes(1);
  });

  it("discardStoredBlock leaves an open entry of another page alone (R1)", async () => {
    const a = await tab("u1", true, undefined, "page-Q");
    a.doc.getMap("m").set("q", 1);
    await settle();
    await discardStoredBlock(block, "page-P", "u1");
    expect(a.entry.noAccess).toBe(false);
    closeTab(a);
    expect(items((await tab("u1", true, undefined, "page-Q")).doc)).toEqual([
      "q",
    ]);
  });
});
