import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { HocuspocusContext } from "@hocuspocus/provider-react";
import { PageCollabSocket } from "@/features/editor/collab-socket";
import { HocuspocusProviderWebsocket, MessageType } from "@hocuspocus/provider";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
import { messageYjsUpdate } from "y-protocols/sync";
import { LiveBlockRoom } from "./live-block-room";
import { acquireBlockProvider } from "./block-provider-registry";
import { useBlockSaveState } from "./use-block-save-state";

/** the server acknowledges everything: the socket is up, the room authenticated, nothing unsynced */
function ack(provider: any) {
  (socket as any).status = "connected";
  provider.authenticatedHandler("read-write");
  provider.unsyncedChanges = 1;
  provider.decrementUnsyncedChanges();
}

/** a local edit the server has not acknowledged */
function editLocally(doc: any, key = "k") {
  doc.getMap("m").set(key, Math.random());
}

// these tests cover the in-memory room; the device copy has its own tests
// (block-offline-storage.test.ts)
vi.mock("@/features/editor/hooks/page-draft-cache", () => ({
  RESTORE: Symbol("restore page"),
  PageDraftCache: class {
    constructor() {
      throw new Error("storage unavailable");
    }
  },
}));
vi.mock("@/lib/config.ts", () => ({
  getCollaborationUrl: () => "ws://localhost",
}));
vi.mock("@/features/user/hooks/use-current-user", () => ({
  default: () => ({
    data: {
      user: { id: "user-1", name: "Ada", workspaceId: "ws-1", avatarUrl: null },
    },
  }),
}));
const tokenState = { token: "token-1" };
const refetchToken = vi.fn(async () => ({ data: { token: "fresh-token" } }));
vi.mock("@/features/auth/queries/auth-query.tsx", () => ({
  useCollabToken: () => ({
    data: { token: tokenState.token },
    refetch: refetchToken,
  }),
}));

const A = "0193c7a0-1111-7abc-8def-00000000000a";

let socket: PageCollabSocket;
function mount(
  canEdit: boolean,
  child: (ctx: any) => React.ReactNode = () => null,
) {
  socket = new PageCollabSocket({ url: "ws://localhost", autoConnect: false });
  const bind = vi.spyOn(socket, "bindRoom");
  const seen: any[] = [];
  const view = render(
    <HocuspocusContext.Provider value={{ websocketProvider: socket } as any}>
      <LiveBlockRoom blockId={A} canEdit={canEdit}>
        {(ctx) => {
          seen.push(ctx);
          return child(ctx);
        }}
      </LiveBlockRoom>
    </HocuspocusContext.Provider>,
  );
  return { view, bind, seen, last: () => seen[seen.length - 1] };
}

afterEach(() => {
  socket?.destroy();
  tokenState.token = "token-1";
});

function Room(props: {
  canEdit?: boolean;
  child?: (ctx: any) => React.ReactNode;
}) {
  return (
    <LiveBlockRoom blockId={A} canEdit={props.canEdit ?? true}>
      {(ctx) => props.child?.(ctx) ?? null}
    </LiveBlockRoom>
  );
}

function withSocket(children: React.ReactNode) {
  return (
    <HocuspocusContext.Provider value={{ websocketProvider: socket } as any}>
      {children}
    </HocuspocusContext.Provider>
  );
}

function trackProviders() {
  socket = new PageCollabSocket({ url: "ws://localhost", autoConnect: false });
  const bind = vi.spyOn(socket, "bindRoom");
  const seen = new Set<any>();
  const child = (ctx: any) => {
    seen.add(ctx.provider);
    return null;
  };
  return { bind, seen, child };
}

