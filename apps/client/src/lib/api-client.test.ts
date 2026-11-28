import { AxiosError, type AxiosAdapter } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import api from "./api-client";

vi.mock("@/lib/config.ts", () => ({ isCloud: () => false }));

const paneMode = vi.fn(() => false);
const postToParent = vi.fn();
vi.mock("@/features/split-view/pane-mode.ts", () => ({
  isPaneMode: () => paneMode(),
}));
vi.mock("@/features/split-view/pane-messages.ts", () => ({
  postToParent: (message: unknown) => postToParent(message),
}));

const PAGE_URL = "http://localhost/s/general/p/policy-abc";

const respondWith =
  (status: number): AxiosAdapter =>
  async (config) => {
    throw new AxiosError(
      `Request failed with status code ${status}`,
      AxiosError.ERR_BAD_REQUEST,
      config,
      { responseURL: `http://localhost/api${config.url}` },
      { status, statusText: "", headers: {}, config, data: {} },
    );
  };

let location: { pathname: string; search: string; hash: string; href: string };

beforeEach(() => {
  location = {
    pathname: "/s/general/p/policy-abc",
    search: "",
    hash: "",
    href: PAGE_URL,
  };
  vi.stubGlobal("location", location);
});

afterEach(() => {
  vi.unstubAllGlobals();
  paneMode.mockReturnValue(false);
  postToParent.mockClear();
});

describe("api client on 401", () => {
  it("rejects the background banner poll without sending the reader to the login page", async () => {
    await expect(
      api.post("/announcements/visible", undefined, {
        adapter: respondWith(401),
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
    expect(location.href).toBe(PAGE_URL);
  });

  it("sends the reader to the login page for any other request", async () => {
    await expect(
      api.post("/pages/info", undefined, { adapter: respondWith(401) }),
    ).rejects.toMatchObject({ response: { status: 401 } });
    expect(location.href).toBe(
      "/login?redirect=%2Fs%2Fgeneral%2Fp%2Fpolicy-abc",
    );
  });

  it("in a split-view pane posts auth-expired to the parent and does not navigate", async () => {
    paneMode.mockReturnValue(true);
    await expect(
      api.post("/pages/info", undefined, { adapter: respondWith(401) }),
    ).rejects.toMatchObject({ response: { status: 401 } });
    expect(postToParent).toHaveBeenCalledWith({
      type: "docmost:pane-auth-expired",
    });
    expect(location.href).toBe(PAGE_URL);
  });

  it("outside a pane posts nothing to a parent", async () => {
    await expect(
      api.post("/pages/info", undefined, { adapter: respondWith(401) }),
    ).rejects.toMatchObject({ response: { status: 401 } });
    expect(postToParent).not.toHaveBeenCalled();
  });
});
