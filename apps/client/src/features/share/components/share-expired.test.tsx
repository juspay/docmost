import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import ShareExpired, { getShareExpired } from "./share-expired.tsx";
import ShareRedirect from "@/pages/share/share-redirect.tsx";
import SharedPage from "@/pages/share/shared-page.tsx";
import { useAuthenticatedUser } from "@/features/public-space/hooks/use-authenticated-user.ts";
import {
  useGetShareByIdQuery,
  useSharePageQuery,
} from "@/features/share/queries/share-query.ts";

vi.mock("@/features/public-space/hooks/use-authenticated-user.ts", () => ({
  useAuthenticatedUser: vi.fn(),
}));
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useGetShareByIdQuery: vi.fn(),
  useSharePageQuery: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// Only reached if the expired screen wrongly falls through to the page.
vi.mock("@/features/editor/readonly-page-editor.tsx", () => ({
  default: () => <div>PAGE BODY</div>,
}));
vi.mock("@/features/public-space/components/docs/docs-breadcrumbs.tsx", () => ({
  default: () => <div>BREADCRUMBS</div>,
}));
vi.mock("@/features/public-space/components/docs/docs-page-nav.tsx", () => ({
  default: () => null,
}));
vi.mock(
  "@/features/public-space/components/docs/docs-footer-branding.tsx",
  () => ({
    default: () => null,
  }),
);
vi.mock("@/features/page-cover/components/public-page-cover.tsx", () => ({
  PublicPageCover: () => null,
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

const EXPIRED = {
  response: {
    status: 404,
    data: {
      code: "SHARE_EXPIRED",
      message: "This link has expired",
      pageSlugId: "slug123",
    },
  },
  status: 404,
};

const signedOut = { data: undefined, isLoading: false };
const signedIn = { data: { user: { id: "u1" } }, isLoading: false };
const checking = { data: undefined, isLoading: true };

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(path: string, element: React.ReactElement, route: string) {
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={route} element={element} />
            <Route path="/p/:slug" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("ShareExpired", () => {
  it("reads the slug id out of the SHARE_EXPIRED body only", () => {
    expect(getShareExpired(EXPIRED)).toEqual({ pageSlugId: "slug123" });
    expect(
      getShareExpired({ response: { data: { code: "OTHER" } } }),
    ).toBeNull();
    expect(getShareExpired(new Error("boom"))).toBeNull();
  });

  it("while the sign-in check is loading no expired text is shown", () => {
    vi.mocked(useAuthenticatedUser).mockReturnValue(checking as any);

    renderAt("/x", <ShareExpired pageSlugId="slug123" />, "/x");

    expect(screen.queryByText("This link has expired")).toBeNull();
    expect(screen.queryByText(/Sign in/)).toBeNull();
  });

  it("an expired link sends a signed-in person to /p/", async () => {
    vi.mocked(useAuthenticatedUser).mockReturnValue(signedIn as any);

    renderAt("/x", <ShareExpired pageSlugId="slug123" />, "/x");

    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/p/slug123"),
    );
    expect(screen.queryByText("This link has expired")).toBeNull();
  });

  it("an expired link shows the sign-in message and no page title to an anonymous visitor", () => {
    vi.mocked(useAuthenticatedUser).mockReturnValue(signedOut as any);

    renderAt("/x", <ShareExpired pageSlugId="slug123" />, "/x");

    expect(screen.getByText("This link has expired")).toBeTruthy();
    expect(
      screen.getByText("Sign in to view the page if you have access"),
    ).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/p/slug123");
  });

  describe("an expired /share/ link behaves the same as a page link", () => {
    const pageLink = () => {
      vi.mocked(useSharePageQuery).mockReturnValue({
        isLoading: false,
        isError: true,
        error: EXPIRED,
        data: undefined,
      } as any);
      return renderAt(
        "/share/key1/p/quarterly-plan-slug123",
        <SharedPage />,
        "/share/:shareId/p/:pageSlug",
      );
    };
    const shareLink = () => {
      vi.mocked(useGetShareByIdQuery).mockReturnValue({
        isLoading: false,
        isError: true,
        error: EXPIRED,
        data: undefined,
      } as any);
      return renderAt("/share/key1", <ShareRedirect />, "/share/:shareId");
    };

    it.each([
      ["page link", pageLink],
      ["share link", shareLink],
    ])(
      "anonymous visitor on the %s sees only the expired message",
      (_name, open) => {
        vi.mocked(useAuthenticatedUser).mockReturnValue(signedOut as any);

        open();

        expect(screen.getByText("This link has expired")).toBeTruthy();
        expect(screen.queryByText("PAGE BODY")).toBeNull();
        expect(screen.queryByText("BREADCRUMBS")).toBeNull();
        expect(screen.queryByText(/404/)).toBeNull();
      },
    );

    it.each([
      ["page link", pageLink],
      ["share link", shareLink],
    ])("signed-in person on the %s lands on /p/", async (_name, open) => {
      vi.mocked(useAuthenticatedUser).mockReturnValue(signedIn as any);

      open();

      await waitFor(() =>
        expect(screen.getByTestId("where").textContent).toBe("/p/slug123"),
      );
    });
  });
});
