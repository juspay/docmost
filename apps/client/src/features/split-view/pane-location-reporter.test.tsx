import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paneMode = vi.fn(() => true);
vi.mock("./pane-mode", () => ({ isPaneMode: () => paneMode() }));

import { PaneLocationReporter } from "./pane-location-reporter";

const post = vi.fn();
const assign = vi.fn();

beforeEach(() => {
  paneMode.mockReturnValue(true);
  post.mockClear();
  assign.mockClear();
  vi.stubGlobal("parent", { postMessage: post, location: { assign } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PaneLocationReporter />
    </MemoryRouter>,
  );
}

describe("PaneLocationReporter", () => {
  it("reports a page route to the parent with its slug id", () => {
    renderAt("/s/general/p/my-title-abcdef123");
    expect(post).toHaveBeenCalledWith(
      {
        type: "docmost:pane-location",
        pathname: "/s/general/p/my-title-abcdef123",
        slugId: "abcdef123",
      },
      window.location.origin,
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("a non-page navigation in pane mode is handed to the parent window", () => {
    renderAt("/settings/account/profile?x=1#top");
    expect(assign).toHaveBeenCalledWith("/settings/account/profile?x=1#top");
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["//evil.example/x", "//evil.example"])(
    "never hands a protocol-relative path to the parent: %s",
    (path) => {
      renderAt(path);
      expect(assign).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("does nothing outside pane mode", () => {
    paneMode.mockReturnValue(false);
    renderAt("/settings/account/profile");
    expect(assign).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
