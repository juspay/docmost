import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { pushElements } from "@docmost/live-blocks";
import { MantineProvider } from "@mantine/core";
import WhiteboardCanvas from "./whiteboard-canvas";
import {
  readPreviewMeta,
  sceneFingerprint,
  writePreviewMeta,
} from "./whiteboard-preview";

const excalidraw = vi.hoisted(() => ({
  props: null as any,
  onKeyDown: vi.fn(),
}));
vi.mock("@excalidraw/excalidraw/index.css", () => ({}));
vi.mock("@excalidraw/excalidraw", () => {
  const scene: any[] = [];
  const api = {
    updateScene: vi.fn((data: any) => {
      if (data.elements) scene.splice(0, scene.length, ...data.elements);
    }),
    addFiles: vi.fn(),
    getSceneElementsIncludingDeleted: () => scene,
    getSceneElements: () => scene,
    getFiles: () => ({}),
    onPasteReplay: vi.fn(),
  };
  function Excalidraw(props: any) {
    excalidraw.props = props;
    React.useEffect(() => props.onInitialize?.(api), []);
    // Excalidraw takes keys through a React onKeyDown on its container
    return (
      <div
        data-testid="excalidraw"
        tabIndex={0}
        onKeyDown={excalidraw.onKeyDown}
      />
    );
  }
  return {
    Excalidraw,
    restoreElements: (els: any) => els,
    exportScene: vi.fn(async () =>
      document.createElementNS("http://www.w3.org/2000/svg", "svg"),
    ),
  };
});
const upload = vi.hoisted(() => ({
  uploadFile: vi.fn(async (_file: File, _target: any, id?: string) => ({
    id: id ?? "att-new",
    fileName: "whiteboard.svg",
    updatedAt: new Date().toISOString(),
  })),
}));
vi.mock("@/features/page/services/page-service.ts", () => upload);
vi.mock("@/lib", () => ({
  svgStringToFile: async (svg: string, name: string) => new File([svg], name),
}));
vi.mock("@mantine/core", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  useComputedColorScheme: () => "light",
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));

const rect = (id: string, version: number) => ({
  id,
  version,
  versionNonce: 0,
  type: "rectangle",
  index: `a${id}`,
  isDeleted: false,
});

function mount(
  attachmentId: string | null,
  seed?: (doc: Y.Doc) => void,
  opts: { synced?: boolean } = {},
) {
  const doc = new Y.Doc();
  seed?.(doc);
  const flushes = new Set<() => void>();
  const awareness = new Awareness(doc);
  const ctx: any = {
    doc,
    provider: {
      awareness,
      setAwarenessField: (k: string, v: unknown) =>
        awareness.setLocalStateField(k, v),
    },
    synced: opts.synced ?? true,
    readOnly: false,
    peers: [],
    registerFlush: (fn: () => void) => {
      flushes.add(fn);
      return () => flushes.delete(fn);
    },
    keepAlive: vi.fn(),
    blockId: "b1",
    pageId: "page-1",
    opened: true,
  };
  // like the editor: the node's attributes change
  const updateAttributes = vi.fn((attrs: any) =>
    Object.assign(nodeProps.node.attrs, attrs),
  );
  const nodeProps: any = {
    node: {
      attrs: { attachmentId, src: attachmentId ? "/api/files/x/w.svg" : null },
    },
    updateAttributes,
  };
  const view = render(
    <MantineProvider>
      <WhiteboardCanvas ctx={ctx} nodeProps={nodeProps} />
    </MantineProvider>,
  );
  // the room runs its views' flushes when the last one goes
  const close = () => {
    for (const fn of [...flushes]) fn();
    view.unmount();
  };
  return { view: { ...view, unmount: close }, doc, updateAttributes, ctx };
}

async function ready() {
  await waitFor(() =>
    expect(excalidraw.props?.onChange).toBeTypeOf("function"),
  );
}

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
})) as any;

afterEach(() => {
  upload.uploadFile.mockClear();
  excalidraw.props = null;
});

