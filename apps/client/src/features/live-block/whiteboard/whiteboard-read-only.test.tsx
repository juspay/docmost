import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { LiveBlockHostProvider } from "../live-block-host";
import WhiteboardReadOnly from "./whiteboard-read-only";

const scenes = vi.hoisted(() => ({ mounts: [] as string[][] }));
vi.mock("@excalidraw/excalidraw/index.css", () => ({}));
vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: (props: any) => {
    // like Excalidraw: initialData is read once, when the scene mounts
    const [ids] = React.useState(() =>
      props.initialData.elements.map((e: any) => e.id),
    );
    return <div data-testid="scene">{ids.join(",")}</div>;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
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

const el = (id: string) => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  version: 1,
});
const snap = (...ids: string[]) =>
  ({ kind: "whiteboard", elements: ids.map(el), files: {} }) as any;

function view(props: any) {
  return (
    <MantineProvider>
      <LiveBlockHostProvider host={{ mode: "page", pageId: "p" }}>
        <WhiteboardReadOnly
          node={{ attrs: props.attrs ?? {} } as any}
          snapshot={props.snapshot}
          local={props.local}
        />
      </LiveBlockHostProvider>
    </MantineProvider>
  );
}

describe("WhiteboardReadOnly", () => {
  it("shows a newer scene when the snapshot changes", async () => {
    const r = render(view({ snapshot: snap("a") }));
    await waitFor(() =>
      expect(screen.getByTestId("scene").textContent).toBe("a"),
    );
    r.rerender(view({ snapshot: snap("a", "b", "c") }));
    await waitFor(() =>
      expect(screen.getByTestId("scene").textContent).toBe("a,b,c"),
    );
  });

  it("a local copy with unsaved edits is drawn instead of the saved preview image", async () => {
    render(
      view({
        snapshot: snap("a", "b"),
        local: true,
        attrs: { src: "/api/files/x/w.svg" },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("scene").textContent).toBe("a,b"),
    );
    expect(document.querySelector("img[data-whiteboard-preview]")).toBeNull();
  });
});
