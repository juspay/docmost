import { afterEach, describe, expect, it, vi } from "vitest";
import { isAttachmentId, loadBoardImage } from "./whiteboard-files";

vi.mock("@/features/page/services/page-service.ts", () => ({
  uploadFile: vi.fn(),
}));

const ID = "0193c7a0-1111-7abc-8def-0000000000aa";

afterEach(() => vi.unstubAllGlobals());

describe("loadBoardImage", () => {
  it("accepts only a uuid as a file reference", () => {
    expect(isAttachmentId(ID)).toBe(true);
    for (const bad of [
      "../users/me?",
      `${ID}/../../x`,
      "",
      "x",
      `${ID}?a=1`,
      5 as any,
    ]) {
      expect(isAttachmentId(bad)).toBe(false);
    }
  });

  it("never sends a request for a reference that is not a uuid", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(loadBoardImage("../api/users/me?")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a response that is not an image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(loadBoardImage(ID)).rejects.toThrow();
  });

  it("loads an image by its uuid", async () => {
    const fetch = vi.fn(
      async (_url: string) =>
        new Response(new Uint8Array([1, 2]), {
          headers: { "content-type": "image/png" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await loadBoardImage(ID)).toMatch(/^data:image\/png;base64,/);
    expect(fetch.mock.calls[0][0]).toBe(`/api/files/${ID}/image`);
  });
});
