import {
  Box,
  Code,
  CopyButton,
  ActionIcon,
  Group,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { getBackendUrl } from "@/lib/config";
import {
  claudeCodeCommand,
  jsonConfig,
  MINDSPACE_TOOL_CHANGES,
} from "@/features/access-token/mcp-snippets";

function Snippet({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  return (
    <Box>
      <Group justify="space-between" mb={4}>
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <CopyButton value={value} timeout={2000}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? t("Copied") : t("Copy")} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={copy}
                aria-label={t("Copy")}
              >
                {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
      <Code block>{value}</Code>
    </Box>
  );
}

export default function McpSetup() {
  const { t } = useTranslation();
  const url = `${getBackendUrl()}/agent-mcp`;

  return (
    <Stack gap="md" mt="xl" data-testid="mcp-setup">
      <Text fw={600} size="lg">
        {t("Connect an AI agent (MCP)")}
      </Text>
      <Text size="sm" c="dimmed">
        {t("Create a token above, then point your agent at this endpoint.")}
      </Text>

      <Snippet label={t("Endpoint")} value={url} />
      <Snippet label={t("Claude Code")} value={claudeCodeCommand(url)} />
      <Snippet
        label={t("Other clients (JSON config)")}
        value={jsonConfig(url)}
      />

      <Box>
        <Text size="sm" fw={500} mb={4}>
          {t("Coming from mindspace? What changed")}
        </Text>
        <Table withTableBorder verticalSpacing="xs" fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("Mindspace")}</Table.Th>
              <Table.Th>{t("Docmost")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {MINDSPACE_TOOL_CHANGES.map(([from, to]) => (
              <Table.Tr key={from}>
                <Table.Td>
                  <Code>{from}</Code>
                </Table.Td>
                <Table.Td>{to}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </Stack>
  );
}
