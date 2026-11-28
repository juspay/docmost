import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { HocuspocusContext } from "@hocuspocus/provider-react";
import { pushElements } from "@docmost/live-blocks";
import { PageCollabSocket } from "@/features/editor/collab-socket";
import { LiveBlockRoom } from "../components/live-block-room";
import WhiteboardCanvas from "./whiteboard-canvas";
import { readPreviewMeta, sceneFingerprint } from "./whiteboard-preview";

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
  initReactI18next: { type: "3rdParty", init: () => undefined },
}));

const rect = (id: string, version: number) => ({
  id,
  version,
  versionNonce: 0,
  type: "rectangle",
  index: `a${id}`,
  isDeleted: false,
});

vi.mock("@/lib/config.ts", () => ({
  getCollaborationUrl: () => "ws://localhost",
}));
vi.mock("@/features/user/hooks/use-current-user", () => ({
  default: () => ({
    data: { user: { id: "u1", name: "Ada", workspaceId: "w" } },
  }),
}));
vi.mock("@/features/auth/queries/auth-query.tsx", () => ({
  useCollabToken: () => ({
    data: { token: "t" },
    refetch: async () => ({ data: { token: "t" } }),
  }),
}));
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

const BLOCK = "0193c7a0-1111-7abc-8def-0000000000bb";
let socket: PageCollabSocket;
afterEach(() => socket?.destroy());

describe("whiteboard preview with the real block room", () => {
  it("a viewer who only looked at a changed board saves the preview record before the provider goes", async () => {
    socket = new PageCollabSocket({
      url: "ws://localhost",
      autoConnect: false,
    });
    let ctxSeen: any = null;
    const nodeProps: any = {
      node: {
        attrs: { attachmentId: "att-old", src: "/api/files/att-old/w.svg" },
      },
      updateAttributes: vi.fn(),
    };
    const view = render(
      <MantineProvider>
        <HocuspocusContext.Provider
          value={{ websocketProvider: socket } as any}
        >
          <LiveBlockRoom blockId={BLOCK} canEdit>
            {(room) => {
              ctxSeen = room;
              return (
                <WhiteboardCanvas
                  ctx={{
                    ...room,
                    blockId: BLOCK,
                    pageId: "page-1",
                    opened: true,
                  }}
                  nodeProps={nodeProps}
                />
              );
            }}
          </LiveBlockRoom>
        </HocuspocusContext.Provider>
      </MantineProvider>,
    );
    await waitFor(() =>
      expect(excalidraw.props?.onChange).toBeTypeOf("function"),
    );
    const { provider, doc } = ctxSeen;
    // the server's state arrives: someone else drew since the stored preview
    const scene = [
      {
        id: "r",
        type: "rectangle",
        version: 4,
        versionNonce: 0,
        index: "a0",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    ];
    act(() => {
      pushElements(doc, scene as any, provider);
      provider.synced = true;
    });
    act(() => excalidraw.props.onChange(scene, {}, {}));
    const destroy = vi.spyOn(provider, "destroy");
    let metaWhenDestroyed: unknown = "not destroyed";
    destroy.mockImplementation(() => {
      metaWhenDestroyed = readPreviewMeta(doc);
    });
    // this person drew nothing: their provider is clean
    view.unmount();
    await waitFor(() => expect(upload.uploadFile).toHaveBeenCalledTimes(1));
    // the record is written to the live document, which then waits for the server
    await waitFor(() =>
      expect(readPreviewMeta(doc)).toEqual({
        scene: sceneFingerprint(scene as any),
        attachmentId: "att-old",
      }),
    );
    expect(metaWhenDestroyed).toBe("not destroyed");
    act(() => {
      (socket as any).status = "connected";
      provider.authenticatedHandler("read-write");
      provider.unsyncedChanges = 1;
      provider.decrementUnsyncedChanges();
    });
    expect(metaWhenDestroyed).toEqual({
      scene: sceneFingerprint(scene as any),
      attachmentId: "att-old",
    });
  });
});
