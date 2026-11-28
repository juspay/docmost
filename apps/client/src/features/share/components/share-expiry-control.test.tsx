import { MantineProvider } from "@mantine/core";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import ShareExpiryControl from "./share-expiry-control.tsx";
import ShareList from "./share-list.tsx";
import ShareActionMenu from "./share-action-menu.tsx";
import {
  renewShareExpiry,
  setShareExpiry,
} from "@/features/share/services/share-expiry-service.ts";
import { useGetSharesQuery } from "@/features/share/queries/share-query.ts";
import { IShareForPage } from "@/features/share/types/share.types.ts";

vi.mock("@/features/share/services/share-expiry-service.ts", () => ({
  setShareExpiry: vi.fn(),
  renewShareExpiry: vi.fn(),
}));
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useGetSharesQuery: vi.fn(),
  useDeleteShareMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/date-locale.ts", () => ({
  formatLocalized: (date: string) => `on ${String(date).slice(0, 10)}`,
  useDateFnsLocale: () => undefined,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      key.replace(/{{(\w+)}}/g, (_, name) => options?.[name] ?? ""),
  }),
}));
vi.mock("@/hooks/use-cursor-paginate", () => ({
  useCursorPaginate: () => ({
    cursor: undefined,
    goNext: vi.fn(),
    goPrev: vi.fn(),
  }),
}));