describe("WhiteboardCanvas preview", () => {
  it("opening and closing an unchanged board saves nothing, even after the first sync", async () => {
    const { view, doc } = mount("att-old", (d) =>
      writePreviewMeta(d, sceneFingerprint([rect("1", 3)]), "att-old"),
    );
    await ready();
    // the server's state arrives after opening
    const remote = new Y.Doc();
    pushElements(remote, [rect("1", 3)]);
    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), "server"));
    act(() => excalidraw.props.onChange([rect("1", 3)], {}, {}));
    view.unmount();
    await new Promise((r) => setTimeout(r, 50));
    expect(upload.uploadFile).not.toHaveBeenCalled();
  });

  it("a board someone else drew on is saved by whoever closes it, and the saved scene is recorded", async () => {
    // the stored preview was made from version 3; another editor has since drawn version 4
    const { view, doc, ctx } = mount("att-old", (d) =>
      writePreviewMeta(d, sceneFingerprint([rect("1", 3)]), "att-old"),
    );
    await ready();
    act(() => excalidraw.props.onChange([rect("1", 4)], {}, {}));
    view.unmount();
    await waitFor(() => expect(upload.uploadFile).toHaveBeenCalledTimes(1));
    // the document stays alive until the save has written its record
    expect(ctx.keepAlive).toHaveBeenCalled();
    await ctx.keepAlive.mock.calls[0][0];
    expect(readPreviewMeta(doc)).toEqual({
      scene: sceneFingerprint([rect("1", 4)]),
      attachmentId: "att-old",
    });
  });

  it("hiding the tab with the board open saves the preview (best effort on close)", async () => {
    const { view } = mount(null);
    await ready();
    act(() => excalidraw.props.onChange([rect("1", 1)], {}, {}));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(upload.uploadFile).toHaveBeenCalledTimes(1));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    view.unmount();
    // already saved for this scene: closing does not upload again
    await new Promise((r) => setTimeout(r, 50));
    expect(upload.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("the first preview sets the node's attachment and src once, without a cache-buster", async () => {
    const { view, updateAttributes } = mount(null);
    await ready();
    act(() => excalidraw.props.onChange([rect("1", 1)], {}, {}));
    view.unmount();
    await waitFor(() => expect(updateAttributes).toHaveBeenCalledTimes(1));
    expect(updateAttributes).toHaveBeenCalledWith({
      attachmentId: "att-new",
      src: "/api/files/att-new/whiteboard.svg",
    });
  });

  it("a later preview replaces the file in place and does not touch the node", async () => {
    const { view, updateAttributes } = mount("att-old");
    await ready();
    act(() => excalidraw.props.onChange([rect("1", 1)], {}, {}));
    view.unmount();
    await waitFor(() => expect(upload.uploadFile).toHaveBeenCalledTimes(1));
    expect(upload.uploadFile.mock.calls[0][2]).toBe("att-old");
    await new Promise((r) => setTimeout(r, 20));
    expect(updateAttributes).not.toHaveBeenCalled();
  });

  it("Cmd/Ctrl+Z inside the canvas reaches Excalidraw", async () => {
    const { view } = mount("att-old");
    await ready();
    excalidraw.onKeyDown.mockClear();
    const target = screen.getByTestId("excalidraw");
    fireEvent.keyDown(target, { key: "z", metaKey: true });
    fireEvent.keyDown(target, { key: "z", ctrlKey: true, shiftKey: true });
    expect(excalidraw.onKeyDown).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("a board closed before its first sync saves no preview, even from an empty scene", async () => {
    // let anything an earlier test left in flight settle first
    await new Promise((r) => setTimeout(r, 100));
    upload.uploadFile.mockClear();
    const { view } = mount("att-old", undefined, { synced: false });
    await ready();
    act(() => excalidraw.props.onChange([], {}, {}));
    view.unmount();
    await new Promise((r) => setTimeout(r, 50));
    expect(upload.uploadFile).not.toHaveBeenCalled();
  });

  it("a pasted YouTube watch link is pasted again as its canonical embed link, which Excalidraw embeds", async () => {
    const { view } = mount("att-old");
    await ready();
    const pasteSpy = vi.spyOn(document, "dispatchEvent");
    (globalThis as any).DataTransfer ??= class {
      data: Record<string, string> = {};
      setData(t: string, v: string) {
        this.data[t] = v;
      }
      getData(t: string) {
        return this.data[t] ?? "";
      }
    };
    (globalThis as any).ClipboardEvent ??= class extends Event {
      clipboardData: any;
      constructor(type: string, init: any) {
        super(type, init);
        this.clipboardData = init.clipboardData;
      }
    };
    const handled = excalidraw.props.onPaste(
      { text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5" },
      null,
    );
    // Excalidraw's own paste is cancelled; the canonical link is pasted instead
    expect(handled).toBe(false);
    await Promise.resolve();
    const replay = pasteSpy.mock.calls
      .map((c) => c[0])
      .find((e: any) => e.type === "paste") as any;
    expect(replay.clipboardData.getData("text/plain")).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?start=5",
    );
    // and that one is accepted by the strict validator Excalidraw is given
    expect(
      excalidraw.props.validateEmbeddable(
        "https://www.youtube.com/embed/dQw4w9WgXcQ?start=5",
      ),
    ).toBe(true);
    // ordinary text is left to Excalidraw
    expect(excalidraw.props.onPaste({ text: "hello" }, null)).toBe(true);
    pasteSpy.mockRestore();
    view.unmount();
  });
});
