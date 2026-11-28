import { MantineProvider } from "@mantine/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import AccountAccessTokens from "./account-access-tokens";

const m = vi.hoisted(() => ({ updateWorkspace: vi.fn() }));

vi.mock("@/features/workspace/services/workspace-service.ts", () => ({
  updateWorkspace: m.updateWorkspace,
}));
vi.mock("@/features/access-token/components/access-token-table", () => ({
  default: () => <div>token table</div>,
}));
vi.mock("@/features/access-token/components/mcp-setup", () => ({
  default: () => <div>mcp setup</div>,
}));
vi.mock("@/features/access-token/components/create-access-token-modal", () => ({
  default: () => null,
}));
vi.mock(
  "@/features/access-token/components/access-token-created-modal",
  () => ({
    default: () => null,
  }),
);
vi.mock("@/components/settings/settings-title.tsx", () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/components/ui/document-title.tsx", () => ({
  DocumentTitle: () => null,
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderAs(role: string, enabled?: boolean) {
  const store = createStore();
  const workspace: any = {
    id: "ws1",
    settings: enabled === undefined ? {} : { agentMcp: { enabled } },
  };
  store.set(currentUserAtom, { user: { id: "u1", role }, workspace } as any);
  render(
    <Provider store={store}>
      <MantineProvider>
        <AccountAccessTokens />
      </MantineProvider>
    </Provider>,
  );
  return store;
}

describe("Access tokens page: agent access switch", () => {
  it("an admin sees the switch, off by default, and can switch it on", async () => {
    const store = renderAs("admin");
    const toggle = screen.getByRole("switch", {
      name: "Toggle agent access",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    m.updateWorkspace.mockResolvedValue({
      id: "ws1",
      settings: { agentMcp: { enabled: true } },
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(m.updateWorkspace).toHaveBeenCalledWith({ agentMcpEnabled: true }),
    );
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(
      store.get(currentUserAtom)?.workspace.settings.agentMcp?.enabled,
    ).toBe(true);
    expect(screen.queryByText(/An admin has to switch it on/)).toBeNull();
  });

  it("an admin cannot create a token either until agent access is on", () => {
    renderAs("admin", false);
    expect(
      (screen.getByRole("button", { name: "New token" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("a member sees a note instead, and cannot create a token while it is off", () => {
    renderAs("member", false);
    expect(
      screen.queryByRole("switch", { name: "Toggle agent access" }),
    ).toBeNull();
    screen.getByText(
      "Agent access is switched off for this workspace. An admin has to switch it on before you can create tokens.",
    );
    expect(
      (screen.getByRole("button", { name: "New token" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("a member sees no note and can create tokens once it is on", () => {
    renderAs("member", true);
    expect(screen.queryByText(/An admin has to switch it on/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "New token" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
