import { MantineProvider } from "@mantine/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasskeyLoginButton } from "./passkey-login-button";

const m = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(),
  getPasskeyLoginOptions: vi.fn(),
  verifyPasskeyLogin: vi.fn(),
  show: vi.fn(),
  isCloud: vi.fn(() => false),
}));

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: m.browserSupportsWebAuthn,
  startAuthentication: m.startAuthentication,
}));
vi.mock("../services/passkey-service.ts", () => ({
  getPasskeyLoginOptions: m.getPasskeyLoginOptions,
  verifyPasskeyLogin: m.verifyPasskeyLogin,
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: m.show },
}));
vi.mock("@/lib/config.ts", () => ({ isCloud: m.isCloud }));
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

function renderButton(url = "/login") {
  // getPostLoginRedirect reads the browser URL, not the router's
  window.history.replaceState({}, "", url);
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/login" element={<PasskeyLoginButton />} />
          <Route path="/home" element={<div>home page</div>} />
          <Route path="/s/docs" element={<div>deep link</div>} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
}

beforeEach(() => {
  m.browserSupportsWebAuthn.mockReturnValue(true);
  m.isCloud.mockReturnValue(false);
  m.getPasskeyLoginOptions.mockResolvedValue({
    challengeId: "c1",
    options: { challenge: "x" },
  });
  m.startAuthentication.mockResolvedValue({ id: "cred" });
  m.verifyPasskeyLogin.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  vi.clearAllMocks();
});

describe("PasskeyLoginButton", () => {
  it("the button is absent when the browser has no WebAuthn", () => {
    m.browserSupportsWebAuthn.mockReturnValue(false);
    renderButton();
    expect(
      screen.queryByRole("button", { name: "Sign in with a passkey" }),
    ).toBeNull();
  });

  it("the button is absent on cloud", () => {
    m.isCloud.mockReturnValue(true);
    renderButton();
    expect(
      screen.queryByRole("button", { name: "Sign in with a passkey" }),
    ).toBeNull();
  });

  it("a successful sign-in posts the assertion and navigates like the password form", async () => {
    renderButton("/login?redirect=%2Fs%2Fdocs");
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with a passkey" }),
    );
    await screen.findByText("deep link");
    expect(m.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { challenge: "x" },
    });
    expect(m.verifyPasskeyLogin).toHaveBeenCalledWith({
      challengeId: "c1",
      response: { id: "cred" },
    });
  });

  it("goes to the home page when there is no redirect", async () => {
    renderButton();
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with a passkey" }),
    );
    await screen.findByText("home page");
  });

  it("a cancelled prompt shows no error", async () => {
    const cancelled = Object.assign(new Error("cancelled"), {
      name: "NotAllowedError",
    });
    m.startAuthentication.mockRejectedValue(cancelled);
    renderButton();
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with a passkey" }),
    );
    await waitFor(() => expect(m.startAuthentication).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Sign in with a passkey",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(m.show).not.toHaveBeenCalled();
    expect(m.verifyPasskeyLogin).not.toHaveBeenCalled();
  });

  it("a refused passkey shows the error message", async () => {
    m.verifyPasskeyLogin.mockRejectedValue({
      response: { data: { message: "Passkey sign-in failed" } },
    });
    renderButton();
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with a passkey" }),
    );
    await waitFor(() =>
      expect(m.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "That passkey could not be used",
          color: "red",
        }),
      ),
    );
    expect(screen.queryByText("home page")).toBeNull();
  });
});
