import { useState } from "react";
import {
  Alert,
  Button,
  Group,
  Modal,
  PasswordInput,
  TextInput,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { startRegistration } from "@simplewebauthn/browser";
import useAuth from "@/features/auth/hooks/use-auth.ts";
import useCurrentUser from "@/features/user/hooks/use-current-user.ts";
import {
  getPasskeyRegisterOptions,
  verifyPasskeyRegistration,
} from "../services/passkey-service.ts";
import { PASSKEYS_KEY } from "../queries/passkey-query.ts";
import { isPromptCancelled } from "../utils.ts";

const SIGN_IN_AGAIN = "Sign in again to add a passkey";

interface Props {
  opened: boolean;
  onClose: () => void;
}

export function AddPasskeyModal({ opened, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { logout } = useAuth();
  const { data: currentUser } = useCurrentUser();
  const requiresPassword = !currentUser?.user?.hasGeneratedPassword;

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsFreshSignIn, setNeedsFreshSignIn] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  function close() {
    setName("");
    setPassword("");
    setError(null);
    setNeedsFreshSignIn(false);
    onClose();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNeedsFreshSignIn(false);
    setIsLoading(true);
    try {
      const { challengeId, options } = await getPasskeyRegisterOptions(
        requiresPassword ? password : undefined,
      );
      const response = await startRegistration({ optionsJSON: options });
      await verifyPasskeyRegistration({
        challengeId,
        response,
        name: name.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      notifications.show({ message: t("Passkey added") });
      close();
    } catch (err: any) {
      if (isPromptCancelled(err)) return;
      const message: string | undefined = err?.response?.data?.message;
      if (err?.response?.status === 403 && message === SIGN_IN_AGAIN) {
        setNeedsFreshSignIn(true);
      } else if (err?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
        setError(t("This device already has a passkey for your account"));
      } else {
        setError(message ?? t("The passkey could not be added"));
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Modal opened={opened} onClose={close} title={t("Add a passkey")} centered>
      <form onSubmit={onSubmit}>
        <TextInput
          label={t("Name")}
          placeholder={t("For example, My laptop")}
          data-autofocus
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />

        {requiresPassword && (
          <PasswordInput
            mt="md"
            label={t("Current password")}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            error={error ?? undefined}
          />
        )}
        {!requiresPassword && error && (
          <Alert color="red" mt="md">
            {error}
          </Alert>
        )}

        {needsFreshSignIn && (
          <Alert color="orange" mt="md" role="alert">
            {t(SIGN_IN_AGAIN)}
            <Group mt="xs">
              <Button size="xs" variant="default" onClick={() => logout()}>
                {t("Sign out")}
              </Button>
            </Group>
          </Alert>
        )}

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={close}>
            {t("Cancel")}
          </Button>
          <Button type="submit" loading={isLoading} disabled={!name.trim()}>
            {t("Add passkey")}
          </Button>
        </Group>
      </form>
    </Modal>
  );
}
