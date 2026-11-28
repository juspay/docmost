import { describe, expect, it } from "vitest";
import { safePeerColor } from "./peer-color";

describe("safePeerColor", () => {
  it("keeps plain colours and replaces anything else with a neutral one", () => {
    expect(safePeerColor("#958DF1")).toBe("#958DF1");
    expect(safePeerColor("#abc")).toBe("#abc");
    expect(safePeerColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    for (const bad of [
      "url(https://example.invalid/x.png)",
      "red;background:url(x)",
      "#12345g",
      "",
      undefined,
      42,
    ]) {
      expect(safePeerColor(bad)).toBe("#868e96");
    }
  });
});
