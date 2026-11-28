import {
  HocuspocusProvider,
  MessageType,
  WebSocketStatus,
} from "@hocuspocus/provider";
import * as Y from "yjs";
import type { PageCollabSocket } from "@/features/editor/collab-socket";
import {
  PageDraftCache,
  RESTORE,
} from "@/features/editor/hooks/page-draft-cache";
import { getPageById } from "@/features/page/services/page-service";
import { notifications } from "@mantine/notifications";
import i18n from "i18next";

/**
 * One provider per block document on a socket. Hocuspocus refuses a second
 * provider with the same name, and a late destroy of an old one would remove
 * the newer one's entry, so every view of a block (inline, full-window, a
 * remount) shares this one.
 *
 * An editor's block document is also kept on the device with the page draft
 * cache (IndexedDB per block and per user, drafts kept until the server
 * acknowledges them), so offline edits survive a closed tab. The provider is
 * never destroyed while it holds edits the server has not acknowledged.
 */
export type BlockProviderEntry = {
  name: string;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  flushes: Set<() => void>;
  refs: number;
  /** work that will still write to the document (an upload); the provider waits for it */
  keepAlive(work: Promise<unknown>): void;
  /** settles once the device copy (if any) is loaded and the provider is attached */
  ready: Promise<void>;
  /** the device copy, for an editor whose browser storage works; set from the start, cleared if it fails */
  storage?: PageDraftCache;
};

export type BlockSaveState = {
  /** local edits the server has not acknowledged */
  dirty: boolean;
  /** the socket dropped after this block had been online */
  offline: boolean;
  authFailed: boolean;
  /** the server refused this block for good (8 refusals, or read-only access) */
  noAccess: boolean;
  /** stopped after refusals: read-only, changes are not being saved, "Try again" restarts */
  notSaving: boolean;
  /** show "Not saved yet": edits waiting more than 2 s, the socket down, or refused */
  unsaved: boolean;
  /** unsent edits are safely stored on this device (still not saved on the server) */
  storedLocally: boolean;
  /** edits were refused for good and the device copy was discarded */
  lost: boolean;
  /** the connection turned read-only; unsent edits are kept on this device, not sent */
  keptOnDevice: boolean;
};

const SAVED: BlockSaveState = {
  dirty: false,
  offline: false,
  authFailed: false,
  noAccess: false,
  notSaving: false,
  unsaved: false,
  storedLocally: false,
  lost: false,
  keptOnDevice: false,
};

type Entry = BlockProviderEntry & {
  socket: PageCollabSocket;
  canEdit: Set<() => boolean>;
  /** bumped by every acquire; a drain only destroys if nothing acquired since it began */
  generation: number;
  drainGeneration: number | null;
  /** whether the last view could edit: its pending writes may still go out */
  drainCanPublish: boolean;
  unbind: () => void;
  dirty: boolean;
  /** dirty for longer than the grace period */
  dirtyLong: boolean;
  noAccess: boolean;
  /** given up after refusals (not a read-only scope): the user may try again */
  stopped: boolean;
  retry?: () => void;
  /** a stopped block is let go: say its edits are lost, then forget them */
  releaseLost?: () => void;
  /** the server answered definitely that this user may not write the block */
  refuse?: () => void;
  holds: Set<Promise<unknown>>;
  /** a device write failed: edits may exist only in this tab */
  storageFailed: boolean;
  keptOnDevice: boolean;
  /** local edits whose draft write has not committed yet */
  unstoredDrafts: number;
  userId?: string;
  pageId?: string;
  lost: boolean;
  wasOnline: boolean;
  authFailed: boolean;
  state: BlockSaveState;
  /** the latest way to get a fresh collab token, from the newest view */
  refreshToken?: () => Promise<string | undefined>;
  dispose: () => void;
};

const AUTH_FIRST_RETRY_MS = 1_000;
const AUTH_MAX_RETRY_MS = 60_000;
const AUTH_MAX_REFUSALS = 8;
/** an edit acknowledged within this is not worth a "Not saved yet" */
const UNSAVED_GRACE_MS = 2_000;
/** give up on the device copy if storage does not open in this time */
const LOCAL_OPEN_TIMEOUT = 2_000;

