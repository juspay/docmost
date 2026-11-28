import { describe, expect, it } from "vitest";
import { nestedHostFor } from "./live-block-host";

describe("nestedHostFor (a synced block shown on another page)", () => {
  it("on a page, asks for the block as the synced block's source page", () => {
    expect(nestedHostFor({ mode: "page", pageId: "B" }, "A")).toEqual({
      mode: "page",
      pageId: "A",
    });
  });

  it("elsewhere, or without a source page, says the block is not available", () => {
    expect(
      nestedHostFor({ mode: "share", pageId: "B", shareId: "s" }, "A"),
    ).toEqual({ mode: "none" });
    expect(nestedHostFor({ mode: "history", pageId: "B" }, "A")).toEqual({
      mode: "none",
    });
    expect(nestedHostFor({ mode: "page", pageId: "B" }, null)).toEqual({
      mode: "none",
    });
  });
});
