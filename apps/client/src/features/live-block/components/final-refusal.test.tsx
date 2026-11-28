import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { PageCollabSocket } from "@/features/editor/collab-socket";
import { deleteLocalPageData } from "@/lib/local-page-data";
import { LiveBlockHostProvider } from "../live-block-host";
import { useLiveBlock } from "../hooks/use-live-block";
import * as service from "../services/live-block-service";
import {
  acquireBlockProvider,
  closeBlockStorageForTests,
  discardStoredBlock,
  getBlockSaveState,
} from "./block-provider-registry";
import { dropBlocksOfRefusedPage } from "./page-refusal";

vi.mock("@/lib/config.ts", () => ({
  getCollaborationUrl: () => "ws://localhost",
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn(), hide: vi.fn() },
}));
vi.mock("@/features/user/hooks/use-current-user", () => ({
  default: () => ({ data: { user: { id: "u1" } } }),
}));
const pageAnswer = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/features/page/services/page-service", () => ({
  getPageById: pageAnswer.get,
}));
vi.mock("../services/live-block-service", () => ({
  ensureLiveBlock: vi.fn(),
  cloneLiveBlock: vi.fn(),
  getLiveBlockSnapshot: vi.fn(async () => ({
    kind: "whiteboard",
    snapshot: null,
  })),
  getSharedLiveBlockSnapshot: vi.fn(),
}));

const PAGE = "019a1f00-0000-7000-8000-000000000003";
let id: string;
const name = () => `block.${id}`;
const sockets: PageCollabSocket[] = [];
const settle = () => new Promise((r) => setTimeout(r, 60));

function installLocks() {
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      async request(n: string, _o: unknown, cb: (lock: unknown) => any) {
        if (held.has(n)) return cb(null);
        held.add(n);
        try {
          await cb({ name: n });
        } finally {
          held.delete(n);
        }
      },
    },
  });
}

async function openBlock() {
  const socket = new PageCollabSocket({
    url: "ws://localhost",
    autoConnect: false,
  });
  sockets.push(socket);
  const handle = acquireBlockProvider({
    socket,
    name: name(),
    token: "t",
    canEdit: () => true,
    userId: "u1",
    pageId: PAGE,
  });
  await handle.entry.ready;
  return {
    socket,
    handle,
    entry: handle.entry as any,
    doc: handle.entry.doc as Y.Doc,
  };
}

/** the stored copy as a later writable open would find it */
async function laterOpen() {
  for (const s of sockets.splice(0)) closeBlockStorageForTests(s);
  const b = await openBlock();
  await b.entry.storage?.authenticated(true);
  return [...b.doc.getMap("m").keys()];
}

async function openWithStoredEdit() {
  const a = await openBlock();
  a.doc.getMap("m").set("offline", 1);
  await settle();
  expect(a.entry.storage.hasPending).toBe(true);
  return a;
}

beforeEach(() => {
  id = crypto.randomUUID();
  installLocks();
  pageAnswer.get.mockReset();
});
afterEach(async () => {
  for (const s of sockets.splice(0)) closeBlockStorageForTests(s);
  Reflect.deleteProperty(navigator, "locks");
  await deleteLocalPageData();
});

describe("a final refusal while the block is open in the tab (I2)", () => {
  it("discardStoredBlock on an open entry stops it sending and leaves nothing to replay", async () => {
    const a = await openWithStoredEdit();
    expect(await discardStoredBlock(name(), PAGE, "u1")).toBe(1);
    await settle();
    expect(a.entry.noAccess).toBe(true);
    expect(a.entry.storage).toBeUndefined();
    expect(getBlockSaveState(name(), "u1").lost).toBe(true);
    expect(await laterOpen()).toEqual([]);
  });

  it("through a coded ensure refusal (PAGE_NOT_EDITABLE) from useLiveBlock", async () => {
    const a = await openWithStoredEdit();
    vi.mocked(service.ensureLiveBlock).mockRejectedValue(
      Object.assign(new Error("HTTP 403"), {
        response: {
          status: 403,
          data: { statusCode: 403, code: "PAGE_NOT_EDITABLE", message: "x" },
        },
      }),
    );
    const dom = document.createElement("div");
    dom.setAttribute("contenteditable", "true");
    const editor: any = {
      isEditable: true,
      storage: {},
      view: { dom },
      on: vi.fn(),
      off: vi.fn(),
    };
    const props: any = {
      node: { attrs: { blockId: id } },
      editor,
      updateAttributes: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const hook = renderHook(() => useLiveBlock(props, "whiteboard", true), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>
          <LiveBlockHostProvider host={{ mode: "page", pageId: PAGE }}>
            {children}
          </LiveBlockHostProvider>
        </QueryClientProvider>
      ),
    });
    await waitFor(() => expect(hook.result.current.status).toBe("no-access"));
    await waitFor(() => expect(a.entry.noAccess).toBe(true));
    await settle();
    expect(a.entry.storage).toBeUndefined();
    hook.unmount();
    expect(await laterOpen()).toEqual([]);
  });

  it("through the refused-page drop (the app server's own 404)", async () => {
    const a = await openWithStoredEdit();
    pageAnswer.get.mockRejectedValue(
      Object.assign(new Error("HTTP 404"), {
        response: {
          status: 404,
          data: { statusCode: 404, message: "Page not found" },
        },
      }),
    );
    await dropBlocksOfRefusedPage(PAGE, "u1");
    await settle();
    expect(a.entry.noAccess).toBe(true);
    expect(a.entry.storage).toBeUndefined();
    expect(await laterOpen()).toEqual([]);
  });
});
