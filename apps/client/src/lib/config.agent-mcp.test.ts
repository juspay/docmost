import { afterEach, describe, expect, it } from "vitest";
import { isAgentMcpEnabled } from "./config";

describe("isAgentMcpEnabled", () => {
  const before = process.env.AGENT_MCP_ENABLED;
  afterEach(() => {
    if (before === undefined) delete process.env.AGENT_MCP_ENABLED;
    else process.env.AGENT_MCP_ENABLED = before;
  });

  it("is on when the server says nothing", () => {
    delete process.env.AGENT_MCP_ENABLED;
    expect(isAgentMcpEnabled()).toBe(true);
  });

  it("is off when the server turned it off", () => {
    process.env.AGENT_MCP_ENABLED = "false";
    expect(isAgentMcpEnabled()).toBe(false);
  });

  it("is on when the server turned it on", () => {
    process.env.AGENT_MCP_ENABLED = "true";
    expect(isAgentMcpEnabled()).toBe(true);
  });
});
