import { describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ dropPage: vi.fn(async () => 1) }));
vi.mock("./block-provider-registry", () => ({
  discardStoredBlocksOfPage: registry.dropPage,
}));
const pageService = vi.hoisted(() => ({ getPageById: vi.fn() }));
vi.mock("@/features/page/services/page-service", () => pageService);
import { dropBlocksOfRefusedPage } from "./page-refusal";

const refusal = (status: number, data: unknown) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

describe("a page refused for good drops its blocks' stored copies", () => {
  it("only on the app server's own 403 or 404 body (M1)", async () => {
    const cases: [string, unknown, boolean][] = [
      [
        "nest 404",
        refusal(404, {
          statusCode: 404,
          message: "Page not found",
          error: "Not Found",
        }),
        true,
      ],
      [
        "nest 403",
        refusal(403, { statusCode: 403, message: "Forbidden" }),
        true,
      ],
      ["bare 403 (WAF page)", refusal(403, "<html>challenge</html>"), false],
      [
        "bare 404",
        refusal(404, { message: "Cannot POST /api/pages/info" }),
        false,
      ],
      [
        "workspace not found",
        refusal(404, { statusCode: 404, message: "Workspace not found" }),
        false,
      ],
      ["500", refusal(500, { statusCode: 500, message: "x" }), false],
      ["network", new Error("Network Error"), false],
    ];
    for (const [label, err, drops] of cases) {
      registry.dropPage.mockClear();
      pageService.getPageById.mockReset();
      pageService.getPageById.mockRejectedValue(err);
      await dropBlocksOfRefusedPage("page-1", "u1");
      expect([label, registry.dropPage.mock.calls]).toEqual([
        label,
        drops ? [["page-1", "u1"]] : [],
      ]);
    }
  });

  it("not when the page answers normally", async () => {
    registry.dropPage.mockClear();
    pageService.getPageById.mockResolvedValue({ id: "page-1" });
    await dropBlocksOfRefusedPage("page-1", "u1");
    expect(registry.dropPage).not.toHaveBeenCalled();
  });

  it("does nothing without a user", async () => {
    registry.dropPage.mockClear();
    await dropBlocksOfRefusedPage("page-1", undefined);
    expect(registry.dropPage).not.toHaveBeenCalled();
  });

  it("never throws into the page editor", async () => {
    pageService.getPageById.mockRejectedValue(
      refusal(404, { statusCode: 404, message: "Page not found" }),
    );
    registry.dropPage.mockRejectedValueOnce(new Error("idb"));
    await expect(
      dropBlocksOfRefusedPage("page-1", "u1"),
    ).resolves.toBeUndefined();
  });
});
