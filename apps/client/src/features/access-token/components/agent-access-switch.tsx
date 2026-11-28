import { useState } from "react";
import { Alert, Group, Switch, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import useUserRole from "@/hooks/use-user-role.tsx";

/** The workspace switch for agent access through access tokens; off by default. */
export function useAgentAccessOn(): boolean {
  const [workspace] = useAtom(workspaceAtom);
  return workspace?.settings?.agentMcp?.enabled === true;
}

export default function AgentAccessSwitch() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const on = useAgentAccessOn();
  const [saving, setSaving] = useState(false);

  if (!isAdmin) {
    if (on) return null;
    return (
      <Alert color="gray" mb="md" variant="light">
        {t(
          "Agent access is switched off for this workspace. An admin has to switch it on before you can create tokens.",
        )}
      </Alert>
    );
  }

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    setSaving(true);
    try {
      const updated = await updateWorkspace({ agentMcpEnabled: value });
      setWorkspace({
        ...workspace,
        ...updated,
        settings: updated?.settings ?? workspace?.settings,
      });
    } catch (err) {
      notifications.show({
        message: err?.response?.data?.message,
        color: "red",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Group justify="space-between" wrap="nowrap" gap="xl" mb="lg">
      <div>
        <Text size="md">{t("Agent access")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Lets members use access tokens with AI agents through the MCP endpoint. Only admins can change this.",
          )}
        </Text>
      </div>
      <Switch
        checked={on}
        disabled={saving}
        onChange={handleChange}
        aria-label={t("Toggle agent access")}
      />
    </Group>
  );
}
