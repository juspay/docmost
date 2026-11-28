import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageCollabSocket } from "@/features/editor/collab-socket";
import {
  acquireBlockProvider,
  getBlockSaveState,
  subscribeBlockSaveState,
} from "./block-provider-registry";

vi.mock("@/lib/config.ts", () => ({
  getCollaborationUrl: () => "ws://localhost",
}));
const notices = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("@mantine/notifications", () => ({ notifications: notices }));

const NAME = "block.0193c7a0-1111-7abc-8def-00000000000a";
let socket: PageCollabSocket;
const created: any[] = [];

function setup(refreshToken = vi.fn(async () => "fresh")) {
  socket = new PageCollabSocket({ url: "ws://localhost", autoConnect: false });
  const handle = acquireBlockProvider({
    socket,
    name: NAME,
    token: "t",
    canEdit: () => true,
    refreshToken,
  });
  const provider: any = handle.entry.provider;
  created.push(provider);
  vi.spyOn(provider, "sendToken").mockResolvedValue(undefined);
  vi.spyOn(provider, "startSync").mockImplementation(() => undefined);
  return { handle, provider, refreshToken };
}

/** the server refuses whatever token is sent */
function refuseEveryToken(provider: any) {
  provider.startSync.mockImplementation(() => {
    queueMicrotask(() => provider.permissionDeniedHandler("permission-denied"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  notices.show.mockClear();
});
afterEach(() => {
  // the registry is shared by the whole tab: leave nothing unsaved behind
  for (const provider of created.splice(0)) {
    (socket as any).status = "connected";
    provider.authenticatedHandler("read-write");
    provider.unsyncedChanges = 1;
    provider.decrementUnsyncedChanges();
  }
  vi.useRealTimers();
  socket?.destroy();
});

describe("re-authentication after a refusal", () => {
  it("backs off and stops after 8 refusals in a row: at most 9 token fetches in 10 minutes", async () => {
    const { provider, refreshToken } = setup();
    refuseEveryToken(provider);
    provider.permissionDeniedHandler("permission-denied");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refreshToken.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(refreshToken.mock.calls.length).toBeLessThanOrEqual(9);
    expect(getBlockSaveState(NAME)).toMatchObject({ noAccess: true });
    const before = refreshToken.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(refreshToken.mock.calls.length).toBe(before);
  });

  it("the gaps grow from about 1 s to the 60 s ceiling", async () => {
    const { provider, refreshToken } = setup();
    refuseEveryToken(provider);
    const times: number[] = [];
    refreshToken.mockImplementation(async () => {
      times.push(Date.now());
      return "fresh";
    });
    provider.permissionDeniedHandler("permission-denied");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(gaps[0]).toBeGreaterThanOrEqual(500);
    expect(gaps[0]).toBeLessThanOrEqual(1_500);
    for (let i = 1; i < gaps.length; i++)
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] * 0.9);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(66_000);
  });

  it("a failing token fetch is retried at the ceiling and never counts toward the stop", async () => {
    const refreshToken = vi.fn(async () => {
      throw new Error("500");
    });
    const { provider } = setup(refreshToken as any);
    provider.permissionDeniedHandler("permission-denied");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // never mistaken for a fresh token, never given up on
    expect(provider.sendToken).not.toHaveBeenCalled();
    expect(getBlockSaveState(NAME).noAccess).toBe(false);
    // about once a minute after the first few
    expect(refreshToken.mock.calls.length).toBeGreaterThan(8);
    expect(refreshToken.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("a stopped block tries again when the tab becomes visible or the network comes back", async () => {
    const { provider, refreshToken } = setup();
    refuseEveryToken(provider);
    provider.permissionDeniedHandler("permission-denied");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const stopped = refreshToken.mock.calls.length;
    window.dispatchEvent(new Event("online"));
    // one fresh attempt at once; refused again, the next follows the backoff
    await vi.advanceTimersByTimeAsync(300);
    expect(refreshToken.mock.calls.length).toBe(stopped + 1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refreshToken.mock.calls.length).toBeLessThanOrEqual(stopped + 8);
  });

  it("a success resets the count", async () => {
    const { provider, refreshToken } = setup();
    provider.permissionDeniedHandler("permission-denied");
    await vi.advanceTimersByTimeAsync(2_000);
    provider.authenticatedHandler("read-write");
    expect(getBlockSaveState(NAME)).toMatchObject({
      authFailed: false,
      noAccess: false,
    });
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});

describe("a provider the server will never acknowledge", () => {
  it("with no local edits it is destroyed on release, even after a refusal", async () => {
    const { handle, provider } = setup();
    refuseEveryToken(provider);
    provider.permissionDeniedHandler("permission-denied");
    const destroy = vi.spyOn(provider, "destroy");
    handle.release();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("with local edits it is let go after the stop, with one notice", async () => {
    const { handle, provider } = setup();
    refuseEveryToken(provider);
    provider.document.getMap("m").set("k", 1);
    handle.release();
    const destroy = vi.spyOn(provider, "destroy");
    provider.permissionDeniedHandler("permission-denied");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(notices.show).toHaveBeenCalledTimes(1);
  });

  it("a read-only scope clears the edits that can never be saved and lets the provider go", async () => {
    const { handle, provider } = setup();
    provider.document.getMap("m").set("k", 1);
    handle.release();
    const destroy = vi.spyOn(provider, "destroy");
    (socket as any).status = "connected";
    provider.authenticatedHandler("readonly");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(notices.show).toHaveBeenCalledTimes(1);
  });
});

describe("the not-saved state", () => {
  it("is not shown for an ordinary edit acknowledged within 2 s", async () => {
    const { provider } = setup();
    (socket as any).status = "connected";
    provider.authenticatedHandler("read-write");
    const seen: boolean[] = [];
    const off = subscribeBlockSaveState(NAME, () =>
      seen.push(getBlockSaveState(NAME).unsaved),
    );
    provider.document.getMap("m").set("k", 1);
    await vi.advanceTimersByTimeAsync(500);
    provider.unsyncedChanges = 1;
    provider.decrementUnsyncedChanges();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen.includes(true)).toBe(false);
    off();
  });

  it("is shown when an edit stays unacknowledged for more than 2 s", async () => {
    const { provider } = setup();
    (socket as any).status = "connected";
    provider.authenticatedHandler("read-write");
    provider.document.getMap("m").set("k", 1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(getBlockSaveState(NAME).unsaved).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getBlockSaveState(NAME).unsaved).toBe(true);
  });
});

describe("closing the tab with unsaved block edits", () => {
  it("asks the browser to warn while edits are unacknowledged, and stops once saved", () => {
    const { provider } = setup();
    const warn = () => {
      const ev = new Event("beforeunload", {
        cancelable: true,
      }) as BeforeUnloadEvent;
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(warn()).toBe(false);
    provider.document.getMap("m").set("k", 1);
    expect(warn()).toBe(true);
    (socket as any).status = "connected";
    provider.authenticatedHandler("read-write");
    provider.unsyncedChanges = 1;
    provider.decrementUnsyncedChanges();
    expect(warn()).toBe(false);
  });

  it("stops at once after sign-out", async () => {
    const refreshToken = vi.fn(async () => {
      throw Object.assign(new Error("401"), { signedOut: true });
    });
    const { provider } = setup(refreshToken as any);
    provider.permissionDeniedHandler("permission-denied");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(getBlockSaveState(NAME).noAccess).toBe(true);
  });

  it("the local document of a released block with unsaved edits is still readable", async () => {
    await import("@docmost/live-blocks");
    const { getRetainedDoc } = await import("./block-provider-registry");
    const { buildSnapshot, pushElements } =
      await import("@docmost/live-blocks");
    const { handle, provider } = setup();
    pushElements(provider.document, [
      {
        id: "r",
        type: "rectangle",
        version: 1,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    ] as any);
    handle.release();
    const doc = getRetainedDoc(NAME)!;
    expect(buildSnapshot("whiteboard", doc)).toMatchObject({
      elements: [{ id: "r" }],
    });
  });
});

describe("after the stop", () => {
  async function stopped() {
    const t = setup();
    refuseEveryToken(t.provider);
    t.provider.permissionDeniedHandler("permission-denied");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    return t;
  }

  it("the block reports itself as not saving and read-only", async () => {
    await stopped();
    expect(getBlockSaveState(NAME)).toMatchObject({
      noAccess: true,
      notSaving: true,
    });
  });

  it("an edit made after the stop keeps the leave-page warning and is not dropped silently on release", async () => {
    const { handle, provider } = await stopped();
    provider.document.getMap("m").set("late", 1);
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    handle.release();
    expect(notices.show).toHaveBeenCalledTimes(1);
  });

  it("Try again restarts the back-off from 1 s", async () => {
    const { refreshToken } = await stopped();
    const { retryBlockSave } = await import("./block-provider-registry");
    const before = refreshToken.mock.calls.length;
    retryBlockSave(NAME);
    await vi.advanceTimersByTimeAsync(100);
    expect(refreshToken.mock.calls.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(refreshToken.mock.calls.length).toBe(before + 2);
    expect(getBlockSaveState(NAME).notSaving).toBe(false);
  });
});

describe("access dropping to read on a live connection", () => {
  function connected() {
    const t = setup();
    (socket as any).status = "connected";
    t.provider.authenticatedHandler("read-write");
    return t;
  }

  it("a page.permissions read message releases a provider holding edits, with one notice", () => {
    const { handle, provider } = connected();
    provider.document.getMap("m").set("k", 1);
    handle.release();
    const destroy = vi.spyOn(provider, "destroy");
    provider.receiveStateless(
      JSON.stringify({ type: "page.permissions", access: "read" }),
    );
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(notices.show).toHaveBeenCalledTimes(1);
    expect(getBlockSaveState(NAME).unsaved).toBe(false);
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("an update the server did not apply does the same", () => {
    const { handle, provider } = connected();
    provider.document.getMap("m").set("k", 1);
    handle.release();
    const destroy = vi.spyOn(provider, "destroy");
    // SyncStatus message, applied = 0
    const bytes = new Uint8Array([...encodeName(NAME), 8, 0]);
    provider.emit("message", { event: { data: bytes } });
    provider.onMessage?.({ data: bytes });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(notices.show).toHaveBeenCalledTimes(1);
  });
});

function encodeName(name: string): number[] {
  const bytes = [...new TextEncoder().encode(name)];
  return [bytes.length, ...bytes];
}
