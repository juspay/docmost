import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MemberActionMenu from "./members-action-menu";

const m = vi.hoisted(() => ({ role: { isAdmin: true, isOwner: false } }));

vi.mock("@/hooks/use-user-role.tsx", () => ({ default: () => m.role }));
vi.mock("@/lib/config.ts", () => ({ isCloud: () => false }));
vi.mock("@/features/passkey/queries/passkey-query.ts", () => ({
  useAdminDeletePasskeysMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/workspace/hooks/use-member-actions.tsx", () => ({
  useMemberActions: () => ({
    openDeactivateModal: vi.fn(),
    openDeleteModal: vi.fn(),
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

afterEach(cleanup);

async function menuFor(role: string) {
  render(
    <MantineProvider>
      <MemberActionMenu
        userId="u2"
        name="Ann"
        deactivatedAt={null}
        role={role}
      />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByLabelText("Member actions for {{name}}"));
  await screen.findByText("Delete member");
}

describe("MemberActionMenu", () => {
  it("does not offer an admin to remove an owner's passkeys", async () => {
    m.role = { isAdmin: true, isOwner: false };
    await menuFor("owner");
    expect(screen.queryByText("Remove passkeys")).toBeNull();
  });

  it("offers it for a member, and to an owner for another owner", async () => {
    m.role = { isAdmin: true, isOwner: false };
    await menuFor("member");
    screen.getByText("Remove passkeys");
    cleanup();

    m.role = { isAdmin: true, isOwner: true };
    await menuFor("owner");
    screen.getByText("Remove passkeys");
  });
});
