import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const show = vi.fn();
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (s: string) => s }) }));

// stands in for the real picker, which loads spaces and pages from the server
vi.mock("@/components/ui/destination-picker/destination-picker-modal.tsx", () => ({
  DestinationPickerModal: (props: any) =>
    props.opened ? (
      <div>
        <span>{props.title}</span>
        <button onClick={() => props.onSelect({ type: "page", spaceId: "s", pageId: "p", space: {}, page: { slugId: "other12345" } })}>pick other</button>
        <button onClick={() => props.onSelect({ type: "page", spaceId: "s", pageId: "p", space: {}, page: { slugId: "left123456" } })}>pick left</button>
        <button onClick={() => props.onSelect({ type: "space", spaceId: "s", space: {} })}>pick space</button>
      </div>
    ) : null,
}));

import { SplitViewPagePicker } from "./split-view-page-picker";

function Probe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function setup(onClose = vi.fn()) {
  window.matchMedia = ((q: string) => ({
    matches: true, media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  render(
    <MemoryRouter initialEntries={["/s/general/p/left-page-left123456"]}>
      <Routes>
        <Route
          path="/s/:spaceSlug/p/:pageSlug"
          element={<><SplitViewPagePicker opened onClose={onClose} /><Probe /></>}
        />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => show.mockClear());

describe("SplitViewPagePicker", () => {
  it("picking a page sets ?split to its slug and closes the picker", () => {
    const onClose = setup();
    expect(screen.getByText("Open in split view")).toBeTruthy();
    fireEvent.click(screen.getByText("pick other"));
    expect(screen.getByTestId("search").textContent).toBe("?split=other12345");
    expect(onClose).toHaveBeenCalled();
  });

  it("picking the page already on the left keeps the refusal", () => {
    setup();
    fireEvent.click(screen.getByText("pick left"));
    expect(screen.getByTestId("search").textContent).toBe("");
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "This page is already open" }),
    );
  });

  it("picking a space does nothing", () => {
    const onClose = setup();
    fireEvent.click(screen.getByText("pick space"));
    expect(screen.getByTestId("search").textContent).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });
});
