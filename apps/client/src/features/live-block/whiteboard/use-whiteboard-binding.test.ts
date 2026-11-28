import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  connect,
  pushElements,
  readElements,
  readFiles,
  setFile,
} from "@docmost/live-blocks";
import { useWhiteboardBinding } from "./use-whiteboard-binding";
import { notifications } from "@mantine/notifications";
import { LOCAL_ORIGIN } from "../hooks/use-block-undo";

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn(), hide: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));

const el = (id: string, version: number, extra: any = {}) => ({
  id,
  version,
  versionNonce: 0,
  type: "rectangle",
  index: `a${id}`,
  isDeleted: false,
  ...extra,
});

function fakeApi(initial: any[] = []) {
  let scene = [...initial];
  let files: Record<string, any> = {};
  return {
    updateScene: vi.fn((data: any) => {
      if (data.elements) scene = [...data.elements];
    }),
    addFiles: vi.fn((list: any[]) => {
      for (const f of list) files[f.id] = f;
    }),
    getSceneElementsIncludingDeleted: () => scene,
    getSceneElements: () => scene.filter((e) => !e.isDeleted),
    getFiles: () => files,
    setScene: (next: any[]) => (scene = [...next]),
    setFiles: (next: any) => (files = next),
  };
}

function setup(opts: { readOnly?: boolean; doc?: Y.Doc; api?: any } = {}) {
  const doc = opts.doc ?? new Y.Doc();
  const awareness = new Awareness(doc);
  const provider: any = {
    awareness,
    setAwarenessField: (k: string, v: unknown) =>
      awareness.setLocalStateField(k, v),
  };
  const api = opts.api ?? fakeApi();
  const uploadImage = vi.fn(
    async (_file: File) => "0193c7a0-0000-7000-8000-0000000000a1",
  );
  const loadImage = vi.fn(async (_id: string) => "data:image/png;base64,AAAA");
  const keepAlive = vi.fn();
  const hook = renderHook(() =>
    useWhiteboardBinding({
      doc,
      provider,
      api,
      readOnly: opts.readOnly ?? false,
      uploadImage,
      loadImage,
      keepAlive,
    }),
  );
  return {
    ...hook,
    doc,
    api,
    provider,
    awareness,
    uploadImage,
    loadImage,
    keepAlive,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useWhiteboardBinding", () => {
  it("a local change is pushed to the shared map", () => {
    const { result, doc } = setup();
    act(() =>
      result.current.onChange([el("1", 1)] as any, {} as any, {} as any),
    );
    expect(readElements(doc).map((e) => e.id)).toEqual(["1"]);
    const updates: any[] = [];
    doc.on("update", (_u: any, origin: unknown) => updates.push(origin));
    act(() =>
      result.current.onChange([el("1", 2)] as any, {} as any, {} as any),
    );
    // throttled: the second change waits for the window
    expect(readElements(doc)[0].version).toBe(1);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(readElements(doc)[0].version).toBe(2);
    expect(updates).toEqual([LOCAL_ORIGIN]);
  });

  it("a remote change updates the canvas with captureUpdate NEVER", () => {
    const { doc, api } = setup();
    const remote = new Y.Doc();
    connect(doc, remote);
    act(() => {
      pushElements(remote, [el("9", 3)]);
    });
    const call = api.updateScene.mock.calls.at(-1)[0];
    expect(call.captureUpdate).toBe("NEVER");
    expect(call.elements.map((e: any) => e.id)).toEqual(["9"]);
  });

  it("a stale remote element is answered by re-pushing the newer local one", () => {
    const api = fakeApi([el("1", 7, { x: 2 })]);
    const doc = new Y.Doc();
    const { result } = setup({ doc, api });
    // the canvas holds version 7; a remote write of version 5 lands
    const remote = new Y.Doc();
    act(() => {
      pushElements(remote, [el("1", 5, { x: 1 })]);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), "remote");
    });
    expect(readElements(doc)[0]).toMatchObject({ version: 7, x: 2 });
    // the canvas keeps its newer copy and was updated without an undo entry
    const call = api.updateScene.mock.calls.at(-1)[0];
    expect(call.captureUpdate).toBe("NEVER");
    expect(call.elements[0]).toMatchObject({ version: 7, x: 2 });
    expect(result.current.collaborators.size).toBe(0);
  });

  it("a new image is uploaded once and recorded in the files map", async () => {
    vi.useRealTimers();
    const { result, doc, uploadImage } = setup();
    const files = {
      f1: {
        id: "f1",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
        created: 1,
      },
    };
    act(() =>
      result.current.onChange(
        [el("1", 1, { type: "image", fileId: "f1" })] as any,
        {} as any,
        files as any,
      ),
    );
    act(() =>
      result.current.onChange(
        [el("1", 2, { type: "image", fileId: "f1" })] as any,
        {} as any,
        files as any,
      ),
    );
    await waitFor(() =>
      expect(readFiles(doc).f1).toEqual({
        attachmentId: "0193c7a0-0000-7000-8000-0000000000a1",
        mimeType: "image/png",
      }),
    );
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(uploadImage.mock.calls[0][0]).toBeInstanceOf(File);
  });

  it("a failed image upload leaves the scene syncing", async () => {
    vi.useRealTimers();
    const { result, doc, uploadImage } = setup();
    uploadImage.mockRejectedValueOnce(new Error("too big"));
    const files = {
      f1: {
        id: "f1",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
        created: 1,
      },
    };
    act(() =>
      result.current.onChange(
        [el("1", 1, { type: "image", fileId: "f1" })] as any,
        {} as any,
        files as any,
      ),
    );
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(readElements(doc).map((e) => e.id)).toEqual(["1"]);
    expect(readFiles(doc)).toEqual({});
    await new Promise((r) => setTimeout(r, 150));
    // past the 5 s retry backoff
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6_000);
    act(() =>
      result.current.onChange(
        [el("1", 2, { type: "image", fileId: "f1" })] as any,
        {} as any,
        files as any,
      ),
    );
    await waitFor(() =>
      expect(readFiles(doc).f1?.attachmentId).toBe(
        "0193c7a0-0000-7000-8000-0000000000a1",
      ),
    );
    expect(uploadImage).toHaveBeenCalledTimes(2);
  });

  it("a remote file id is fetched and added to the canvas", async () => {
    vi.useRealTimers();
    const { doc, api, loadImage } = setup();
    act(() => {
      setFile(
        doc,
        "f9",
        {
          attachmentId: "0193c7a0-1111-7abc-8def-0000000000a9",
          mimeType: "image/png",
        },
        "remote",
      );
    });
    await waitFor(() => expect(api.addFiles).toHaveBeenCalled());
    expect(loadImage).toHaveBeenCalledWith(
      "0193c7a0-1111-7abc-8def-0000000000a9",
    );
    expect(api.addFiles.mock.calls[0][0][0]).toMatchObject({
      id: "f9",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AAAA",
    });
  });

  it("read-only: onChange pushes nothing", () => {
    const { result, doc } = setup({ readOnly: true });
    act(() =>
      result.current.onChange([el("1", 1)] as any, {} as any, {} as any),
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(readElements(doc)).toEqual([]);
  });

  it("flush sends a pending throttled push immediately", () => {
    const { result, doc } = setup();
    act(() =>
      result.current.onChange([el("1", 1)] as any, {} as any, {} as any),
    );
    act(() =>
      result.current.onChange([el("1", 2)] as any, {} as any, {} as any),
    );
    expect(readElements(doc)[0].version).toBe(1);
    act(() => result.current.flush());
    expect(readElements(doc)[0].version).toBe(2);
  });

  it("pointer updates are throttled to 50 ms and peers become collaborators", () => {
    const { result, awareness } = setup();
    const pointer = (x: number) =>
      result.current.onPointerUpdate({
        pointer: { x, y: 1, tool: "pointer" },
        button: "up",
        pointersMap: new Map(),
      } as any);
    act(() => {
      pointer(1);
      pointer(2);
      pointer(3);
    });
    expect(awareness.getLocalState().pointer).toMatchObject({ x: 1 });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(awareness.getLocalState().pointer).toMatchObject({ x: 3 });

    act(() => {
      awareness.states.set(77, {
        user: { id: "u2", name: "Grace", color: "#f00" },
        pointer: { x: 5, y: 6, tool: "pointer" },
        button: "down",
      });
      awareness.emit("change", [
        { added: [77], updated: [], removed: [] },
        "remote",
      ]);
    });
    const collaborator = result.current.collaborators.get("77" as any);
    expect(collaborator).toMatchObject({
      username: "Grace",
      pointer: { x: 5, y: 6 },
      button: "down",
      color: { background: "#f00", stroke: "#f00" },
    });
    expect(result.current.collaborators.size).toBe(1);
  });

  it("an image upload keeps the board's document alive until its reference is written", async () => {
    vi.useRealTimers();
    const { result, doc, keepAlive, uploadImage, unmount } = setup();
    let finish: (id: string) => void = () => undefined;
    uploadImage.mockImplementationOnce(
      () => new Promise<string>((r) => (finish = r)),
    );
    const files = {
      f1: {
        id: "f1",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
        created: 1,
      },
    };
    act(() =>
      result.current.onChange(
        [el("1", 1, { type: "image", fileId: "f1" })] as any,
        {} as any,
        files as any,
      ),
    );
    expect(keepAlive).toHaveBeenCalledTimes(1);
    // the board closes before the upload finishes
    unmount();
    finish("0193c7a0-0000-7000-8000-0000000000a2");
    await keepAlive.mock.calls[0][0];
    expect(readFiles(doc).f1).toEqual({
      attachmentId: "0193c7a0-0000-7000-8000-0000000000a2",
      mimeType: "image/png",
    });
  });

  it("a file reference that is not a uuid is never fetched", async () => {
    vi.useRealTimers();
    const { doc, api, loadImage } = setup();
    act(() => {
      setFile(
        doc,
        "f-bad",
        { attachmentId: "../api/users/me?", mimeType: "image/png" },
        "remote",
      );
      setFile(
        doc,
        "f-ok",
        {
          attachmentId: "0193c7a0-1111-7abc-8def-0000000000aa",
          mimeType: "image/png",
        },
        "remote",
      );
    });
    await waitFor(() => expect(api.addFiles).toHaveBeenCalled());
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(loadImage).toHaveBeenCalledWith(
      "0193c7a0-1111-7abc-8def-0000000000aa",
    );
  });

  it("an upload that keeps failing shows one notice, not one per change", async () => {
    vi.useRealTimers();
    vi.mocked(notifications.show).mockClear();
    const { result, uploadImage } = setup();
    uploadImage.mockRejectedValue(new Error("rejected type"));
    const files = {
      f1: {
        id: "f1",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
        created: 1,
      },
    };
    for (let v = 1; v <= 3; v++) {
      act(() =>
        result.current.onChange(
          [el("1", v, { type: "image", fileId: "f1" })] as any,
          {} as any,
          files as any,
        ),
      );
      await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(v));
      await new Promise((r) => setTimeout(r, 150));
      // past each retry backoff
      const at = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(at + 600_000);
    }
    expect(notifications.show).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifications.show).mock.calls[0][0]).toHaveProperty("id");
  });

  it("a failed image download is retried", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { doc, api, loadImage } = setup();
    loadImage.mockRejectedValueOnce(new Error("network"));
    act(() => {
      setFile(
        doc,
        "f9",
        {
          attachmentId: "0193c7a0-1111-7abc-8def-0000000000a9",
          mimeType: "image/png",
        },
        "remote",
      );
    });
    await waitFor(() => expect(loadImage).toHaveBeenCalledTimes(1));
    expect(api.addFiles).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await waitFor(() => expect(api.addFiles).toHaveBeenCalledTimes(1));
    expect(loadImage).toHaveBeenCalledTimes(2);
  });

  it("a failing upload backs off instead of retrying on every change", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, uploadImage } = setup();
    uploadImage.mockRejectedValue(new Error("quota"));
    const files = {
      f1: {
        id: "f1",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
        created: 1,
      },
    };
    for (let v = 1; v <= 20; v++) {
      act(() =>
        result.current.onChange(
          [el("1", v, { type: "image", fileId: "f1" })] as any,
          {} as any,
          files as any,
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
    }
    // 20 changes in 4 s: the first try and at most a couple of backed-off retries
    expect(uploadImage.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("a download that keeps failing stops after a few tries, and a 404 is not retried", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { doc, loadImage } = setup();
    loadImage.mockImplementation(async (id: string) => {
      throw Object.assign(new Error("x"), {
        status: id.endsWith("a8") ? 404 : 500,
      });
    });
    act(() => {
      setFile(
        doc,
        "f9",
        {
          attachmentId: "0193c7a0-1111-7abc-8def-0000000000a9",
          mimeType: "image/png",
        },
        "remote",
      );
      setFile(
        doc,
        "f8",
        {
          attachmentId: "0193c7a0-1111-7abc-8def-0000000000a8",
          mimeType: "image/png",
        },
        "remote",
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    const calls = (id: string) =>
      loadImage.mock.calls.filter((c) => c[0] === id).length;
    expect(calls("0193c7a0-1111-7abc-8def-0000000000a9")).toBeLessThanOrEqual(
      5,
    );
    expect(calls("0193c7a0-1111-7abc-8def-0000000000a8")).toBe(1);
  });

  it("the failed-upload notice is hidden when the board closes", async () => {
    vi.useRealTimers();
    vi.mocked(notifications.hide).mockClear();
    const { result, uploadImage, unmount } = setup();
    uploadImage.mockRejectedValue(new Error("x"));
    const files = {
      f1: {
        id: "f1",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
        created: 1,
      },
    };
    act(() =>
      result.current.onChange(
        [el("1", 1, { type: "image", fileId: "f1" })] as any,
        {} as any,
        files as any,
      ),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalled());
    unmount();
    expect(notifications.hide).toHaveBeenCalledWith("whiteboard-upload-f1");
  });

  it("a pasted YouTube watch link is rewritten to the canonical embed before it is shown or stored", async () => {
    vi.useRealTimers();
    const { result, api, doc } = setup();
    const pasted = el("v", 1, {
      type: "embeddable",
      link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30",
    });
    api.setScene([pasted]);
    act(() => result.current.onChange([pasted] as any, {} as any, {} as any));
    const shown = api.updateScene.mock.calls
      .at(-1)?.[0]
      ?.elements?.find((e: any) => e.id === "v");
    expect(shown).toMatchObject({
      link: "https://www.youtube.com/embed/dQw4w9WgXcQ?start=30",
      version: 2,
    });
    await act(async () => {
      result.current.flush();
    });
    expect(readElements(doc)[0].link).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?start=30",
    );
  });
});
