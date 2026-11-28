import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { liveBlockOrigin } from "@docmost/editor-ext";
import { LiveBlockHostProvider, type LiveBlockHost } from "../live-block-host";
import { useLiveBlock } from "./use-live-block";
import * as service from "../services/live-block-service";

const stored = vi.hoisted(() => ({
  discard: vi.fn(async () => 0),
  hasCopy: vi.fn(async () => false),
}));
vi.mock("../components/block-provider-registry", () => ({
  discardStoredBlock: stored.discard,
  hasStoredBlock: stored.hasCopy,
}));
const pageService = vi.hoisted(() => ({ getPageById: vi.fn() }));
vi.mock("@/features/page/services/page-service", () => pageService);
vi.mock("@/features/user/hooks/use-current-user", () => ({
  default: () => ({ data: { user: { id: "u1" } } }),
}));
vi.mock("../services/live-block-service", () => ({
  ensureLiveBlock: vi.fn(),
  cloneLiveBlock: vi.fn(),
  getLiveBlockSnapshot: vi.fn(),
  getSharedLiveBlockSnapshot: vi.fn(),
}));

const PAGE = "019a1f00-0000-7000-8000-000000000003";
const A = "0193c7a0-1111-7abc-8def-00000000000a";
const SRC = "0193c7a0-1111-7abc-8def-00000000000b";

const mocked = vi.mocked(service);
const httpError = (status: number, code?: string) =>
  Object.assign(new Error(`HTTP ${status}`), {
    response: {
      status,
      data: code ? { code, message: code } : { message: "x" },
    },
  });

function makeEditor(editable = true) {
  const dom = document.createElement("div");
  dom.setAttribute("contenteditable", String(editable));
  return {
    isEditable: editable,
    storage: {},
    view: { dom },
    on: vi.fn(),
    off: vi.fn(),
  } as any;
}

