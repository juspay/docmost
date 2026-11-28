import { useState } from "react";
import { Button, Group, Modal, Select, Stack, TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";
import {
  AccessTokenScope,
  ICreatedAccessToken,
} from "@/features/access-token/types/access-token.types";
import { useCreateAccessTokenMutation } from "@/features/access-token/queries/access-token-query";

interface Props {
  opened: boolean;
  onClose: () => void;
  onCreated: (token: ICreatedAccessToken) => void;
}

const DAY_MS = 86_400_000;

export default function CreateAccessTokenModal({
  opened,
  onClose,
  onCreated,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<AccessTokenScope>("read");
  const [expiry, setExpiry] = useState<string>("never");
  const mutation = useCreateAccessTokenMutation();

  const submit = async () => {
    const expiresAt =
      expiry === "never"
        ? null
        : new Date(Date.now() + Number(expiry) * DAY_MS).toISOString();
    const created = await mutation.mutateAsync({
      name: name.trim(),
      scope,
      expiresAt,
    });
    setName("");
    setScope("read");
    setExpiry("never");
    onCreated(created);
    // the plaintext token must not outlive the "copy it now" dialog
    mutation.reset();
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t("New access token")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void submit();
        }}
      >
        <Stack>
          <TextInput
            data-autofocus
            label={t("Name")}
            placeholder={t("Claude Code on my laptop")}
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Select
            label={t("Access")}
            allowDeselect={false}
            value={scope}
            onChange={(v) => v && setScope(v as AccessTokenScope)}
            data={[
              { value: "read", label: t("Read only") },
              { value: "write", label: t("Read and write") },
            ]}
          />
          <Select
            label={t("Expires")}
            allowDeselect={false}
            value={expiry}
            onChange={(v) => v && setExpiry(v)}
            data={[
              { value: "never", label: t("Never") },
              { value: "7", label: t("In 7 days") },
              { value: "30", label: t("In 30 days") },
              { value: "90", label: t("In 90 days") },
            ]}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!name.trim()}
              loading={mutation.isPending}
            >
              {t("Create token")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
