import { describe, expect, it } from "vitest";
import {
  claudeCodeCommand,
  jsonConfig,
  MINDSPACE_TOOL_CHANGES,
} from "./mcp-snippets";

describe("mcp snippets", () => {
  const url = "https://docs.example.com/api/agent-mcp";

  it("puts this server's url in the Claude Code command", () => {
    const cmd = claudeCodeCommand(url);
    expect(cmd).toContain(`--transport http docmost ${url}`);
    expect(cmd).toContain("Authorization: Bearer dmp_");
  });

  it("builds valid JSON config with the url", () => {
    const parsed = JSON.parse(jsonConfig(url));
    expect(parsed.mcpServers.docmost.url).toBe(url);
    expect(parsed.mcpServers.docmost.type).toBe("http");
  });

  it("lists every renamed mindspace tool", () => {
    expect(MINDSPACE_TOOL_CHANGES.map(([from]) => from).join(" ")).toContain(
      "list_workspaces",
    );
    expect(MINDSPACE_TOOL_CHANGES.length).toBe(8);
  });
});
