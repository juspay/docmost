import { describe, expect, it } from "vitest";
import { formatStyle } from "./grid-cell";

const EVIL = "left;position:fixed;inset:0;background:url(https://evil/x)";

describe("cell formats as styles", () => {
  it("a hostile align, valign, colour or font never becomes CSS", () => {
    const style = formatStyle({
      align: EVIL,
      valign: EVIL,
      color: EVIL,
      bg: EVIL,
      font: EVIL,
      bold: true,
      borders: { top: { style: "thin", color: EVIL } },
    } as any);
    const css = JSON.stringify(style);
    expect(css).not.toMatch(/position|fixed|url\(|evil/);
    expect(style).toMatchObject({ fontWeight: "600" });
  });

  it("known values still style the cell", () => {
    expect(
      formatStyle({ align: "center", bg: "#ffec99", color: "#c92a2a" }),
    ).toMatchObject({
      textAlign: "center",
      justifyContent: "center",
      background: "#ffec99",
      color: "#c92a2a",
    });
  });
});
