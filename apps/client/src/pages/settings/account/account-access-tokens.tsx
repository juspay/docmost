import { useState } from "react";
import { Button, Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import AccessTokenTable from "@/features/access-token/components/access-token-table";
import CreateAccessTokenModal from "@/features/access-token/components/create-access-token-modal";
import McpSetup from "@/features/access-token/components/mcp-setup";
import AccessTokenCreatedModal from "@/features/access-token/components/access-token-created-modal";
import AgentAccessSwitch, {
  useAgentAccessOn,
} from "@/features/access-token/components/agent-access-switch";

export default function AccountAccessTokens() {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const agentAccessOn = useAgentAccessOn();

  return (
    <>
      <DocumentTitle title={t("Access tokens")} />
      <SettingsTitle title={t("Access tokens")} />

      <AgentAccessSwitch />

      <Group justify="space-between" mb="md" wrap="nowrap" align="flex-start">
        <Text size="sm" c="dimmed">
          {t(
            "Personal access tokens let tools such as Claude Code act as you through the MCP endpoint.",
          )}
        </Text>
        <Button onClick={() => setCreating(true)} disabled={!agentAccessOn}>
          {t("New token")}
        </Button>
      </Group>

      <AccessTokenTable />

      <McpSetup />

      <CreateAccessTokenModal
        opened={creating}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          setCreatedToken(created.token);
        }}
      />
      <AccessTokenCreatedModal
        token={createdToken}
        onClose={() => setCreatedToken(null)}
      />
    </>
  );
}
