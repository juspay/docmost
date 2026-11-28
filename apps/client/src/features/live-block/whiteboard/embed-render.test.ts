import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalEmbedLink } from "@docmost/live-blocks";

// Excalidraw picks an embed renderer by unanchored patterns over the whole
// link; check that every link the board accepts reaches a plain frame.
async function excalidrawGetEmbedLink() {
  const require = createRequire(import.meta.url);
  const main = require.resolve("@excalidraw/excalidraw");
  const root = main.slice(
    0,
    main.lastIndexOf(`${path.sep}excalidraw${path.sep}dist`),
  );
  const mod = await import(
    /* @vite-ignore */ pathToFileURL(
      path.join(root, "element/dist/dev/index.js"),
    ).href
  );
  return mod.getEmbedLink as (link: string) => any;
}

describe("accepted embed links in the installed Excalidraw", () => {
  it("are rendered as a video or Figma frame, never a srcdoc document", async () => {
    const getEmbedLink = await excalidrawGetEmbedLink();
    // the reviewer's link is refused before Excalidraw sees it
    expect(
      canonicalEmbedLink("https://www.youtube.com/?twitter.com/x/status/1"),
    ).toBeNull();
    expect(
      getEmbedLink("https://www.youtube.com/?twitter.com/x/status/1").type,
    ).toBe("document");
    for (const input of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42#twitter.com/x/status/1",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/playlist?list=PLabcdefghij123",
      "https://player.vimeo.com/video/76979871",
      "https://www.figma.com/design/AbCdEfGhIj1234567890/x",
    ]) {
      const link = canonicalEmbedLink(input)!;
      const embed = getEmbedLink(link);
      if (link.includes("list="))
        expect(embed.link).toContain("list=PLabcdefghij123");
      expect([link, embed.type]).toEqual([
        link,
        link.includes("figma") ? "generic" : "video",
      ]);
      expect(embed.srcdoc).toBeUndefined();
    }
  });
});
