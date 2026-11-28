import { MantineProvider } from "@mantine/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreateAccessTokenModal from "./create-access-token-modal";
import AccessTokenTable from "./access-token-table";

const m = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  reset: vi.fn(),
  tokens: [] as any[],
}));

vi.mock("@/features/access-token/queries/access-token-query", () => ({
  useCreateAccessTokenMutation: () => ({
    mutateAsync: m.mutateAsync,
    reset: m.reset,
    isPending: false,
  }),
  useAccessTokensQuery: () => ({ data: m.tokens, isLoading: false }),
  useRevokeAccessTokenMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (v: string) => v }),
}));

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// Mantine's Select measures itself
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const token = (id: string, expiresAt: string | null) => ({
  id,
  name: `token ${id}`,
  tokenPrefix: "dmt_abc",
  scope: "read",
  lastUsedAt: null,
  expiresAt,
  createdAt: new Date().toISOString(),
});

describe("CreateAccessTokenModal", () => {
  it("clears the created secret from the mutation once it is handed over", async () => {
    m.mutateAsync.mockResolvedValue({ token: "dmt_secret" });
    const onCreated = vi.fn();
    render(
      <MantineProvider>
        <CreateAccessTokenModal
          opened
          onClose={vi.fn()}
          onCreated={onCreated}
        />
      </MantineProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "laptop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(m.reset).toHaveBeenCalled();
  });
});

describe("AccessTokenTable", () => {
  it("marks an expired token, and only that one", () => {
    m.tokens = [
      token("old", new Date(Date.now() - 86_400_000).toISOString()),
      token("new", new Date(Date.now() + 86_400_000).toISOString()),
      token("never", null),
    ];
    render(
      <MantineProvider>
        <AccessTokenTable />
      </MantineProvider>,
    );
    const expired = screen.getAllByText("Expired");
    expect(expired).toHaveLength(1);
    expect(expired[0].closest("tr")?.textContent).toContain("token old");
  });
});