/**
 * The device copy's database is `page.<pageId>.block.<blockId>.user.<userId>`
 * (PageDraftCache adds "page." and ".user."): sign-out clears every "page."
 * database, a page's blocks can be listed, and a block moved to another page
 * never loads the copy kept under its old page.
 */
function storageKey(pageId: string, name: string) {
  return `${pageId}.${name}`;
}

const lostKey = (name: string, userId: string | undefined) =>
  `${name}\u0000${userId ?? ""}`;

/** every outstanding local edit is committed to the device (not merely queued) */
function storedSafely(entry: Entry): boolean {
  return (
    Boolean(entry.storage?.opened) &&
    !entry.storageFailed &&
    entry.unstoredDrafts === 0
  );
}

/** 1 s doubling to 60 s, with ±20 % jitter so tabs do not retry together */
function backoff(attempt: number): number {
  const base = Math.min(AUTH_MAX_RETRY_MS, AUTH_FIRST_RETRY_MS * 2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

// the browser's own "leave site?" prompt while any block holds unsaved edits
const dirtyEntries = new Set<object>();
const onBeforeUnload = (event: BeforeUnloadEvent) => {
  if (dirtyEntries.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
};
function trackDirty(entry: object, dirty: boolean) {
  const had = dirtyEntries.size > 0;
  if (dirty) dirtyEntries.add(entry);
  else dirtyEntries.delete(entry);
  const has = dirtyEntries.size > 0;
  if (typeof window === "undefined" || had === has) return;
  if (has) window.addEventListener("beforeunload", onBeforeUnload);
  else window.removeEventListener("beforeunload", onBeforeUnload);
}

const registries = new WeakMap<object, Map<string, Entry>>();
// by document name, for views (the frame header) that are not rooms
const byName = new Map<string, Entry>();
const nameListeners = new Map<string, Set<() => void>>();

function registryOf(socket: object): Map<string, Entry> {
  let registry = registries.get(socket);
  if (!registry) registries.set(socket, (registry = new Map()));
  return registry;
}

function notify(name: string) {
  nameListeners.get(name)?.forEach((listener) => listener());
}

function online(entry: Entry): boolean {
  return (
    (entry.socket as any).status === WebSocketStatus.Connected &&
    entry.provider.isAuthenticated
  );
}

function refreshState(entry: Entry) {
  // the browser warns only for edits that would be lost with the tab
  trackDirty(entry, entry.dirty && !storedSafely(entry));
  const offline = entry.wasOnline && !online(entry);
  const next: BlockSaveState = {
    dirty: entry.dirty,
    offline,
    authFailed: entry.authFailed,
    noAccess: entry.noAccess,
    notSaving: entry.stopped,
    storedLocally: entry.dirty && storedSafely(entry),
    lost: entry.lost,
    keptOnDevice: entry.keptOnDevice,
    unsaved:
      !entry.noAccess && (entry.dirtyLong || offline || entry.authFailed),
  };
  const prev = entry.state;
  if (
    prev.dirty !== next.dirty ||
    prev.offline !== next.offline ||
    prev.authFailed !== next.authFailed ||
    prev.noAccess !== next.noAccess ||
    prev.notSaving !== next.notSaving ||
    prev.storedLocally !== next.storedLocally ||
    prev.lost !== next.lost ||
    prev.keptOnDevice !== next.keptOnDevice ||
    prev.unsaved !== next.unsaved
  ) {
    entry.state = next;
    notify(entry.name);
  }
}

export function subscribeBlockSaveState(name: string, listener: () => void) {
  let listeners = nameListeners.get(name);
  if (!listeners) nameListeners.set(name, (listeners = new Set()));
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) nameListeners.delete(name);
  };
}

/** The block's local document while this tab holds one (open, or kept with unsaved edits). */
export function getRetainedDoc(name: string): Y.Doc | null {
  return byName.get(name)?.doc ?? null;
}

/** Closes every device copy held for a socket, as closing the tab would. Tests only. */
export function closeBlockStorageForTests(socket: object) {
  for (const entry of registries.get(socket)?.values() ?? []) {
    entry.storage?.close();
    trackDirty(entry, false);
    if (byName.get(entry.name) === entry) byName.delete(entry.name);
  }
  registries.delete(socket);
}

/**
 * A definite answer that this user may not write the block (403 or 404 from
 * the server's edit check): every stored draft for it is deleted at once,
 * whether or not a view is open. Resolves to the number of drafts removed.
 */
export async function discardStoredBlock(
  name: string,
  pageId: string,
  userId: string,
): Promise<number> {
  const open = byName.get(name);
  if (
    open &&
    open.userId === userId &&
    open.pageId === pageId &&
    open.storage
  ) {
    const had = open.storage.hasPending ? 1 : 0;
    open.refuse?.();
    if (had) lostNames.add(lostKey(name, userId));
    return had;
  }
  return dropDatabase(storageKey(pageId, name), name, userId);
}

/** Opens a stored copy, deletes every draft in it; resolves to 1 if there were any. */
async function dropDatabase(
  key: string,
  name: string,
  userId: string,
): Promise<number> {
  let cache: PageDraftCache | undefined;
  try {
    cache = new PageDraftCache(key, userId, () => undefined);
    await cache.restore();
    const count = cache.hasPending ? 1 : 0;
    await cache.discard(false, true);
    if (count) {
      lostNames.add(lostKey(name, userId));
      notify(name);
    }
    return count;
  } catch {
    // storage unavailable: nothing was stored
    return 0;
  } finally {
    cache?.close();
  }
}

/** Whether this user keeps any stored copy (a database) for the block on that page. */
export async function hasStoredBlock(
  name: string,
  pageId: string,
  userId: string,
): Promise<boolean> {
  try {
    const list = await indexedDB.databases?.();
    // without the list, assume there may be one (the discard is cheap)
    if (!list) return true;
    const db = `page.${storageKey(pageId, name)}.user.${userId}`;
    return list.some((d) => d.name === db);
  } catch {
    return false;
  }
}

/**
 * The page itself was refused for good (the app server's 403 or 404, where
 * the page editor drops its own cache): every block of that page drops its
 * stored copy for this user. Without indexedDB.databases() nothing is
 * dropped, as for pages. Resolves to the number of blocks that had drafts.
 */
export async function discardStoredBlocksOfPage(
  pageId: string,
  userId: string,
): Promise<number> {
  let names: string[] = [];
  try {
    const list = await indexedDB.databases?.();
    if (!list) return 0;
    const prefix = `page.${pageId}.block.`;
    const suffix = `.user.${userId}`;
    names = list
      .map((d) => d.name ?? "")
      .filter((n) => n.startsWith(prefix) && n.endsWith(suffix))
      .map((n) => n.slice("page.".length + pageId.length + 1, -suffix.length));
  } catch {
    return 0;
  }
  let dropped = 0;
  for (const name of names) {
    dropped += await discardStoredBlock(name, pageId, userId);
  }
  return dropped;
}

/** "Try again" for a block that stopped after refusals: restarts the back-off. */
export function retryBlockSave(name: string) {
  byName.get(name)?.retry?.();
}

// blocks whose edits were refused for good this session: still reported
// after their provider is gone
const lostNames = new Set<string>();
const LOST: BlockSaveState = { ...SAVED, noAccess: true, lost: true };
// blocks whose edits are kept on the device after a read-only answer
const keptNames = new Set<string>();
const KEPT: BlockSaveState = { ...SAVED, noAccess: true, keptOnDevice: true };

/** The block's save state as this user sees it (another user's loss is not theirs). */
export function getBlockSaveState(
  name: string,
  userId?: string,
): BlockSaveState {
  const open = byName.get(name);
  if (open && (userId === undefined || open.userId === userId)) {
    return open.state;
  }
  const key = lostKey(name, userId);
  if (lostNames.has(key)) return LOST;
  return keptNames.has(key) ? KEPT : SAVED;
}

export function runFlushes(entry: BlockProviderEntry) {
  for (const flush of entry.flushes) {
    try {
      flush();
    } catch {
      // one view's failure must not stop the others
    }
  }
}

function tryDestroy(registry: Map<string, Entry>, entry: Entry) {
  if (entry.refs === 0 && entry.stopped && entry.dirty) entry.releaseLost?.();
  if (
    entry.refs > 0 ||
    entry.drainGeneration !== entry.generation ||
    entry.dirty ||
    entry.holds.size > 0 ||
    registry.get(entry.name) !== entry
  ) {
    return;
  }
  registry.delete(entry.name);
  trackDirty(entry, false);
  if (byName.get(entry.name) === entry) byName.delete(entry.name);
  entry.dispose();
  entry.unbind();
  entry.provider.destroy();
  entry.doc.destroy();
  notify(entry.name);
}

function forceTeardown(registry: Map<string, Entry>, entry: Entry) {
  registry.delete(entry.name);
  trackDirty(entry, false);
  if (byName.get(entry.name) === entry) byName.delete(entry.name);
  entry.refs = 0;
  entry.dispose();
  entry.unbind();
  entry.provider.destroy();
  entry.doc.destroy();
  notify(entry.name);
}

export function acquireBlockProvider(args: {
  socket: PageCollabSocket;
  name: string;
  token: string;
  canEdit: () => boolean;
  onCreate?: (provider: HocuspocusProvider) => void;
  /** keeps the shared socket connected while the provider lives; returns the release */
  retainSocket?: () => () => void;
  /** fetches a fresh collab token after the server refused this one */
  refreshToken?: () => Promise<string | undefined>;
  /** whose device copy this is; without it nothing is stored on the device */
  userId?: string;
  /** the page the block is on; the device copy is kept under it */
  pageId?: string;
}): { entry: BlockProviderEntry; release: () => void } {
  const registry = registryOf(args.socket);
  let entry = registry.get(args.name);
  if (
    entry &&
    (entry.userId !== args.userId ||
      (args.pageId && entry.pageId && entry.pageId !== args.pageId))
  ) {
    // Another account is signed in: the previous account's document never
    // serves it. Its drafts stay on the device under its own database.
    forceTeardown(registry, entry);
    entry = undefined;
  }
  if (entry) {
    entry.refs++;
    entry.provider.configuration.token = args.token;
  } else {
    // Only an editor keeps a device copy, under this user's own database.
    // "page." databases are removed at sign-out with the page drafts.
    // callbacks act only on the entry this cache was made for (finding 5)
    let self: Entry | undefined;
    let storage: PageDraftCache | undefined;
    if (args.userId && args.pageId && args.canEdit()) {
      try {
        const cache: PageDraftCache = new PageDraftCache(
          storageKey(args.pageId, args.name),
          args.userId,
          () => {
            if (!self || self.storage !== cache) return;
            self.storageFailed = true;
            refreshState(self);
          },
          undefined,
          () => {
            if (!self || self.storage !== cache) return;
            // one call per committed draft write
            self.unstoredDrafts = Math.max(0, self.unstoredDrafts - 1);
            refreshState(self);
          },
        );
        storage = cache;
      } catch {
        storage = undefined;
      }
    }
    const doc = storage?.ydoc ?? new Y.Doc();
    const provider = new HocuspocusProvider({
      name: args.name,
      websocketProvider: args.socket,
      document: doc,
      token: args.token,
    });
    const created: Entry = {
      name: args.name,
      socket: args.socket,
      doc,
      provider,
      flushes: new Set(),
      refs: 1,
      generation: 0,
      drainGeneration: null,
      drainCanPublish: false,
      canEdit: new Set(),
      unbind: () => undefined,
      dirty: false,
      dirtyLong: false,
      noAccess: false,
      stopped: false,
      holds: new Set(),
      keepAlive: (work) => {
        created.holds.add(work);
        const settle = () => {
          created.holds.delete(work);
          tryDestroy(registry, created);
        };
        work.then(settle, settle);
      },
      storage,
      storageFailed: false,
      keptOnDevice: false,
      unstoredDrafts: 0,
      userId: args.userId,
      pageId: args.pageId,
      lost: false,
      ready: Promise.resolve(),
      wasOnline: false,
      authFailed: false,
      state: SAVED,
      dispose: () => undefined,
    };
    let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
    const setDirty = (dirty: boolean) => {
      created.dirty = dirty;
      if (!dirty) {
        created.dirtyLong = false;
        if (dirtyTimer) clearTimeout(dirtyTimer);
        dirtyTimer = null;
      } else if (!dirtyTimer && !created.dirtyLong) {
        dirtyTimer = setTimeout(() => {
          dirtyTimer = null;
          created.dirtyLong = created.dirty;
          refreshState(created);
        }, UNSAVED_GRACE_MS);
      }
    };
    let warned = false;
    const warnLost = (reason: "refused" | "readonly") => {
      if (warned) return;
      warned = true;
      notifications.show({
        id: `block-not-saved-${created.name}`,
        color: "red",
        message:
          reason === "readonly"
            ? i18n.t(
                "Your last changes to a block could not be saved: you can no longer edit it.",
              )
            : i18n.t(
                "Your last changes to a block could not be saved: access to it was refused.",
              ),
      });
    };
    // Read-only access: edits the server will never take are dropped with one
    // notice and the provider goes. A stop after refusals keeps the block
    // read-only with its edits (and the leave-page warning) until the user
    // tries again or the last view goes, which tells them the edits are lost.
    // "readonly": the live connection turned read-only (scope, page.permissions
    // read, a rejected update). The collaboration server answers a page in the
    // trash the same way as a removed edit right, so stored edits are KEPT on
    // the device and only a fresh page answer decides: cannot edit and not in
    // the trash deletes them; anything else keeps them for a later writable
    // open. "final": a coded refusal from ensure; they go at once.
    const giveUp = (reason: "refused" | "readonly" | "final") => {
      if (reason === "readonly" && created.keptOnDevice) return;
      created.noAccess = true;
      const kept = created.storage;
      const hasCopy =
        reason === "readonly" &&
        !!kept?.opened &&
        !created.storageFailed &&
        (created.dirty || kept.hasPending);
      if (hasCopy && kept) {
        // stop sending; the drafts stay on disk and nothing pins the tab
        created.storage = undefined;
        created.keptOnDevice = true;
        keptNames.add(lostKey(created.name, created.userId));
        kept.close();
        setDirty(false);
        refreshState(created);
        tryDestroy(registry, created);
        void checkKeptCopy();
        return;
      }
      if (reason !== "refused") {
        if (created.dirty) {
          warnLost("readonly");
          created.lost = true;
          lostNames.add(lostKey(created.name, created.userId));
        }
        discardStorage();
        setDirty(false);
      } else {
        created.stopped = true;
      }
      refreshState(created);
      tryDestroy(registry, created);
    };
    // the same fresh check as a read-only open (use-live-block): only a server
    // answer that this user cannot edit a page that is not in the trash
    const checkKeptCopy = async () => {
      const { pageId, userId } = created;
      if (!pageId || !userId) return;
      let page: { permissions?: { canEdit?: boolean }; deletedAt?: unknown };
      try {
        page = await getPageById({ pageId });
      } catch {
        return; // no answer: keep
      }
      if (page?.permissions?.canEdit !== false || page.deletedAt) return;
      const dropped = await dropDatabase(
        storageKey(pageId, created.name),
        created.name,
        userId,
      );
      created.keptOnDevice = false;
      keptNames.delete(lostKey(created.name, userId));
      notify(created.name);
      if (dropped) {
        lostNames.add(lostKey(created.name, userId));
        warnLost("readonly");
        created.lost = true;
      }
      refreshState(created);
    };
    // a coded final refusal or a refused page: give up for good and delete
    // the stored copy now, even while the block is open (I2)
    created.refuse = () => giveUp("final");
    created.releaseLost = () => {
      if (created.stopped && created.dirty) {
        warnLost("refused");
        created.lost = true;
        lostNames.add(lostKey(created.name, created.userId));
      }
      discardStorage();
      setDirty(false);
    };
    // Refused for good: every stored draft for this block and user goes,
    // including drafts inherited from a closed tab, so nothing is retried
    // forever or merged in silently when access returns (stricter than pages).
    const discardStorage = () => {
      const kept = created.storage;
      if (!kept) return;
      created.storage = undefined;
      void kept
        .discard(false, true)
        .catch(() => undefined)
        .finally(() => kept.close());
    };
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      // updates the provider applies came from the server
      if (origin === provider) return;
      // drafts the cache claims later (another tab closed) are already on
      // disk: unsent, but nothing to wait for (D1)
      if (origin === RESTORE) {
        setDirty(true);
        refreshState(created);
        notify(created.name);
        return;
      }
      // the cache writes a draft for this edit; it counts until committed
      if (created.storage?.opened) created.unstoredDrafts++;
      setDirty(true);
      refreshState(created);
      notify(created.name);
    };
    const onUnsynced = () => {
      if (!provider.hasUnsyncedChanges && online(created)) setDirty(false);
      refreshState(created);
      tryDestroy(registry, created);
    };
    let refusals = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;
    const onAuthenticated = ({ scope }: { scope?: string } = {}) => {
      void created.storage
        ?.authenticated(scope === "read-write")
        .catch(() => undefined);
      created.wasOnline = true;
      created.authFailed = false;
      created.stopped = false;
      refusals = 0;
      if (scope === "readonly") {
        giveUp("readonly");
        return;
      }
      created.noAccess = false;
      created.keptOnDevice = false;
      keptNames.delete(lostKey(created.name, created.userId));
      refreshState(created);
    };
    const onConnection = () => refreshState(created);
    const onClose = () => {
      created.storage?.disconnected();
      refreshState(created);
    };
    // An expired token: the page rebuilds its own provider, this one must
    // re-authenticate itself. Every refusal waits longer; after 8 in a row the
    // block stops until the tab is shown again or the network comes back.
    const reauthenticate = async () => {
      retry = null;
      if (destroyed || !created.authFailed || created.noAccess) return;
      try {
        const token = await created.refreshToken?.();
        if (destroyed) return;
        if (!token) throw new Error("no token");
        provider.configuration.token = token;
        await provider.sendToken();
        provider.startSync();
      } catch (err) {
        // signed out: no point asking again
        if ((err as { signedOut?: boolean })?.signedOut) giveUp("refused");
        // the token endpoint failed: not a refusal, try again at the ceiling
        else if (!destroyed && !retry)
          retry = setTimeout(reauthenticate, backoff(30));
      }
    };
    const onRefused = () => {
      if (destroyed || created.noAccess) return;
      refusals++;
      if (refusals >= AUTH_MAX_REFUSALS) {
        giveUp("refused");
        return;
      }
      // the first retry follows the immediate fetch after 1 s, then 2 s, 4 s …
      if (!retry) retry = setTimeout(reauthenticate, backoff(refusals - 2));
    };
    const onAuthenticationFailed = () => {
      created.authFailed = true;
      refreshState(created);
      if (refusals === 0 && !retry) {
        // the first refusal: fetch a fresh token at once (it may have expired)
        refusals = 1;
        void reauthenticate();
      } else onRefused();
    };
    const restart = () => {
      if (destroyed || !created.stopped) return;
      created.noAccess = false;
      created.stopped = false;
      // the attempt now is the first of a fresh series: 1 s, 2 s, 4 s …
      refusals = 1;
      refreshState(created);
      if (!retry) retry = setTimeout(reauthenticate, 0);
    };
    created.retry = restart;
    const wake = () => {
      if (destroyed || !created.stopped || !created.authFailed) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      restart();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", wake);
      document.addEventListener("visibilitychange", wake);
    }
    provider.on("unsyncedChanges", onUnsynced);
    provider.on("authenticated", onAuthenticated);
    provider.on("close", onClose);
    provider.on("status", onConnection);
    provider.on("authenticationFailed", onAuthenticationFailed);
    const onStateless = ({ payload }: { payload: string }) => {
      try {
        const message = JSON.parse(payload);
        if (
          message?.type === "page.permissions" &&
          (message.access === "read" || message.access === "none")
        ) {
          giveUp("readonly");
        }
      } catch {
        // not ours
      }
    };
    // what the server confirmed or acknowledged moves out of the device drafts
    const onStorageMessage = ({ message }: { message: any }) => {
      const kept = created.storage;
      if (!kept || typeof message?.readVarString !== "function") return;
      try {
        message.readVarString();
        const type = message.readVarUint();
        if (type === MessageType.SyncStatus && message.readVarUint() === 0) {
          return; // a refusal: handled below
        }
        kept.incoming(message, type);
      } catch {
        // not readable: ignore
      }
    };
    provider.on("message", onStorageMessage);
    // a SyncStatus answer of "not applied": the server now takes no edits from us
    const onMessage = ({ message }: { message: any }) => {
      try {
        const bytes: Uint8Array = message?.decoder?.arr;
        if (!bytes) return;
        const nameLength = bytes[0];
        if (bytes[1 + nameLength] === 8 && bytes[2 + nameLength] === 0) {
          giveUp("readonly");
        }
      } catch {
        // not readable: ignore
      }
    };
    provider.on("stateless", onStateless);
    provider.on("message", onMessage);
    const releaseSocket = args.retainSocket?.() ?? (() => undefined);
    created.dispose = () => {
      destroyed = true;
      if (retry) clearTimeout(retry);
      if (dirtyTimer) clearTimeout(dirtyTimer);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", wake);
      }
      doc.off("update", onUpdate);
      // drafts stay on disk; only this tab lets go of them
      created.storage?.close();
      releaseSocket();
    };
    // without this the socket drops every update this room sends
    created.unbind = args.socket.bindRoom(
      provider,
      () =>
        created.refs > 0
          ? [...created.canEdit].some((canEdit) => canEdit())
          : created.drainCanPublish,
      storage,
    );
    // The device copy is loaded before the provider joins, so the first
    // handshake carries it. Storage that fails or hangs: the block works in
    // memory only, exactly as before.
    const attach = () => {
      if (!destroyed) provider.attach();
    };
    if (storage) {
      const kept = storage;
      created.ready = new Promise<void>((resolve) => {
        let done = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (!ok) {
            kept.close();
            if (created.storage === kept) created.storage = undefined;
          }
          // what the restore applied is not an edit: drafts restored from disk
          // are unsent but already stored; confirmed state is neither
          if (created.storage?.hasPending) setDirty(true);
          if (!destroyed) doc.on("update", onUpdate);
          refreshState(created);
          attach();
          resolve();
        };
        // a restore still running after the timeout is given up: the cache
        // would miss edits made before it listens, so the block runs in memory
        const timer = setTimeout(() => finish(false), LOCAL_OPEN_TIMEOUT);
        kept.restore().then(
          () => finish(true),
          () => finish(false),
        );
      });
    } else {
      doc.on("update", onUpdate);
      attach();
    }
    self = created;
    args.onCreate?.(provider);
    registry.set(args.name, created);
    byName.set(args.name, created);
    entry = created;
  }
  const current = entry;
  if (args.refreshToken) current.refreshToken = args.refreshToken;
  current.generation++;
  current.canEdit.add(args.canEdit);

  let released = false;
  return {
    entry: current,
    release: () => {
      if (released) return;
      released = true;
      if (current.refs === 1) {
        // the last view's flushes go out while it can still publish, and
        // publishing stays allowed until the drain has nothing left to send
        runFlushes(current);
        current.drainCanPublish = args.canEdit();
      }
      current.canEdit.delete(args.canEdit);
      if (--current.refs > 0) return;
      current.drainGeneration = current.generation;
      // reopened meanwhile (even if closed again since): a later drain decides;
      // otherwise the provider goes once nothing is left unsaved
      tryDestroy(registry, current);
    },
  };
}
