import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock("./pane-mode", () => ({ isPaneMode: () => false }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));

import { SplitLayout } from "./split-layout";
import { useSplitView } from "./use-split-view";

let api: { nav: ReturnType<typeof useNavigate>; loc: ReturnType<typeof useLocation>; split: ReturnType<typeof useSplitView> };
function Probe() {
  api = { nav: useNavigate(), loc: useLocation(), split: useSplitView() };
  return null;
}

function wide() {
  window.matchMedia = ((q: string) => ({
    matches: true, media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const replace = vi.fn();
let paneHref = "/s/general/p/pane-page-bbbbbb";

beforeEach(() => {
  wide();
  replace.mockClear();
  paneHref = "/s/general/p/pane-page-bbbbbb";
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get() {
      return { location: { get pathname() { return paneHref; }, replace } };
    },
  });
});

afterEach(() => {
  delete (HTMLIFrameElement.prototype as any).contentWindow;
});

function mount(url: string) {
  render(
    <MantineProvider>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/s/:spaceSlug/p/:pageSlug"
            element={<SplitLayout><Probe /></SplitLayout>}
          />
          <Route path="/home" element={<SplitLayout><Probe /></SplitLayout>} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
}

const frame = () => document.querySelector("iframe");

describe("SplitLayout", () => {
  it("renders the pane for a valid ?split", () => {
    mount("/s/general/p/left-page-aaaaaa?split=bbbbbb");
    expect(frame()?.getAttribute("src")).toBe("/p/bbbbbb");
    expect(frame()?.getAttribute("data-docmost-pane")).toBe("1");
  });

  it("left navigation restores ?split and keeps the same pane", () => {
    mount("/s/general/p/left-page-aaaaaa?split=bbbbbb");
    const before = frame();
    act(() => api.nav("/s/general/p/other-page-cccccc"));
    expect(api.loc.pathname).toBe("/s/general/p/other-page-cccccc");
    expect(api.loc.search).toBe("?split=bbbbbb");
    expect(frame()).toBe(before);
  });

  it("close does not restore it, and left navigation afterwards stays unsplit", () => {
    mount("/s/general/p/left-page-aaaaaa?split=bbbbbb");
    act(() => screen.getByLabelText("Close split view").click());
    expect(api.loc.search).toBe("");
    expect(frame()).toBeNull();
    act(() => api.nav("/s/general/p/other-page-cccccc"));
    expect(api.loc.search).toBe("");
    expect(frame()).toBeNull();
  });

  it("a close that leaves the URL unchanged does not poison the next open", () => {
    mount("/s/general/p/left-page-aaaaaa?split=bbbbbb");
    // the URL lost ?split on its own and the kept pane was closed meanwhile
    act(() => api.nav("/s/general/p/left-page-aaaaaa"));
    act(() => screen.getByLabelText("Close split view").click());
    act(() => api.nav("/s/general/p/left-page-aaaaaa")); // URL unchanged
    act(() => api.split.open("dddddd"));
    expect(api.loc.search).toBe("?split=dddddd");
    act(() => api.nav("/s/general/p/other-page-cccccc"));
    expect(api.loc.search).toBe("?split=dddddd");
    expect(frame()).not.toBeNull();
  });

  it("browser Back to the entry before the split closes it", () => {
    mount("/s/general/p/left-page-aaaaaa");
    act(() => api.nav("/s/general/p/left-page-aaaaaa?split=bbbbbb"));
    expect(frame()).not.toBeNull();
    act(() => api.nav(-1));
    expect(api.loc.search).toBe("");
    expect(frame()).toBeNull();
    // and a later left navigation does not bring it back
    act(() => api.nav("/s/general/p/other-page-cccccc"));
    expect(api.loc.search).toBe("");
  });

  it("leaving page routes ends the split", () => {
    mount("/s/general/p/left-page-aaaaaa?split=bbbbbb");
    act(() => api.nav("/home"));
    expect(frame()).toBeNull();
    act(() => api.nav("/s/general/p/left-page-aaaaaa"));
    expect(api.loc.search).toBe("");
  });

  it("an external open calls replace only when the pane is not already on that page", () => {
    mount("/s/general/p/left-page-aaaaaa?split=bbbbbb");
    act(() => api.split.open("cccccc"));
    expect(replace).toHaveBeenCalledWith("/p/cccccc");
    replace.mockClear();
    // the pane followed a link itself and reports the new page: no reload
    paneHref = "/s/general/p/next-page-eeeeee";
    act(() => api.split.open("eeeeee"));
    expect(replace).not.toHaveBeenCalled();
  });
});
