import { beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { LiveBlockFrame } from "./live-block-frame";
import { LiveBlockHostProvider } from "../live-block-host";

const A = "0193c7a0-1111-7abc-8def-00000000000a";
const roomMounts: string[] = [];

const retry = vi.fn();
const saveState = {
  unsaved: false,
  dirty: false,
  offline: false,
  authFailed: false,
};
const local = vi.hoisted(() => ({ snapshot: null as any }));
const retryBlockSave = vi.hoisted(() => vi.fn());
vi.mock("./block-provider-registry", () => ({ retryBlockSave }));
vi.mock("./use-block-save-state", () => ({
  useBlockSaveState: () => ({ ...saveState }),
  useLocalBlockSnapshot: () => local.snapshot,
}));
const hookState = vi.hoisted(() => ({
  snapshotState: "ready" as string,
  updatedAt: undefined as string | undefined,
  status: "ready" as string,
}));
vi.mock("../hooks/use-live-block", () => ({
  useLiveBlock: () => ({
    status: hookState.status,
    blockId: A,
    pageId: "page-1",
    retry,
    replaceWithEmpty: vi.fn(),
    snapshot:
      hookState.snapshotState === "ready"
        ? { kind: "whiteboard", elements: [], files: {} }
        : undefined,
    snapshotState: hookState.snapshotState,
    snapshotUpdatedAt: hookState.updatedAt,
  }),
}));
vi.mock("./live-block-room", () => ({
  LiveBlockRoom: ({ blockId, children }: any) => {
    roomMounts.push(blockId);
    return children({
      doc: {},
      provider: {},
      synced: true,
      readOnly: false,
      peers: [],
      registerFlush: () => () => undefined,
    });
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));

beforeAll(() => {
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
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).IntersectionObserver ??= class {
    constructor(private cb: any) {}
    observe(el: Element) {
      this.cb([{ isIntersecting: true, target: el }]);
    }
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => undefined;
});

function renderFrame(
  url: string,
  renderOpened: () => React.ReactNode = () => <div>opened view</div>,
  host: any = { mode: "page", pageId: "page-1" },
) {
  const nodeProps: any = {
    node: { attrs: { blockId: A, title: "Plan", height: null } },
    editor: {
      isEditable: true,
      storage: {},
      view: { dom: document.createElement("div") },
      on: vi.fn(),
      off: vi.fn(),
    },
    updateAttributes: vi.fn(),
    deleteNode: vi.fn(),
    selected: false,
  };
  const tree = (props: any) => (
    <MantineProvider>
      <MemoryRouter initialEntries={[url]}>
        <LiveBlockHostProvider host={host}>
          <LiveBlockFrame
            nodeProps={props}
            kind="whiteboard"
            icon={null}
            liveWhen="opened"
            renderInline={() => <div>inline</div>}
            renderOpened={renderOpened}
            renderReadOnly={(snap: any) => (
              <div>preview {snap?.elements?.length ?? "none"}</div>
            )}
          />
        </LiveBlockHostProvider>
      </MemoryRouter>
    </MantineProvider>
  );
  const view: any = render(tree(nodeProps));
  view.nodeProps = nodeProps;
  view.tree = tree;
  return view;
}

describe("LiveBlockFrame", () => {
  it("opens full-window when the URL carries ?block=", async () => {
    roomMounts.length = 0;
    renderFrame(`/s/x/p/y?block=${A}`);
    expect(await screen.findByText("opened view")).toBeTruthy();
    expect(roomMounts).toContain(A);
  });

  it('with liveWhen "opened", no room is mounted until Open is pressed', async () => {
    roomMounts.length = 0;
    renderFrame("/s/x/p/y");
    expect(screen.getByText(/^preview/)).toBeTruthy();
    expect(roomMounts).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("opened view")).toBeTruthy();
    expect(roomMounts).toContain(A);
  });

  it("Cmd/Ctrl+Z in the full-window view reaches the board and not the page editor", async () => {
    const onBoardKey = vi.fn();
    const pageEditorKey = vi.fn();
    // the page editor (ProseMirror) listens on its own DOM, which holds the node view
    const pageEditorDom = document.createElement("div");
    pageEditorDom.addEventListener("keydown", pageEditorKey);
    document.body.appendChild(pageEditorDom);
    renderFrame(`/s/x/p/y?block=${A}`, () => (
      <div data-testid="board" tabIndex={0} onKeyDown={onBoardKey}>
        opened view
      </div>
    ));
    const board = await screen.findByTestId("board");
    // the frame itself rendered inside the page editor's DOM
    const frame = document.querySelector("[data-live-block]")!;
    pageEditorDom.appendChild(
      frame.closest("[data-node-view-wrapper]") ?? frame,
    );
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { ctrlKey: true, shiftKey: true },
    ]) {
      fireEvent.keyDown(board, { key: "z", ...init });
    }
    expect(onBoardKey).toHaveBeenCalledTimes(3);
    expect(pageEditorKey).not.toHaveBeenCalled();
    pageEditorDom.remove();
  });

  it("the block's controls are kept from the page editor, and closing the full window returns focus to the block", async () => {
    const pageEditor = document.createElement("div");
    pageEditor.tabIndex = 0;
    document.body.appendChild(pageEditor);
    pageEditor.focus();
    const view = renderFrame(`/s/x/p/y?block=${A}`);
    expect(await screen.findByText("opened view")).toBeTruthy();
    // the header's buttons and the body are outside the page editor's reach
    const frame = document.querySelector("[data-live-block]")!;
    const body = frame.querySelector("[data-live-block-body]")!;
    expect(body.hasAttribute("data-live-block-controls")).toBe(true);
    const open = frame.querySelector("[data-live-block-header-controls]")!;
    expect(open.hasAttribute("data-live-block-controls")).toBe(true);
    fireEvent.click(document.querySelector(".mantine-Modal-close")!);
    await waitFor(() => expect(screen.queryByText("opened view")).toBeNull());
    // not the page editor (with the block selected), so Ctrl+Z stays with the block
    await waitFor(() => expect(document.activeElement).toBe(body));
    view.unmount();
    pageEditor.remove();
  });

  it("inside page history a block says it shows the current content", () => {
    renderFrame("/s/x/p/y", undefined, { mode: "history", pageId: "page-1" });
    expect(screen.getByText("Current content")).toBeTruthy();
  });

  it("on the page itself there is no such label", () => {
    renderFrame("/s/x/p/y");
    expect(screen.queryByText("Current content")).toBeNull();
  });

  it("a title change from someone else does not overwrite the title being typed", () => {
    const view = renderFrame("/s/x/p/y");
    const input = screen.getByLabelText("Title") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "My half-typed tit" } });
    // the node's title changes underneath (another editor renamed it)
    const props = (view as any).nodeProps;
    props.node = { attrs: { ...props.node.attrs, title: "Their title" } };
    view.rerender((view as any).tree(props));
    expect(input.value).toBe("My half-typed tit");
    fireEvent.blur(input);
    expect(props.updateAttributes).toHaveBeenCalledWith({
      title: "My half-typed tit",
    });
  });

  it("a block whose offline edits were just saved reloads its content view", () => {
    retry.mockClear();
    Object.assign(saveState, { unsaved: true, offline: true, dirty: true });
    const view = renderFrame("/s/x/p/y");
    expect(screen.getByText("Not saved yet")).toBeTruthy();
    expect(retry).not.toHaveBeenCalled();
    Object.assign(saveState, { unsaved: false, offline: false, dirty: false });
    view.rerender(view.tree(view.nodeProps));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Not saved yet")).toBeNull();
    view.unmount();
  });

  it("an ordinary save, or a reconnect with nothing pending, does not refetch", () => {
    retry.mockClear();
    // a slow edit: unsaved after 2 s while online, then acknowledged
    Object.assign(saveState, { unsaved: true, offline: false, dirty: true });
    const view = renderFrame("/s/x/p/y");
    Object.assign(saveState, { unsaved: false, dirty: false });
    view.rerender(view.tree(view.nodeProps));
    // a reconnect with no edits
    Object.assign(saveState, { unsaved: true, offline: true, dirty: false });
    view.rerender(view.tree(view.nodeProps));
    Object.assign(saveState, { unsaved: false, offline: false });
    view.rerender(view.tree(view.nodeProps));
    expect(retry).not.toHaveBeenCalled();
    view.unmount();
  });

  it("the block body keeps a visible keyboard focus ring", () => {
    const css = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "live-block-frame.module.css"),
      "utf8",
    );
    expect(css).not.toMatch(/\.body:focus\s*\{\s*outline:\s*none/);
    expect(css).toMatch(/\.body:focus-visible/);
  });

  it("offline with a local copy: the board is drawn from it, not a load error", () => {
    hookState.snapshotState = "error";
    Object.assign(saveState, { unsaved: true, offline: true, dirty: true });
    local.snapshot = {
      kind: "whiteboard",
      elements: [{ id: "a" }, { id: "b" }],
      files: {},
    };
    const view = renderFrame("/s/x/p/y");
    expect(screen.queryByText("This block could not be loaded")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByText("preview 2")).toBeTruthy();
    view.unmount();
  });

  it("offline with nothing held locally: a calm message, no error and no Retry", () => {
    hookState.snapshotState = "error";
    Object.assign(saveState, { unsaved: true, offline: true, dirty: false });
    local.snapshot = null;
    const view = renderFrame("/s/x/p/y");
    expect(screen.queryByText("This block could not be loaded")).toBeNull();
    expect(screen.getByText(/You're offline/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    view.unmount();
  });

  it("a real failure while online with nothing held locally still offers Retry", () => {
    hookState.snapshotState = "error";
    Object.assign(saveState, { unsaved: false, offline: false, dirty: false });
    local.snapshot = null;
    const view = renderFrame("/s/x/p/y");
    expect(screen.getByText("This block could not be loaded")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    view.unmount();
    hookState.snapshotState = "ready";
  });

  it("after offline edits are saved, the kept view stays until the server's copy is newer", () => {
    hookState.snapshotState = "ready";
    hookState.updatedAt = new Date(Date.now() - 60_000).toISOString();
    Object.assign(saveState, { unsaved: true, offline: true, dirty: true });
    local.snapshot = {
      kind: "whiteboard",
      elements: [{ id: "a" }, { id: "b" }, { id: "c" }],
      files: {},
    };
    const view = renderFrame("/s/x/p/y");
    expect(screen.getByText("preview 3")).toBeTruthy();
    // saved: the provider goes, the stored snapshot is still the old one
    Object.assign(saveState, { unsaved: false, offline: false, dirty: false });
    local.snapshot = null;
    view.rerender(view.tree(view.nodeProps));
    expect(screen.getByText("preview 3")).toBeTruthy();
    // the server has stored the edits
    hookState.updatedAt = new Date(Date.now() + 1_000).toISOString();
    view.rerender(view.tree(view.nodeProps));
    expect(screen.getByText("preview 0")).toBeTruthy();
    view.unmount();
    hookState.updatedAt = undefined;
  });

  it("a block that stopped saving says so persistently, with Try again", () => {
    Object.assign(saveState, {
      unsaved: false,
      noAccess: true,
      notSaving: true,
      dirty: true,
    });
    const view = renderFrame("/s/x/p/y");
    expect(
      screen.getByText("Changes to this block are not being saved"),
    ).toBeTruthy();
    expect(screen.queryByText("Not saved yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retryBlockSave).toHaveBeenCalledWith(`block.${A}`);
    view.unmount();
    Object.assign(saveState, {
      noAccess: false,
      notSaving: false,
      dirty: false,
    });
  });

  it("the badge never says saved: it says where unsent edits are kept", async () => {
    Object.assign(saveState, {
      unsaved: true,
      offline: true,
      dirty: true,
      storedLocally: true,
    });
    const view = renderFrame("/s/x/p/y");
    expect(screen.getByText("Not saved yet")).toBeTruthy();
    fireEvent.mouseEnter(screen.getByText("Not saved yet"));
    expect(await screen.findByText(/kept on this device/)).toBeTruthy();
    view.unmount();
    Object.assign(saveState, {
      unsaved: true,
      offline: true,
      dirty: true,
      storedLocally: false,
    });
    const memoryOnly = renderFrame("/s/x/p/y");
    fireEvent.mouseEnter(screen.getByText("Not saved yet"));
    expect(await screen.findByText(/Keep this tab open/)).toBeTruthy();
    memoryOnly.unmount();
    Object.assign(saveState, {
      unsaved: false,
      offline: false,
      dirty: false,
      storedLocally: false,
    });
  });

  it("edits refused for good are reported in the block's own save-state area", () => {
    Object.assign(saveState, {
      unsaved: false,
      noAccess: true,
      lost: true,
      dirty: false,
    });
    const view = renderFrame("/s/x/p/y");
    expect(screen.getByText("Changes not saved")).toBeTruthy();
    expect(screen.queryByText("Not saved yet")).toBeNull();
    view.unmount();
    Object.assign(saveState, { noAccess: false, lost: false });
  });

  it("the read-only rendering also shows Changes not saved when a stored copy was dropped", () => {
    hookState.status = "read-only";
    Object.assign(saveState, {
      unsaved: false,
      noAccess: true,
      lost: true,
      dirty: false,
    });
    const view = renderFrame("/s/x/p/y");
    expect(screen.getByText("Changes not saved")).toBeTruthy();
    view.unmount();
    Object.assign(saveState, { noAccess: false, lost: false });
    const clean = renderFrame("/s/x/p/y");
    expect(screen.queryByText("Changes not saved")).toBeNull();
    clean.unmount();
    hookState.status = "ready";
  });

  it("edits kept on the device after a read-only answer are shown as not saved and kept, never as lost", async () => {
    hookState.status = "read-only";
    Object.assign(saveState, {
      unsaved: false,
      noAccess: true,
      lost: false,
      keptOnDevice: true,
    });
    const view = renderFrame("/s/x/p/y");
    expect(screen.getByText("Not saved, kept on this device")).toBeTruthy();
    expect(screen.queryByText("Changes not saved")).toBeNull();
    expect(screen.queryByText("Not saved yet")).toBeNull();
    fireEvent.mouseEnter(screen.getByText("Not saved, kept on this device"));
    expect(
      await screen.findByText(/You cannot edit this block right now/),
    ).toBeTruthy();
    view.unmount();
    Object.assign(saveState, { noAccess: false, keptOnDevice: false });
    hookState.status = "ready";
  });
});
