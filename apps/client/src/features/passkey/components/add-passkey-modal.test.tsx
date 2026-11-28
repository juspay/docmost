import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddPasskeyModal } from "./add-passkey-modal";

const m = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  getPasskeyRegisterOptions: vi.fn(),
  verifyPasskeyRegistration: vi.fn(),
  logout: vi.fn(),
  show: vi.fn(),
  hasGeneratedPassword: false,
}));

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: m.startRegistration,
}));
vi.mock("../services/passkey-service.ts", () => ({
  getPasskeyRegisterOptions: m.getPasskeyRegisterOptions,
  verifyPasskeyRegistration: m.verifyPasskeyRegistration,
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: m.show } }));
vi.mock("@/features/auth/hooks/use-auth.ts", () => ({
  default: () => ({ logout: m.logout }),
}));
vi.mock("@/features/user/hooks/use-current-user.ts", () => ({
  default: () => ({
    data: { user: { hasGeneratedPassword: m.hasGeneratedPassword } },
  }),
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

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient();
  render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <AddPasskeyModal opened onClose={onClose} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { onClose };
}

async function fill(name: string, password: string) {
  fireEvent.change(await screen.findByLabelText(/^Name/), {
    target: { value: name },
  });
  fireEvent.change(await screen.findByLabelText(/^Current password/), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
}

beforeEach(() => {
  m.hasGeneratedPassword = false;
  m.getPasskeyRegisterOptions.mockResolvedValue({
    challengeId: "c1",
    options: { challenge: "x" },
  });
  m.startRegistration.mockResolvedValue({ id: "new" });
  m.verifyPasskeyRegistration.mockResolvedValue({ id: "pk1", name: "Laptop" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddPasskeyModal", () => {
  it("adding a passkey sends the current password with the options request", async () => {
    const { onClose } = renderModal();
    await fill("Laptop", "hunter2hunter2");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(m.getPasskeyRegisterOptions).toHaveBeenCalledWith("hunter2hunter2");
    expect(m.startRegistration).toHaveBeenCalledWith({
      optionsJSON: { challenge: "x" },
    });
    expect(m.verifyPasskeyRegistration).toHaveBeenCalledWith({
      challengeId: "c1",
      response: { id: "new" },
      name: "Laptop",
    });
  });

  it("a wrong password keeps the dialog open with the error", async () => {
    m.getPasskeyRegisterOptions.mockRejectedValue({
      response: {
        status: 400,
        data: { message: "Current password is incorrect" },
      },
    });
    const { onClose } = renderModal();
    await fill("Laptop", "wrong");
    expect(
      await screen.findByText("Current password is incorrect"),
    ).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(m.startRegistration).not.toHaveBeenCalled();
  });

  it("offers to sign out when the server asks for a fresh sign-in", async () => {
    m.hasGeneratedPassword = true;
    m.getPasskeyRegisterOptions.mockRejectedValue({
      response: {
        status: 403,
        data: { message: "Sign in again to add a passkey" },
      },
    });
    renderModal();
    fireEvent.change(await screen.findByLabelText(/^Name/), {
      target: { value: "Phone" },
    });
    expect(screen.queryByLabelText(/^Current password/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
    expect(
      await screen.findByText("Sign in again to add a passkey"),
    ).toBeTruthy();
    expect(m.getPasskeyRegisterOptions).toHaveBeenCalledWith(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(m.logout).toHaveBeenCalled();
  });

  it("a cancelled browser prompt keeps the dialog open and shows no error", async () => {
    m.startRegistration.mockRejectedValue(
      Object.assign(new Error("x"), { name: "NotAllowedError" }),
    );
    const { onClose } = renderModal();
    await fill("Laptop", "hunter2hunter2");
    await waitFor(() => expect(m.startRegistration).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Add passkey",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(m.show).not.toHaveBeenCalled();
    expect(m.verifyPasskeyRegistration).not.toHaveBeenCalled();
  });
});
