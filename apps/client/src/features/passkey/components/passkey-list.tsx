import { useState } from "react";
import {
  ActionIcon,
  Badge,
  Group,
  Menu,
  Modal,
  Table,
  Text,
  TextInput,
  Button,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconDots, IconPencil, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formattedDate } from "@/lib/time.ts";
import {
  useDeletePasskeyMutation,
  usePasskeysQuery,
  useRenamePasskeyMutation,
} from "../queries/passkey-query.ts";
import { IPasskey } from "../types/passkey.types.ts";

export function PasskeyList() {
  const { t } = useTranslation();
  const { data, isLoading } = usePasskeysQuery();
  const deleteMutation = useDeletePasskeyMutation();
  const [renaming, setRenaming] = useState<IPasskey | null>(null);

  if (isLoading) return null;

  if (!data?.length) {
    return (
      <Text size="sm" c="dimmed" mt="sm">
        {t("You have not added a passkey yet.")}
      </Text>
    );
  }

  const confirmDelete = (passkey: IPasskey) =>
    modals.openConfirmModal({
      title: t("Delete passkey"),
      children: (
        <Text size="sm">
          {t(
            "Delete the passkey {{name}}? You will no longer be able to sign in with it.",
            { name: passkey.name },
          )}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(passkey.id),
    });

  return (
    <>
      <Table.ScrollContainer minWidth={500}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("Name")}</Table.Th>
              <Table.Th>{t("Type")}</Table.Th>
              <Table.Th>{t("Created")}</Table.Th>
              <Table.Th>{t("Last used")}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.map((passkey) => (
              <Table.Tr key={passkey.id}>
                <Table.Td>
                  <Text fz="sm" fw={500}>
                    {passkey.name}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge variant="light" color="gray">
                    {passkey.backedUp
                      ? t("Synced")
                      : passkey.deviceType === "singleDevice"
                        ? t("This device only")
                        : t("Multi-device")}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text fz="sm">
                    {formattedDate(new Date(passkey.createdAt))}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text fz="sm">
                    {passkey.lastUsedAt
                      ? formattedDate(new Date(passkey.lastUsedAt))
                      : t("Never")}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Menu shadow="md" position="bottom-end" withArrow>
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        c="gray"
                        aria-label={t("Actions for {{name}}", {
                          name: passkey.name,
                        })}
                      >
                        <IconDots size={18} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconPencil size={16} />}
                        onClick={() => setRenaming(passkey)}
                      >
                        {t("Rename")}
                      </Menu.Item>
                      <Menu.Item
                        c="red"
                        leftSection={<IconTrash size={16} />}
                        onClick={() => confirmDelete(passkey)}
                      >
                        {t("Delete")}
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      {renaming && (
        <RenameModal passkey={renaming} onClose={() => setRenaming(null)} />
      )}
    </>
  );
}

function RenameModal({
  passkey,
  onClose,
}: {
  passkey: IPasskey;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(passkey.name);
  const renameMutation = useRenamePasskeyMutation();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await renameMutation.mutateAsync({ id: passkey.id, name: name.trim() });
    onClose();
  }

  return (
    <Modal opened onClose={onClose} title={t("Rename passkey")} centered>
      <form onSubmit={onSubmit}>
        <TextInput
          label={t("Name")}
          data-autofocus
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            type="submit"
            loading={renameMutation.isPending}
            disabled={!name.trim()}
          >
            {t("Save")}
          </Button>
        </Group>
      </form>
    </Modal>
  );
}
