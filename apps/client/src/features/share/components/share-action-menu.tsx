import { Menu, ActionIcon, Text } from "@mantine/core";
import React from "react";
import {
  IconCheck,
  IconCopy,
  IconDots,
  IconFileDescription,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { modals } from "@mantine/modals";
import { useTranslation } from "react-i18next";
import {
  ISharedItem,
  SharePeriodDays,
} from "@/features/share/types/share.types.ts";
import {
  buildPageUrl,
  buildSharedPageUrl,
} from "@/features/page/page.utils.ts";
import { useClipboard } from "@/hooks/use-clipboard";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "react-router-dom";
import { useDeleteShareMutation } from "@/features/share/queries/share-query.ts";
import {
  useRenewShareExpiryMutation,
  useSetShareExpiryMutation,
} from "@/features/share/queries/share-expiry-query.ts";

const PERIOD_DAYS: Array<SharePeriodDays | null> = [null, 1, 7, 30];

interface Props {
  share: ISharedItem;
}
export default function ShareActionMenu({ share }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const clipboard = useClipboard();
  const deleteShareMutation = useDeleteShareMutation();
  const setExpiry = useSetShareExpiryMutation(share.id);
  const renewExpiry = useRenewShareExpiryMutation(share.id);
  const canEdit = share.space?.userRole !== "reader";

  const openPage = () => {
    const pageLink = buildPageUrl(
      share.space.slug,
      share.page.slugId,
      share.page.title,
    );
    navigate(pageLink);
  };

  const copyLink = () => {
    const shareLink = buildSharedPageUrl({
      shareId: share.key,
      pageTitle: share.page.title,
      pageSlugId: share.page.slugId,
    });

    clipboard.copy(shareLink);
    notifications.show({ message: t("Link copied") });
  };
  const onDelete = async () => {
    deleteShareMutation.mutateAsync(share.key);
  };

  const openDeleteModal = () =>
    modals.openConfirmModal({
      title: t("Delete public share link"),
      children: (
        <Text size="sm">
          {t("Are you sure you want to delete this shared link?")}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Delete"), cancel: t("Don't") },
      confirmProps: { color: "red" },
      onConfirm: onDelete,
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
          <ActionIcon variant="subtle" c="gray" aria-label={t("More options")}>
            <IconDots size={20} stroke={2} />
          </ActionIcon>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Item onClick={copyLink} leftSection={<IconCopy size={16} />}>
            {t("Copy link")}
          </Menu.Item>

          <Menu.Item
            onClick={openPage}
            leftSection={<IconFileDescription size={16} />}
          >
            {t("Open page")}
          </Menu.Item>
          <Menu.Divider />
          <Menu.Label>{t("Link expires")}</Menu.Label>
          {PERIOD_DAYS.map((days) => (
            <Menu.Item
              key={days ?? 0}
              disabled={!canEdit}
              onClick={() => setExpiry.mutate(days)}
              rightSection={
                (share.periodDays ?? null) === days ? (
                  <IconCheck size={14} />
                ) : null
              }
            >
              {days === null
                ? t("Never")
                : days === 1
                  ? t("1 day")
                  : days === 7
                    ? t("7 days")
                    : t("30 days")}
            </Menu.Item>
          ))}
          {share.expiresAt && (
            <Menu.Item
              disabled={!canEdit}
              onClick={() => renewExpiry.mutate()}
              leftSection={<IconRefresh size={16} />}
            >
              {t("Renew")}
            </Menu.Item>
          )}
          <Menu.Divider />
          <Menu.Item
            c="red"
            onClick={openDeleteModal}
            leftSection={<IconTrash size={16} />}
            disabled={!canEdit}
          >
            {t("Delete share")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );
}
