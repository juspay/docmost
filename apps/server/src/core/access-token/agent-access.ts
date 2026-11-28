export const AGENT_ACCESS_OFF =
  'Agent access is switched off for this workspace. An admin can switch it on under Settings > Access tokens.';

/** The workspace's own switch for agent access; off unless an admin set it. */
export function isAgentMcpOn(workspace: { settings?: unknown } | undefined) {
  return (workspace?.settings as any)?.agentMcp?.enabled === true;
}
