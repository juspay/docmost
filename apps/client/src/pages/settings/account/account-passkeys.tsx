import { Button, Group, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { PasskeyList } from "@/features/passkey/components/passkey-list.tsx";
import { AddPasskeyModal } from "@/features/passkey/components/add-passkey-modal.tsx";
import { useAtom } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";

export default function AccountPasskeys() {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);
  const [workspace] = useAtom(workspaceAtom);
  const ssoEnforced = !!workspace?.enforceSso;

  return (
    <>
      <DocumentTitle title={t("Passkeys")} />
      <SettingsTitle title={t("Passkeys")} />

      <Group justify="space-between" wrap="nowrap" gap="xl">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text size="md">{t("Sign in without a password")}</Text>
          <Text size="sm" c="dimmed">
            {t(
              "A passkey lets you sign in with your fingerprint, face or device lock. Your password keeps working.",
            )}
          </Text>
        </div>
        <Button
          onClick={open}
          disabled={!browserSupportsWebAuthn() || ssoEnforced}
          style={{ whiteSpace: "nowrap" }}
        >
          {t("Add passkey")}
        </Button>
      </Group>

      {ssoEnforced && (
        <Text size="sm" c="dimmed" mt="sm">
          {t(
            "Your workspace requires single sign-on, so passkeys cannot be used to sign in.",
          )}
        </Text>
      )}

      {!ssoEnforced && !browserSupportsWebAuthn() && (
        <Text size="sm" c="dimmed" mt="sm">
          {t("This browser does not support passkeys.")}
        </Text>
      )}

      <PasskeyList />
      <AddPasskeyModal opened={opened} onClose={close} />
    </>
  );
}
