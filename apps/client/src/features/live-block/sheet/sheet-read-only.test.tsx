import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { sheet as S, type SheetSnapshot } from "@docmost/live-blocks";
import SheetReadOnly from "./sheet-read-only";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as any;
});

const NOTICE = "This table is too large to show in full";

function snapshotOf(truncated: boolean): SheetSnapshot {
  const book = S.createEmptyBook();
  S.setCellRaw(book.sheets[0], 0, 0, "x");
  return { kind: "sheet", book, display: {}, truncated };
}

function show(snapshot: SheetSnapshot) {
  render(
    <MantineProvider>
      <SheetReadOnly snapshot={snapshot} height={300} />
    </MantineProvider>,
  );
}

describe("SheetReadOnly", () => {
  it("says when the table is too large to show in full", () => {
    show(snapshotOf(true));
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it("says nothing for a complete table", () => {
    show(snapshotOf(false));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