describe("LiveBlockRoom", () => {
  it("binds the block room to the collab socket and unbinds on unmount", async () => {
    const { view, bind, last } = mount(true);
    expect(bind).toHaveBeenCalledTimes(1);
    const [provider, canPublish] = bind.mock.calls[0];
    expect(provider.configuration.name).toBe(`block.${A}`);
    expect(canPublish()).toBe(true);
    expect(last().provider).toBe(provider);
    const rooms = (socket as any).rooms as Map<string, unknown>;
    expect(rooms.has(`block.${A}`)).toBe(true);
    view.unmount();
    await waitFor(() => expect(rooms.has(`block.${A}`)).toBe(false));
  });

  it("a reader's room is bound with canPublish false", () => {
    const { bind, last } = mount(false);
    const [, canPublish] = bind.mock.calls[0];
    expect(canPublish()).toBe(false);
    expect(last().readOnly).toBe(true);
  });

  it("pending view writes are flushed before the provider is destroyed", async () => {
    const order: string[] = [];
    const { view, last } = mount(true);
    const { provider, registerFlush, doc } = last();
    const destroy = vi.spyOn(provider, "destroy");
    destroy.mockImplementation(() => order.push("destroy"));
    registerFlush(() => {
      order.push("flush");
      doc.getMap("m").set("late", true);
    });
    view.unmount();
    expect(order).toEqual(["flush"]);
    ack(provider);
    await waitFor(() => expect(destroy).toHaveBeenCalled());
    expect(order).toEqual(["flush", "destroy"]);
    expect(doc.getMap("m").get("late")).toBe(true);
  });

  it("a provider with unsaved edits outlives its views until the next successful sync", async () => {
    const { view, last } = mount(true);
    const { provider, doc } = last();
    const destroy = vi.spyOn(provider, "destroy");
    editLocally(doc);
    view.unmount();
    await new Promise((r) => setTimeout(r, 2500));
    // offline far longer than the old 2 s drain: nothing is thrown away
    expect(destroy).not.toHaveBeenCalled();
    expect((socket as any).rooms.has(`block.${A}`)).toBe(true);
    ack(provider);
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  });

  it("a clean provider is destroyed as soon as its last view goes", async () => {
    const { view, last } = mount(true);
    const destroy = vi.spyOn(last().provider, "destroy");
    view.unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("synced goes back to false when the socket closes", async () => {
    const { last } = mount(true);
    const { provider } = last();
    act(() => {
      provider.synced = true;
    });
    await waitFor(() => expect(last().synced).toBe(true));
    act(() => provider.emit("close", { event: {} }));
    await waitFor(() => expect(last().synced).toBe(false));
  });

  it("the save state shows unsaved edits and an offline socket, and clears after a sync", async () => {
    const states: any[] = [];
    function Status() {
      states.push(useBlockSaveState(A));
      return null;
    }
    const { last } = mount(true);
    const view = render(<Status />);
    const { provider, doc } = last();
    expect(states.at(-1).unsaved).toBe(false);
    act(() => ack(provider));
    act(() => editLocally(doc));
    // an edit on its way is not "not saved" until it has waited 2 s
    expect(states.at(-1)).toMatchObject({ dirty: true, unsaved: false });
    act(() => ack(provider));
    expect(states.at(-1).unsaved).toBe(false);
    act(() => {
      (socket as any).status = "disconnected";
      provider.isAuthenticated = false;
      provider.emit("close", { event: {} });
    });
    expect(states.at(-1)).toMatchObject({ offline: true, unsaved: true });
    view.unmount();
  });

  it("sets the awareness user and lists other clients as peers", async () => {
    const { last } = mount(true);
    const { provider } = last();
    expect(provider.awareness.getLocalState().user).toMatchObject({
      id: "user-1",
      name: "Ada",
      color: expect.any(String),
    });
    act(() => {
      provider.awareness.states.set(4242, {
        user: { id: "user-2", name: "Grace", color: "#00f" },
      });
      provider.awareness.emit("change", [
        { added: [4242], updated: [], removed: [] },
        "remote",
      ]);
    });
    await waitFor(() =>
      expect(last().peers).toEqual([
        {
          clientId: 4242,
          user: { id: "user-2", name: "Grace", color: "#00f" },
        },
      ]),
    );
  });

  it("closing and reopening before the sync reuses the same provider", async () => {
    const { bind, seen, child } = trackProviders();
    const first = render(withSocket(<Room child={child} />));
    const [provider] = [...seen];
    editLocally(provider.document);
    const destroy = vi.spyOn(provider, "destroy");
    first.unmount();
    const second = render(withSocket(<Room child={child} />));
    expect(seen.size).toBe(1);
    expect(bind).toHaveBeenCalledTimes(1);
    ack(provider);
    expect(destroy).not.toHaveBeenCalled();
    second.unmount();
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  });

  it("a key change while mounted keeps one provider and passes the new token", async () => {
    const { bind, seen, child } = trackProviders();
    const view = render(withSocket(<Room child={child} />));
    tokenState.token = "token-2";
    view.rerender(withSocket(<Room child={child} />));
    view.rerender(withSocket(<Room child={child} canEdit={false} />));
    expect(seen.size).toBe(1);
    expect(bind).toHaveBeenCalledTimes(1);
    const [provider] = [...seen];
    await waitFor(() => expect(provider.configuration.token).toBe("token-2"));
    view.unmount();
  });

  it("the inline view and the full-window view of one block share one provider", async () => {
    const { bind, seen, child } = trackProviders();
    const both = render(
      withSocket(
        <>
          <Room child={child} />
          <Room child={child} />
        </>,
      ),
    );
    expect(seen.size).toBe(1);
    expect(bind).toHaveBeenCalledTimes(1);
    const [provider] = [...seen];
    const destroy = vi.spyOn(provider, "destroy");
    both.rerender(withSocket(<Room child={child} />));
    await new Promise((r) => setTimeout(r, 50));
    expect(destroy).not.toHaveBeenCalled();
    both.unmount();
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  });

  it("a release, reacquire and release before the sync leaves one destroy, after the sync", async () => {
    socket = new PageCollabSocket({
      url: "ws://localhost",
      autoConnect: false,
    });
    const args = {
      socket,
      name: `block.${A}`,
      token: "t",
      canEdit: () => true,
    };
    const first = acquireBlockProvider(args);
    const { provider, doc } = first.entry;
    const destroy = vi.spyOn(provider, "destroy");
    editLocally(doc);
    first.release();
    const second = acquireBlockProvider(args);
    expect(second.entry.provider).toBe(provider);
    second.release();
    expect(destroy).not.toHaveBeenCalled();
    ack(provider);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("a view that joins an authenticated read-only provider is read-only", async () => {
    const { seen, child } = trackProviders();
    const views: any[] = [];
    const first = render(withSocket(<Room child={child} />));
    const [provider] = [...seen];
    // the server already answered the first view with a read-only scope
    provider.authorizedScope = "readonly";
    const second = render(
      withSocket(
        <Room
          child={(ctx) => {
            views.push(ctx);
            return null;
          }}
        />,
      ),
    );
    await waitFor(() => expect(views[views.length - 1].readOnly).toBe(true));
    expect(views[views.length - 1].provider).toBe(provider);
    second.unmount();
    first.unmount();
  });

  it("the last view's unmount flush goes out on the wire", async () => {
    const sent: string[] = [];
    const send = vi
      .spyOn(HocuspocusProviderWebsocket.prototype, "send")
      .mockImplementation((bytes: Uint8Array) => {
        const decoder = createDecoder(bytes);
        const name = readVarString(decoder);
        if (readVarUint(decoder) !== MessageType.Sync) return;
        if (readVarUint(decoder) === messageYjsUpdate) sent.push(name);
      });
    try {
      const { view, last } = mount(true);
      Object.defineProperty(socket, "webSocket", {
        configurable: true,
        value: { readyState: WebSocket.OPEN },
      });
      const { registerFlush, doc, provider } = last();
      // the provider joins once the device copy is open (or found unavailable)
      await waitFor(() => expect(provider.isAttached).toBe(true));
      registerFlush(() => doc.getMap("m").set("typed", "last words"));
      const destroy = vi.spyOn(provider, "destroy");
      view.unmount();
      expect(sent).toEqual([`block.${A}`]);
      // still bound until the server has it
      ack(provider);
      await waitFor(() => expect(destroy).toHaveBeenCalled());
    } finally {
      Object.defineProperty(socket, "webSocket", {
        configurable: true,
        writable: true,
        value: null,
      });
      send.mockRestore();
    }
  });

  it("an authentication failure fetches a fresh token, resends it and resyncs", async () => {
    const states: any[] = [];
    function Status() {
      states.push(useBlockSaveState(A));
      return null;
    }
    const { last } = mount(true);
    render(<Status />);
    const { provider } = last();
    const sendToken = vi
      .spyOn(provider, "sendToken")
      .mockResolvedValue(undefined);
    const startSync = vi
      .spyOn(provider, "startSync")
      .mockImplementation(() => undefined);
    act(() => provider.permissionDeniedHandler("token expired"));
    expect(states.at(-1)).toMatchObject({ authFailed: true, unsaved: true });
    await waitFor(() => expect(sendToken).toHaveBeenCalled());
    expect(refetchToken).toHaveBeenCalled();
    expect(provider.configuration.token).toBe("fresh-token");
    expect(startSync).toHaveBeenCalled();
    act(() => ack(provider));
    expect(states.at(-1).unsaved).toBe(false);
  });

  it("an upload still in flight keeps the provider until its result is saved", async () => {
    const { view, last } = mount(true);
    const { provider, doc, keepAlive } = last();
    const destroy = vi.spyOn(provider, "destroy");
    let finish: () => void = () => undefined;
    const upload = new Promise<void>((resolve) => (finish = resolve)).then(() =>
      doc
        .getMap("files")
        .set("f1", { attachmentId: "a", mimeType: "image/png" }),
    );
    keepAlive(upload);
    view.unmount();
    expect(destroy).not.toHaveBeenCalled();
    finish();
    await upload;
    await new Promise((r) => setTimeout(r, 0));
    // the file reference landed on the live document and waits for the server
    expect(doc.getMap("files").get("f1")).toBeTruthy();
    expect(destroy).not.toHaveBeenCalled();
    ack(provider);
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  });

  it("a token refetch that comes back empty (the 401 the api client swallows) counts as signed out", async () => {
    refetchToken.mockResolvedValueOnce({ data: undefined } as any);
    const { last } = mount(true);
    const { provider } = last();
    vi.spyOn(provider, "sendToken").mockResolvedValue(undefined);
    act(() => provider.permissionDeniedHandler("expired"));
    const { getBlockSaveState } = await import("./block-provider-registry");
    await waitFor(() =>
      expect(getBlockSaveState(`block.${A}`).noAccess).toBe(true),
    );
    expect(provider.sendToken).not.toHaveBeenCalled();
  });
});