function setup(opts: {
  host: LiveBlockHost;
  blockId?: string;
  editable?: boolean;
  active?: boolean;
  extraAttrs?: Record<string, unknown>;
  /** copy records the identity plugin made in the transaction that inserted the node */
  copies?: [string, string][];
}) {
  const editor = makeEditor(opts.editable ?? true);
  for (const [id, source] of opts.copies ?? []) {
    liveBlockOrigin(editor).copies.set(id, source);
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const attrs: any = {
    blockId: opts.blockId ?? A,
    title: null,
    height: null,
    ...opts.extraAttrs,
  };
  let rerender: (p: any) => void = () => {};
  const props: any = {
    node: { attrs },
    editor,
    updateAttributes: vi.fn((next: any) => {
      Object.assign(attrs, next);
      props.node = { attrs: { ...attrs } };
      rerender({ props: { ...props }, active: current.active });
    }),
  };
  const current = { active: opts.active ?? true };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <LiveBlockHostProvider host={opts.host}>{children}</LiveBlockHostProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(
    ({ props, active }) => useLiveBlock(props, "whiteboard", active),
    { wrapper, initialProps: { props, active: current.active } },
  );
  rerender = hook.rerender;
  const setActive = (active: boolean) => {
    current.active = active;
    hook.rerender({ props: { ...props }, active });
  };
  return { ...hook, editor, props, setActive, origin: liveBlockOrigin(editor) };
}

const pageHost: LiveBlockHost = { mode: "page", pageId: PAGE };

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useLiveBlock", () => {
  it("host none: status unavailable and nothing is sent", async () => {
    const { result } = setup({ host: { mode: "none" } });
    expect(result.current.status).toBe("unavailable");
    expect(mocked.ensureLiveBlock).not.toHaveBeenCalled();
    expect(mocked.getLiveBlockSnapshot).not.toHaveBeenCalled();
  });

  it("nothing is sent until the block is in view", async () => {
    mocked.ensureLiveBlock.mockResolvedValue({ blockId: A });
    const { result, setActive } = setup({ host: pageHost, active: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(mocked.ensureLiveBlock).not.toHaveBeenCalled();
    setActive(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mocked.ensureLiveBlock).toHaveBeenCalledTimes(1);
  });

  it("calls ensure once with blockId, pageId and kind, then reports ready", async () => {
    mocked.ensureLiveBlock.mockResolvedValue({ blockId: A });
    const { result } = setup({ host: pageHost });
    expect(result.current.status).toBe("ensuring");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mocked.ensureLiveBlock).toHaveBeenCalledWith({
      blockId: A,
      pageId: PAGE,
      kind: "whiteboard",
    });
    expect(mocked.ensureLiveBlock).toHaveBeenCalledTimes(1);
    expect(result.current.pageId).toBe(PAGE);
    expect(result.current.blockId).toBe(A);
  });

  it("a block this session copied is cloned, and the copy record is removed", async () => {
    mocked.cloneLiveBlock.mockResolvedValue({ blockId: A });
    const editorSetup = setup({ host: pageHost, active: false });
    editorSetup.origin.copies.set(A, SRC);
    editorSetup.setActive(true);
    await waitFor(() =>
      expect(editorSetup.result.current.status).toBe("ready"),
    );
    expect(mocked.cloneLiveBlock).toHaveBeenCalledWith({
      sourceBlockId: SRC,
      blockId: A,
      pageId: PAGE,
    });
    expect(mocked.ensureLiveBlock).not.toHaveBeenCalled();
    expect(editorSetup.origin.copies.has(A)).toBe(false);
  });

  it("a block that belongs to another page is never cloned on open", async () => {
    mocked.ensureLiveBlock.mockRejectedValue(httpError(409, "BLOCK_ID_TAKEN"));
    const { result, props } = setup({ host: pageHost });
    await waitFor(() => expect(result.current.status).toBe("foreign"));
    expect(mocked.cloneLiveBlock).not.toHaveBeenCalled();
    expect(props.updateAttributes).not.toHaveBeenCalled();
  });

  it("409 for an id this session created picks a new id and ensures again", async () => {
    mocked.ensureLiveBlock
      .mockRejectedValueOnce(httpError(409, "BLOCK_ID_TAKEN"))
      .mockImplementation(async (dto) => ({ blockId: dto.blockId }));
    const s = setup({ host: pageHost, active: false });
    s.origin.created.add(A);
    s.setActive(true);
    await waitFor(() =>
      expect(mocked.ensureLiveBlock).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(s.result.current.status).toBe("ready"));
    const newId = mocked.ensureLiveBlock.mock.calls[1][0].blockId;
    expect(newId).not.toBe(A);
    expect(s.props.updateAttributes).toHaveBeenCalledWith({ blockId: newId });
    expect(s.origin.created.has(newId)).toBe(true);
    expect(mocked.cloneLiveBlock).not.toHaveBeenCalled();
  });

  it("409 for a block this session pasted picks a new id and clones the original", async () => {
    mocked.ensureLiveBlock.mockRejectedValueOnce(
      httpError(409, "BLOCK_ID_TAKEN"),
    );
    mocked.cloneLiveBlock.mockImplementation(async (dto) => ({
      blockId: dto.blockId,
    }));
    const s = setup({ host: pageHost, active: false });
    s.origin.copies.set(A, A);
    s.setActive(true);
    await waitFor(() => expect(s.result.current.status).toBe("ready"));
    const [call] = mocked.cloneLiveBlock.mock.calls;
    expect(call[0].sourceBlockId).toBe(A);
    expect(call[0].blockId).not.toBe(A);
    expect(call[0].pageId).toBe(PAGE);
    expect(s.props.updateAttributes).toHaveBeenCalledWith({
      blockId: call[0].blockId,
    });
  });

  it("clone 404 reports no-access", async () => {
    mocked.cloneLiveBlock.mockRejectedValue(httpError(404));
    const s = setup({ host: pageHost, active: false });
    s.origin.copies.set(A, SRC);
    s.setActive(true);
    await waitFor(() => expect(s.result.current.status).toBe("no-access"));

    mocked.ensureLiveBlock.mockImplementation(async (dto) => ({
      blockId: dto.blockId,
    }));
    act(() => s.result.current.replaceWithEmpty());
    await waitFor(() => expect(s.result.current.status).toBe("ready"));
    expect(s.result.current.blockId).not.toBe(A);
    expect(s.origin.created.has(s.result.current.blockId!)).toBe(true);
  });

  it("read-only: no ensure; the snapshot is fetched and refetched after 30 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocked.getLiveBlockSnapshot.mockResolvedValue({
      kind: "whiteboard",
      snapshot: { kind: "whiteboard", elements: [], files: {} },
      updatedAt: new Date().toISOString(),
    });
    const { result } = setup({ host: pageHost, editable: false });
    expect(result.current.status).toBe("read-only");
    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    expect(mocked.getLiveBlockSnapshot).toHaveBeenCalledWith({
      blockId: A,
      pageId: PAGE,
    });
    expect(mocked.ensureLiveBlock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await waitFor(() =>
      expect(mocked.getLiveBlockSnapshot).toHaveBeenCalledTimes(2),
    );
  });

  it("share host uses the share route with its shareId", async () => {
    mocked.getSharedLiveBlockSnapshot.mockResolvedValue({
      kind: "whiteboard",
      snapshot: { kind: "whiteboard", elements: [], files: {} },
      updatedAt: "",
    });
    const { result } = setup({
      host: { mode: "share", pageId: PAGE, shareId: "share-key" },
    });
    expect(result.current.status).toBe("read-only");
    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    expect(mocked.getSharedLiveBlockSnapshot).toHaveBeenCalledWith({
      shareId: "share-key",
      pageId: PAGE,
      blockId: A,
    });
    expect(mocked.getLiveBlockSnapshot).not.toHaveBeenCalled();
  });

  it("history host shows the not-on-page message on 404", async () => {
    mocked.getLiveBlockSnapshot.mockRejectedValue(httpError(404));
    const { result } = setup({ host: { mode: "history", pageId: PAGE } });
    await waitFor(() =>
      expect(result.current.snapshotState).toBe("not-on-page"),
    );
  });

  it("a page reader sees 'not ready yet' on a 404", async () => {
    mocked.getLiveBlockSnapshot.mockRejectedValue(httpError(404));
    const { result } = setup({ host: pageHost, editable: false });
    await waitFor(() => expect(result.current.snapshotState).toBe("not-ready"));
  });

  it("a whiteboard that gets a new id drops the preview it shared with its source", async () => {
    const preview = {
      attachmentId: "att-src",
      src: "/api/files/att-src/w.svg",
    };
    // pasted from another page: 409, then cloned under a new id
    mocked.ensureLiveBlock.mockRejectedValueOnce(
      httpError(409, "BLOCK_ID_TAKEN"),
    );
    mocked.cloneLiveBlock.mockImplementation(async (dto) => ({
      blockId: dto.blockId,
    }));
    // the identity plugin records the paste in the transaction that inserts it
    const pasted = setup({
      host: pageHost,
      active: false,
      extraAttrs: preview,
      copies: [[A, A]],
    });
    await waitFor(() => expect(pasted.result.current.status).toBe("ready"));
    expect(pasted.props.updateAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: null, src: null }),
    );

    // replaced with an empty block
    mocked.ensureLiveBlock.mockReset();
    mocked.ensureLiveBlock.mockImplementation(async (dto) => ({
      blockId: dto.blockId,
    }));
    const replaced = setup({ host: pageHost, extraAttrs: { ...preview } });
    await waitFor(() => expect(replaced.result.current.status).toBe("ready"));
    act(() => replaced.result.current.replaceWithEmpty());
    expect(replaced.props.updateAttributes).toHaveBeenLastCalledWith(
      expect.objectContaining({ attachmentId: null, src: null }),
    );
  });

  it("a pasted copy is cloned as soon as it is inserted, not when it scrolls into view", async () => {
    mocked.cloneLiveBlock.mockImplementation(async (dto) => ({
      blockId: dto.blockId,
    }));
    const s = setup({ host: pageHost, active: false, copies: [[A, SRC]] });
    await waitFor(() => expect(mocked.cloneLiveBlock).toHaveBeenCalledTimes(1));
    expect(mocked.cloneLiveBlock).toHaveBeenCalledWith({
      sourceBlockId: SRC,
      blockId: A,
      pageId: PAGE,
    });
    expect(s.origin.copies.has(A)).toBe(false);
  });

  it("a block pasted from another page is resolved at once too", async () => {
    mocked.ensureLiveBlock.mockRejectedValueOnce(
      httpError(409, "BLOCK_ID_TAKEN"),
    );
    mocked.cloneLiveBlock.mockImplementation(async (dto) => ({
      blockId: dto.blockId,
    }));
    setup({ host: pageHost, active: false, copies: [[A, A]] });
    await waitFor(() => expect(mocked.cloneLiveBlock).toHaveBeenCalledTimes(1));
    expect(mocked.cloneLiveBlock.mock.calls[0][0].sourceBlockId).toBe(A);
  });

  it("an ordinary block still waits until it is about to go live", async () => {
    mocked.ensureLiveBlock.mockResolvedValue({ blockId: A });
    setup({ host: pageHost, active: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(mocked.ensureLiveBlock).not.toHaveBeenCalled();
  });

  it("history host fetches the current content once and does not poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocked.getLiveBlockSnapshot.mockResolvedValue({
      kind: "whiteboard",
      snapshot: { kind: "whiteboard", elements: [], files: {} },
      updatedAt: "",
    });
    const { result } = setup({ host: { mode: "history", pageId: PAGE } });
    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(mocked.getLiveBlockSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a pasted copy that comes into view while its clone is in flight is cloned exactly once", async () => {
    let finish: (v: { blockId: string }) => void = () => undefined;
    mocked.cloneLiveBlock.mockImplementation(
      (dto) => new Promise((r) => (finish = () => r({ blockId: dto.blockId }))),
    );
    const s = setup({ host: pageHost, active: false, copies: [[A, SRC]] });
    await waitFor(() => expect(mocked.cloneLiveBlock).toHaveBeenCalledTimes(1));
    // the IntersectionObserver reports it in view while the request is out
    s.setActive(true);
    s.setActive(false);
    s.setActive(true);
    await new Promise((r) => setTimeout(r, 20));
    act(() => finish({ blockId: A }));
    await waitFor(() => expect(s.result.current.status).toBe("ready"));
    expect(mocked.cloneLiveBlock).toHaveBeenCalledTimes(1);
    expect(s.result.current.blockId).toBe(A);
  });

  it("only the server's own coded refusals discard; bare 403/404 and the trash never do (N1)", async () => {
    for (const [status, code, discards] of [
      [404, "PAGE_NOT_FOUND", true],
      [403, "PAGE_NOT_EDITABLE", true],
      [403, "PAGE_IN_TRASH", false],
      [403, undefined, false], // a proxy or WAF challenge
      [404, undefined, false], // a misrouted deploy
      [404, "WORKSPACE_NOT_FOUND", false],
      [500, undefined, false],
      [503, undefined, false],
      [409, "BLOCK_ID_TAKEN", false],
    ] as const) {
      stored.discard.mockClear();
      mocked.ensureLiveBlock.mockReset();
      mocked.ensureLiveBlock.mockRejectedValue(httpError(status, code));
      const s = setup({ host: pageHost });
      await waitFor(() => expect(s.result.current.status).not.toBe("ensuring"));
      expect([status, code, stored.discard.mock.calls]).toEqual([
        status,
        code,
        discards ? [[`block.${A}`, PAGE, "u1"]] : [],
      ]);
    }
    stored.discard.mockClear();
    mocked.ensureLiveBlock.mockReset();
    mocked.ensureLiveBlock.mockRejectedValue(
      Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }),
    );
    const offline = setup({ host: pageHost });
    await waitFor(() => expect(offline.result.current.status).toBe("error"));
    expect(stored.discard).not.toHaveBeenCalled();
  });

  it("a read-only open drops the stored copy only on a fresh answer that this user cannot edit a page not in the trash", async () => {
    const cases: [string, any, boolean][] = [
      [
        "cannot edit",
        { permissions: { canEdit: false }, deletedAt: null },
        true,
      ],
      [
        "in the trash",
        { permissions: { canEdit: false }, deletedAt: "2026-11-27" },
        false,
      ],
      [
        "can edit (stale editor state)",
        { permissions: { canEdit: true }, deletedAt: null },
        false,
      ],
      ["page request failed", new Error("offline"), false],
    ];
    for (const [label, answer, discards] of cases) {
      stored.discard.mockClear();
      stored.hasCopy.mockResolvedValue(true);
      pageService.getPageById.mockReset();
      if (answer instanceof Error)
        pageService.getPageById.mockRejectedValue(answer);
      else pageService.getPageById.mockResolvedValue(answer);
      setup({ host: pageHost, editable: false });
      await new Promise((r) => setTimeout(r, 30));
      expect([label, stored.discard.mock.calls.length]).toEqual([
        label,
        discards ? 1 : 0,
      ]);
      // always asked the server, never the cache
      expect(pageService.getPageById).toHaveBeenCalledWith({ pageId: PAGE });
    }
    // no stored copy: the server is not even asked
    pageService.getPageById.mockClear();
    stored.hasCopy.mockResolvedValue(false);
    setup({ host: pageHost, editable: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(pageService.getPageById).not.toHaveBeenCalled();
    // offline: not asked either
    stored.hasCopy.mockResolvedValue(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    setup({ host: pageHost, editable: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(pageService.getPageById).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
