import { z } from 'zod';
import { handleRpc, MAX_BATCH, SUPPORTED_PROTOCOL_VERSIONS } from './json-rpc';
import { McpContext, McpTool, McpToolError } from './tool.types';
import { takeToolCall, TOOL_CALLS_PER_MINUTE } from './rate-limit';

const ctx = (
  scope: 'read' | 'write' = 'write',
  tokenId = 't1',
): McpContext => ({
  user: { id: 'u' } as any,
  workspace: { id: 'w' } as any,
  scope,
  tokenId,
});

const echo: McpTool = {
  name: 'echo',
  description: 'echo',
  scope: 'read',
  input: z.object({ text: z.string() }),
  run: async (a) => ({ said: a.text }),
};
const writer: McpTool = {
  name: 'writer',
  description: 'w',
  scope: 'write',
  input: z.object({}),
  run: async () => 'wrote',
};
const boom: McpTool = {
  name: 'boom',
  description: 'b',
  scope: 'read',
  input: z.object({}),
  run: async () => {
    throw new Error('secret db detail');
  },
};
const polite: McpTool = {
  name: 'polite',
  description: 'p',
  scope: 'read',
  input: z.object({}),
  run: async () => {
    throw new McpToolError('Not found, or you do not have access');
  },
};
const tools = [echo, writer, boom, polite];

const call = (name: string, args: unknown = {}, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('handleRpc', () => {
  it('initialize echoes a supported protocol version and falls back for an unknown one', async () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      const r: any = await handleRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: v },
        },
        tools,
        ctx(),
      );
      expect(r.result.protocolVersion).toBe(v);
    }
    const r: any = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '1999-01-01' },
      },
      tools,
      ctx(),
    );
    expect(r.result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(r.result.serverInfo.name).toBe('docmost');
  });

  it('tools/list returns every registered tool with a JSON Schema', async () => {
    const r: any = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      tools,
      ctx(),
    );
    expect(r.result.tools.map((t: any) => t.name)).toEqual(
      tools.map((t) => t.name),
    );
    const e = r.result.tools[0];
    expect(e.inputSchema.type).toBe('object');
    expect(e.inputSchema.properties.text.type).toBe('string');
    expect(e.inputSchema.required).toEqual(['text']);
  });

  it('a batch returns an array in order; notifications-only returns 204', async () => {
    const r: any = await handleRpc(
      [
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        call('echo', { text: 'hi' }, 'b'),
      ],
      tools,
      ctx(),
    );
    expect(r.map((x: any) => x.id)).toEqual(['a', 'b']);
    expect(
      await handleRpc(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        tools,
        ctx(),
      ),
    ).toBeNull();
    expect(
      await handleRpc(
        [{ jsonrpc: '2.0', method: 'notifications/cancelled' }],
        tools,
        ctx(),
      ),
    ).toBeNull();
  });

  it('a batch of eleven is refused whole', async () => {
    const calls = Array.from({ length: MAX_BATCH + 1 }, (_, i) =>
      call('writer', {}, i),
    );
    const run = jest.spyOn(writer, 'run');
    const r: any = await handleRpc(calls, tools, ctx());
    expect(Array.isArray(r)).toBe(false);
    expect(r.error.code).toBe(-32600);
    expect(run).not.toHaveBeenCalled();
    const ok: any = await handleRpc(calls.slice(0, MAX_BATCH), tools, ctx());
    expect(ok).toHaveLength(MAX_BATCH);
  });

  it('an unknown method gives -32601; a malformed envelope gives -32600; an unknown tool gives -32602', async () => {
    expect(
      (
        (await handleRpc(
          { jsonrpc: '2.0', id: 1, method: 'nope' },
          tools,
          ctx(),
        )) as any
      ).error.code,
    ).toBe(-32601);
    for (const bad of [
      null,
      'x',
      5,
      { id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 1, method: 7 },
    ]) {
      expect(((await handleRpc(bad, tools, ctx())) as any).error.code).toBe(
        -32600,
      );
    }
    expect(
      ((await handleRpc(call('missing'), tools, ctx())) as any).error.code,
    ).toBe(-32602);
  });

  it('a write tool called with a read token is refused with isError', async () => {
    const run = jest.spyOn(writer, 'run');
    run.mockClear();
    const r: any = await handleRpc(call('writer'), tools, ctx('read'));
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toBe('This token is read-only');
    expect(run).not.toHaveBeenCalled();
    const ok: any = await handleRpc(call('writer'), tools, ctx('write'));
    expect(ok.result.isError).toBeUndefined();
  });

  it('arguments that fail the schema are refused with isError', async () => {
    const r: any = await handleRpc(call('echo', { text: 5 }), tools, ctx());
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/text/);
  });

  it('a McpToolError message reaches the caller', async () => {
    const r: any = await handleRpc(call('polite'), tools, ctx());
    expect(r.result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Not found, or you do not have access' }],
    });
  });

  it('an unexpected exception is reported as Internal error and logged', async () => {
    const logger = { error: jest.fn() };
    const r: any = await handleRpc(call('boom'), tools, ctx(), { logger });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toBe('Internal error');
    expect(JSON.stringify(r)).not.toContain('secret db detail');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('secret db detail'),
    );
  });

  it('the 121st tool call in a minute for one token is refused, and another token is unaffected', async () => {
    const counts = new Map<string, number>();
    const redis = {
      incr: async (k: string) => {
        const n = (counts.get(k) ?? 0) + 1;
        counts.set(k, n);
        return n;
      },
      expire: async () => 1,
    };
    const opts = {
      takeToolCall: (id: string) => takeToolCall(redis as any, id),
    };
    for (let i = 0; i < TOOL_CALLS_PER_MINUTE; i++) {
      const r: any = await handleRpc(
        call('echo', { text: 'x' }),
        tools,
        ctx('read', 'A'),
        opts,
      );
      expect(r.result.isError).toBeUndefined();
    }
    const refused: any = await handleRpc(
      call('echo', { text: 'x' }),
      tools,
      ctx('read', 'A'),
      opts,
    );
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toBe(
      'Rate limit reached, try again in a minute',
    );
    const other: any = await handleRpc(
      call('echo', { text: 'x' }),
      tools,
      ctx('read', 'B'),
      opts,
    );
    expect(other.result.isError).toBeUndefined();
  });
});
