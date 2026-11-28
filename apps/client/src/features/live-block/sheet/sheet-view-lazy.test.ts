import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("sheet view loading", () => {
  it("the editor registers the lazy sheet view, so pages without a sheet do not load it", () => {
    const source = readFileSync(
      resolve(__dirname, "../../editor/extensions/extensions.ts"),
      "utf8",
    );
    expect(source).toContain("live-block/sheet/sheet-view-lazy");
    expect(source).not.toMatch(/live-block\/sheet\/sheet-view\.tsx/);
  });
});
