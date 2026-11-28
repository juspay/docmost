import { Menu, ActionIcon, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import React from "react";
import { IconDots, IconTrash, IconUserOff, IconUserCheck, IconFingerprint } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import { UserRole } from "@/lib/types.ts";
import { isCloud } from "@/lib/config.ts";
import { useAdminDeletePasskeysMutation } from "@/features/passkey/queries/passkey-query.ts";
import { useMemberActions } from "@/features/workspace/hooks/use-member-actions.tsx";

interface Props {
  userId: string;
  name: string;
  deactivatedAt: Date | null;
  role?: string;
}
export default function MemberActionMenu({
  userId,
  name,
  deactivatedAt,
  role,
}: Props) {
  const { t } = useTranslation();
  const { isAdmin, isOwner } = useUserRole();
  // the server refuses an admin acting on an owner
  const canRemovePasskeys = !isCloud() && (isOwner || role !== UserRole.OWNER);

  const isDeactivated = !!deactivatedAt;

  const { openDeactivateModal, openDeleteModal } = useMemberActions({
    userId,
    isDeactivated,
  });

  const removePasskeysMutation = useAdminDeletePasskeysMutation();
  const openRemovePasskeysModal = () =>
    modals.openConfirmModal({
      title: t("Remove passkeys"),
      children: (
        <Text size="sm">
          {t(
            "Remove all passkeys of {{name}}? They will need their password to sign in.",
            { name },
          )}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Remove"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => removePasskeysMutation.mutate(userId),
    });

  return (
    <>
      <Menu
        shadow="xl"
        position="bottom-end"
        offset={20}
        width={200}
        withArrow
        arrowPosition="center"
      >
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            c="gray"
            aria-label={t("Member actions for {{name}}", { name })}
          >
            <IconDots size={20} stroke={2} />
          </ActionIcon>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Item
            onClick={openDeactivateModal}
            leftSection={
              isDeactivated ? (
                <IconUserCheck size={16} />
              ) : (
                <IconUserOff size={16} />
              )
            }
            disabled={!isAdmin}
          >
            {isDeactivated ? t("Activate member") : t("Deactivate member")}
          </Menu.Item>

          {canRemovePasskeys && (
            <Menu.Item
              onClick={openRemovePasskeysModal}
              leftSection={<IconFingerprint size={16} />}
              disabled={!isAdmin}
            >
              {t("Remove passkeys")}
            </Menu.Item>
          )}

          <Menu.Divider />

          <Menu.Item
            c="red"
            onClick={openDeleteModal}
            leftSection={<IconTrash size={16} />}
            disabled={!isAdmin}
          >
            {t("Delete member")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );
}
