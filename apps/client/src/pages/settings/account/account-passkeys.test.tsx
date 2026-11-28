import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import AccountPasskeys from "./account-passkeys";

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
}));
vi.mock("@/features/passkey/components/passkey-list.tsx", () => ({
  PasskeyList: () => null,
}));
vi.mock("@/features/passkey/components/add-passkey-modal.tsx", () => ({
  AddPasskeyModal: () => null,
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

afterEach(cleanup);

function renderPage(enforceSso: boolean) {
  const store = createStore();
  store.set(currentUserAtom, {
    user: { id: "u1" },
    workspace: { id: "w1", enforceSso },
  } as any);
  render(
    <Provider store={store}>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <AccountPasskeys />
        </QueryClientProvider>
      </MantineProvider>
    </Provider>,
  );
}

describe("AccountPasskeys", () => {
  it("does not offer a new passkey where single sign-on is enforced", () => {
    renderPage(true);
    const add = screen.getByRole("button", { name: "Add passkey" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    screen.getByText(
      "Your workspace requires single sign-on, so passkeys cannot be used to sign in.",
    );
  });

  it("offers it otherwise", () => {
    renderPage(false);
    const add = screen.getByRole("button", { name: "Add passkey" });
    expect((add as HTMLButtonElement).disabled).toBe(false);
  });
});