beforeAll(() => {
  window.matchMedia ??= (media) => ({
    media,
    matches: false,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => vi.clearAllMocks());

const baseShare: IShareForPage = {
  id: "share-1",
  key: "abc",
  pageId: "page-1",
  includeSubPages: true,
  searchIndexing: false,
  creatorId: "u1",
  spaceId: "s1",
  workspaceId: "w1",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  deletedAt: null,
  level: 0,
  sharedPage: { id: "page-1", slugId: "slug1", title: "Handbook", icon: "" },
  expiresAt: null,
  periodDays: null,
  expired: false,
};

// Reads the share from the query cache, as the share dialog does.
function Harness({
  share,
  readOnly = false,
}: {
  share: IShareForPage;
  readOnly?: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["share-for-page", "page-1"],
    queryFn: async () => share,
    staleTime: Infinity,
  });
  return data ? <ShareExpiryControl share={data} readOnly={readOnly} /> : null;
}

function renderWith(ui: React.ReactElement) {
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("ShareExpiryControl", () => {
  it("choosing 7 days calls set with 7 and shows the new date", async () => {
    vi.mocked(setShareExpiry).mockResolvedValue({
      expiresAt: "2026-12-03T10:00:00.000Z",
      periodDays: 7,
      expired: false,
    });
    renderWith(<Harness share={baseShare} />);

    expect(
      ((await screen.findByLabelText("Never")) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByLabelText("7 days"));

    await waitFor(() =>
      expect(setShareExpiry).toHaveBeenCalledWith({
        shareId: "share-1",
        periodDays: 7,
      }),
    );
    expect(await screen.findByText("Expires on on 2026-12-03")).toBeTruthy();
    expect((screen.getByLabelText("7 days") as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("choosing Never removes the expiry", async () => {
    vi.mocked(setShareExpiry).mockResolvedValue(null);
    renderWith(
      <Harness
        share={{
          ...baseShare,
          expiresAt: "2026-12-03T10:00:00Z",
          periodDays: 7,
        }}
      />,
    );

    fireEvent.click(await screen.findByLabelText("Never"));

    await waitFor(() =>
      expect(setShareExpiry).toHaveBeenCalledWith({
        shareId: "share-1",
        periodDays: null,
      }),
    );
    await waitFor(() => expect(screen.queryByText("Renew")).toBeNull());
  });

  it("an expired link shows the Expired state and Renew; Renew calls renew and shows the new date", async () => {
    vi.mocked(renewShareExpiry).mockResolvedValue({
      expiresAt: "2026-12-10T10:00:00.000Z",
      periodDays: 7,
      expired: false,
    });
    renderWith(
      <Harness
        share={{
          ...baseShare,
          expiresAt: "2026-11-20T10:00:00Z",
          periodDays: 7,
          expired: true,
        }}
      />,
    );

    expect(await screen.findByText("Expired on on 2026-11-20")).toBeTruthy();
    fireEvent.click(screen.getByText("Renew"));

    await waitFor(() =>
      expect(renewShareExpiry).toHaveBeenCalledWith({ shareId: "share-1" }),
    );
    expect(await screen.findByText("Expires on on 2026-12-10")).toBeTruthy();
    expect(screen.queryByText(/Expired on/)).toBeNull();
  });

  it("a reader of the page sees the date but no controls", async () => {
    renderWith(
      <Harness
        readOnly
        share={{
          ...baseShare,
          expiresAt: "2026-12-03T10:00:00Z",
          periodDays: 7,
        }}
      />,
    );

    expect(await screen.findByText("Expires on on 2026-12-03")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("Renew")).toBeNull();
  });

  it("an inherited share shows the ancestor's date as read-only text", async () => {
    renderWith(
      <Harness
        share={{
          ...baseShare,
          level: 2,
          sharedPage: {
            id: "root",
            slugId: "rootslug",
            title: "Company wiki",
            icon: "",
          },
          expiresAt: "2026-12-03T10:00:00Z",
          periodDays: 30,
        }}
      />,
    );

    expect(
      await screen.findByText("Expires on on 2026-12-03, set on Company wiki"),
    ).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("Renew")).toBeNull();
  });
});

describe("ShareList expiry column", () => {
  const item = (id: string, extra: object) => ({
    ...baseShare,
    id,
    key: `key-${id}`,
    page: {
      id: `p-${id}`,
      title: `Page ${id}`,
      slugId: `slug-${id}`,
      icon: null,
    },
    space: { id: "s1", name: "Space", slug: "space", userRole: "writer" },
    creator: { id: "u1", name: "Sam Lee", avatarUrl: null },
    ...extra,
  });

  it("the list shows Never for a share with no expiry", () => {
    vi.mocked(useGetSharesQuery).mockReturnValue({
      isLoading: false,
      data: {
        items: [
          item("a", {}),
          item("b", { expiresAt: "2026-12-03T10:00:00Z", periodDays: 7 }),
          item("c", {
            expiresAt: "2026-11-01T10:00:00Z",
            periodDays: 7,
            expired: true,
          }),
        ],
        meta: { hasPrevPage: false, hasNextPage: false },
      },
    } as any);

    renderWith(<ShareList />);

    const rows = screen.getAllByRole("row").slice(1);
    const expiresCell = (row: HTMLElement) =>
      row.querySelectorAll("td")[3].textContent;
    expect(screen.getByText("Expires")).toBeTruthy();
    expect(expiresCell(rows[0])).toBe("Never");
    expect(expiresCell(rows[1])).toBe("on 2026-12-03");
    expect(expiresCell(rows[2])).toBe("Expired");
  });
});

describe("ShareActionMenu expiry", () => {
  const row = (extra: object) => ({
    ...baseShare,
    key: "abc",
    page: { id: "page-1", title: "Handbook", slugId: "slug1", icon: null },
    space: { id: "s1", name: "Space", slug: "space", userRole: "writer" },
    creator: { id: "u1", name: "Sam Lee", avatarUrl: null },
    ...extra,
  });

  it("sets and renews the expiry from the row menu, and marks the current period", async () => {
    vi.mocked(setShareExpiry).mockResolvedValue(null);
    vi.mocked(renewShareExpiry).mockResolvedValue({
      expiresAt: "2026-12-10T10:00:00.000Z",
      periodDays: 7,
      expired: false,
    });
    renderWith(
      <ShareActionMenu
        share={row({ expiresAt: "2026-12-03T10:00:00Z", periodDays: 7 }) as any}
      />,
    );

    fireEvent.click(screen.getByLabelText("More options"));
    fireEvent.click(await screen.findByText("30 days"));
    await waitFor(() =>
      expect(setShareExpiry).toHaveBeenCalledWith({
        shareId: "share-1",
        periodDays: 30,
      }),
    );

    fireEvent.click(screen.getByLabelText("More options"));
    fireEvent.click(await screen.findByText("Renew"));
    await waitFor(() =>
      expect(renewShareExpiry).toHaveBeenCalledWith({ shareId: "share-1" }),
    );
  });

  it("offers no Renew for a link without an expiry, and nothing to a reader", async () => {
    renderWith(
      <ShareActionMenu
        share={
          row({
            space: { id: "s1", name: "S", slug: "s", userRole: "reader" },
          }) as any
        }
      />,
    );

    fireEvent.click(screen.getByLabelText("More options"));
    const item = await screen.findByText("1 day");

    expect(screen.queryByText("Renew")).toBeNull();
    expect(item.closest("button")?.hasAttribute("disabled")).toBe(true);
  });
});
