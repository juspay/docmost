import { afterEach, describe, expect, it, vi } from "vitest";
import { isPaneMode } from "./pane-mode";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPaneMode", () => {
  it("isPaneMode is false in a top-level window", () => {
    expect(isPaneMode()).toBe(false);
  });

  it("isPaneMode is true when the frame element carries data-docmost-pane", () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("data-docmost-pane", "1");
    vi.stubGlobal("frameElement", frame);
    expect(isPaneMode()).toBe(true);
  });

  it("isPaneMode is false for a frame without the attribute", () => {
    vi.stubGlobal("frameElement", document.createElement("iframe"));
    expect(isPaneMode()).toBe(false);
  });

  it("isPaneMode is false when reading frameElement throws", () => {
    vi.stubGlobal("window", {
      get frameElement() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(isPaneMode()).toBe(false);
  });
});
