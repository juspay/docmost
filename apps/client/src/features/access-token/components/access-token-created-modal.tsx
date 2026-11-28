import { Alert, Button, Code, Group, Modal, Stack, Text } from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

interface Props {
  token: string | null;
  onClose: () => void;
}

export default function AccessTokenCreatedModal({ token, onClose }: Props) {
  const { t } = useTranslation();
  const clipboard = useClipboard({ timeout: 2000 });

  return (
    <Modal
      opened={!!token}
      onClose={onClose}
      title={t("Your new access token")}
      closeOnClickOutside={false}
    >
      <Stack>
        <Alert color="yellow">
          {t(
            "Copy this token now. It cannot be shown again. If you lose it, revoke it and make a new one.",
          )}
        </Alert>
        <Code
          block
          data-testid="created-token"
          style={{ wordBreak: "break-all" }}
        >
          {token}
        </Code>
        <Group justify="space-between">
          <Button
            variant="light"
            leftSection={
              clipboard.copied ? (
                <IconCheck size={16} />
              ) : (
                <IconCopy size={16} />
              )
            }
            onClick={() => token && clipboard.copy(token)}
          >
            {clipboard.copied ? t("Copied") : t("Copy token")}
          </Button>
          <Button onClick={onClose}>{t("I have copied it")}</Button>
        </Group>
        <Text size="xs" c="dimmed">
          {t("Treat it like a password. It acts as you.")}
        </Text>
      </Stack>
    </Modal>
  );
}
