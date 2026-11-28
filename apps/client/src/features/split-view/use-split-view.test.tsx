import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const show = vi.fn();
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...args: unknown[]) => show(...args) },
}));
const paneMode = vi.fn(() => false);
vi.mock("./pane-mode", () => ({ isPaneMode: () => paneMode() }));

import { usePaneMessages, useSplitView } from "./use-split-view";

function setWidth(px: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min ? px >= Number(min[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

function wrapperFor(url: string) {
  return ({ children }: { children: ReactNode }) =>
    createElement(
      MemoryRouter,
      { initialEntries: [url] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/s/:spaceSlug/p/:pageSlug",
          element: children,
        }),
      ),
    );
}

function useBoth() {
  return { split: useSplitView(), location: useLocation() };
}

beforeEach(() => {
  setWidth(1440);
  paneMode.mockReturnValue(false);
  show.mockClear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSplitView", () => {
  it("open sets ?split and close removes it, keeping other parameters", () => {
    const { result } = renderHook(useBoth, {
      wrapper: wrapperFor("/s/general/p/left-aaaaaa?tab=1"),
    });
    act(() => result.current.split.open("bbbbbb"));
    expect(result.current.location.search).toBe("?tab=1&split=bbbbbb");
    expect(result.current.split.splitSlugId).toBe("bbbbbb");
    act(() => result.current.split.close());
    expect(result.current.location.search).toBe("?tab=1");
    expect(result.current.split.splitSlugId).toBeNull();
  });

  it.each([
    "a/b/cdefgh",
    "..%2f..%2fsettings",
    "../settings",
    "abc.def.ghi",
    "%2Fsettings",
    "short",
    "x".repeat(41),
  ])("a ?split value with a slash, dots or an encoded slash is ignored: %s", (value) => {
    const { result } = renderHook(useSplitView, {
      wrapper: wrapperFor(`/s/general/p/left-aaaaaa?split=${encodeURIComponent(value)}`),
    });
    expect(result.current.splitSlugId).toBeNull();
    const raw = renderHook(useSplitView, {
      wrapper: wrapperFor(`/s/general/p/left-aaaaaa?split=${value}`),
    });
    expect(raw.result.current.splitSlugId).toBeNull();
  });

  it("opening the page already on the left is refused", () => {
    const { result } = renderHook(useBoth, {
      wrapper: wrapperFor("/s/general/p/my-page-abcdef123"),
    });
    act(() => result.current.split.open("abcdef123"));
    expect(result.current.location.search).toBe("");
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "This page is already open" }),
    );
  });

  it("ratio is clamped to 0.25 … 0.75", () => {
    const { result } = renderHook(useSplitView, {
      wrapper: wrapperFor("/s/general/p/left-aaaaaa?split=bbbbbb"),
    });
    expect(result.current.ratio).toBe(0.5);
    act(() => result.current.setRatio(0.1));
    expect(result.current.ratio).toBe(0.25);
    act(() => result.current.setRatio(0.95));
    expect(result.current.ratio).toBe(0.75);
    expect(localStorage.getItem("docmost:split-ratio")).toBe("0.75");
    act(() => result.current.setRatio(0.4));
    expect(result.current.ratio).toBe(0.4);
  });

  it("a stored ratio outside the range is clamped on read", () => {
    localStorage.setItem("docmost:split-ratio", "0.99");
    const { result } = renderHook(useSplitView, {
      wrapper: wrapperFor("/s/general/p/left-aaaaaa?split=bbbbbb"),
    });
    expect(result.current.ratio).toBe(0.75);
  });

  it("in pane mode there is no split even when the URL has ?split", () => {
    paneMode.mockReturnValue(true);
    const { result } = renderHook(useSplitView, {
      wrapper: wrapperFor("/s/general/p/left-aaaaaa?split=bbbbbb"),
    });
    expect(result.current.splitSlugId).toBeNull();
    expect(result.current.available).toBe(false);
  });

  it("below 1024px there is no split", () => {
    setWidth(900);
    const { result } = renderHook(useSplitView, {
      wrapper: wrapperFor("/s/general/p/left-aaaaaa?split=bbbbbb"),
    });
    expect(result.current.splitSlugId).toBeNull();
    expect(result.current.available).toBe(false);
  });
});

describe("usePaneMessages", () => {
  const frame = { contentWindow: window } as unknown as HTMLIFrameElement;

  function post(data: unknown, origin = window.location.origin) {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source: window }));
    });
  }

  function useBothMessages() {
    usePaneMessages({ current: frame });
    return useLocation();
  }

  it("a pane auth-expired message makes the parent navigate to login", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      pathname: "/s/general/p/left-aaaaaa",
      search: "?split=bbbbbb",
      hash: "",
      assign,
    });
    renderHook(useBothMessages, {
      wrapper: wrapperFor("/s/general/p/left-aaaaaa?split=bbbbbb"),
    });
    post({ type: "docmost:pane-auth-expired" });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0][0]).toMatch(/^\/login\?redirect=/);
  });

  it("an auth-expired message from another origin does nothing", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    renderHook(useBothMessages, { wrapper: wrapperFor("/s/general/p/left-aaaaaa") });
    post({ type: "docmost:pane-auth-expired" }, "https://evil.example");
    expect(assign).not.toHaveBeenCalled();
  });

  it("a location message rewrites ?split= with replace", () => {
    const { result } = renderHook(useBothMessages, {
      wrapper: wrapperFor("/s/general/p/left-aaaaaa?split=bbbbbb"),
    });
    post({
      type: "docmost:pane-location",
      pathname: "/s/general/p/next-cccccc",
      slugId: "cccccc",
    });
    expect(result.current.search).toBe("?split=cccccc");
  });

  it("a location message with an invalid slug is ignored", () => {
    const { result } = renderHook(useBothMessages, {
      wrapper: wrapperFor("/s/general/p/left-aaaaaa?split=bbbbbb"),
    });
    post({
      type: "docmost:pane-location",
      pathname: "/settings",
      slugId: "../settings",
    });
    expect(result.current.search).toBe("?split=bbbbbb");
  });
});
