import { Badge, Button, Code, Skeleton, Table, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useTranslation } from "react-i18next";
import {
  useAccessTokensQuery,
  useRevokeAccessTokenMutation,
} from "@/features/access-token/queries/access-token-query";
import { IAccessToken } from "@/features/access-token/types/access-token.types";
import { formattedDate } from "@/lib/time";

export default function AccessTokenTable() {
  const { t } = useTranslation();
  const { data, isLoading } = useAccessTokensQuery();
  const revoke = useRevokeAccessTokenMutation();

  const confirmRevoke = (token: IAccessToken) =>
    modals.openConfirmModal({
      title: t("Revoke access token"),
      children: (
        <Text size="sm">
          {t(
            "Anything using {{name}} will stop working immediately. This cannot be undone.",
            { name: token.name },
          )}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Revoke"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => revoke.mutate({ id: token.id }),
    });

  if (isLoading) return <Skeleton height={80} />;

  if (!data?.length) {
    return (
      <Text c="dimmed" size="sm" my="md">
        {t("You have no access tokens.")}
      </Text>
    );
  }

  return (
    <Table verticalSpacing="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t("Name")}</Table.Th>
          <Table.Th>{t("Token")}</Table.Th>
          <Table.Th>{t("Access")}</Table.Th>
          <Table.Th>{t("Last used")}</Table.Th>
          <Table.Th>{t("Expires")}</Table.Th>
          <Table.Th />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {data.map((token) => (
          <Table.Tr key={token.id}>
            <Table.Td>{token.name}</Table.Td>
            <Table.Td>
              <Code>{token.tokenPrefix}…</Code>
            </Table.Td>
            <Table.Td>
              <Badge
                variant="light"
                color={token.scope === "write" ? "orange" : "gray"}
              >
                {token.scope === "write" ? t("Read and write") : t("Read only")}
              </Badge>
            </Table.Td>
            <Table.Td>
              {token.lastUsedAt
                ? formattedDate(new Date(token.lastUsedAt))
                : t("Never")}
            </Table.Td>
            <Table.Td>
              {token.expiresAt
                ? formattedDate(new Date(token.expiresAt))
                : t("Never")}
              {token.expiresAt && new Date(token.expiresAt) <= new Date() && (
                <Badge ml="xs" variant="light" color="red">
                  {t("Expired")}
                </Badge>
              )}
            </Table.Td>
            <Table.Td>
              <Button
                size="xs"
                variant="light"
                color="red"
                onClick={() => confirmRevoke(token)}
              >
                {t("Revoke")}
              </Button>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
