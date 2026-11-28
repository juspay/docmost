import { useState } from "react";
import { Button } from "@mantine/core";
import { IconFingerprint } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  browserSupportsWebAuthn,
  startAuthentication,
} from "@simplewebauthn/browser";
import { isCloud } from "@/lib/config.ts";
import { getPostLoginRedirect } from "@/lib/app-route.ts";
import {
  getPasskeyLoginOptions,
  verifyPasskeyLogin,
} from "../services/passkey-service.ts";
import { isPromptCancelled } from "../utils.ts";

export function PasskeyLoginButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);

  if (isCloud() || !browserSupportsWebAuthn()) return null;

  async function onClick() {
    setIsLoading(true);
    try {
      const { challengeId, options } = await getPasskeyLoginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await verifyPasskeyLogin({ challengeId, response });
      navigate(getPostLoginRedirect());
    } catch (err: any) {
      if (isPromptCancelled(err)) return;
      const serverMessage = err?.response?.data?.message;
      notifications.show({
        message:
          serverMessage === "Sign in with your password"
            ? t("Sign in with your password")
            : t("That passkey could not be used"),
        color: "red",
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Button
      variant="default"
      fullWidth
      mt="sm"
      leftSection={<IconFingerprint size={18} />}
      loading={isLoading}
      onClick={onClick}
    >
      {t("Sign in with a passkey")}
    </Button>
  );
}
