import { buildTools } from './tool-registry';
import { handleRpc } from './json-rpc';
import { McpToolError, NOT_FOUND } from './tool.types';
import { buildWorld, toolFixtures } from './testing/tool-fixtures';

const world = buildWorld();
const allTools = buildTools(world.deps);
const writeTools = allTools.filter((t) => t.scope === 'write');

describe('tool registry (every registered tool)', () => {
  it.each(allTools.map((t) => [t.name, t] as const))(
    '%s: has a fixture',
    (name) => {
      expect(toolFixtures[name]).toBeDefined();
    },
  );

  it('has no fixture for a tool that is not registered', () => {
    const names = allTools.map((t) => t.name);
    expect(Object.keys(toolFixtures).filter((n) => !names.includes(n))).toEqual(
      [],
    );
  });

  it.each(allTools.map((t) => [t.name, t] as const))(
    '%s: unknown id and no-access give the same NOT_FOUND message',
    async (name, tool) => {
      const fixture = toolFixtures[name];
      expect(fixture).toBeDefined();
      const ctx = world.ctx('write');

      if (fixture.probes === null) {
        // a tool with no id argument has nothing to probe
        const props = Object.keys((tool.input as any).shape ?? {});
        expect(props.filter((p) => /id$/.test(p))).toEqual([]);
        return;
      }

      const messages: string[] = [];
      for (const args of [fixture.probes.noAccess, fixture.probes.missing]) {
        const parsed = tool.input.parse(args);
        try {
          await tool.run(parsed, ctx);
          throw new Error('expected the tool to refuse');
        } catch (e) {
          expect(e).toBeInstanceOf(McpToolError);
          messages.push((e as Error).message);
        }
      }
      expect(messages).toEqual([NOT_FOUND, NOT_FOUND]);
    },
  );

  if (writeTools.length > 0) {
    it.each(writeTools.map((t) => [t.name, t] as const))(
      '%s: is refused with a read token',
      async (name) => {
        const res: any = await handleRpc(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: toolFixtures[name].valid },
          },
          allTools,
          world.ctx('read'),
        );
        expect(res.result.isError).toBe(true);
        expect(res.result.content[0].text).toContain('This token is read-only');
      },
    );
  } else {
    it('has no write tools yet', () => {
      expect(writeTools).toEqual([]);
    });
  }
});
