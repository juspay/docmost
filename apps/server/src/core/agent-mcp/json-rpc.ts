// Ported from sinha-sahil/mindspace @149db12: src/routes/mcp/+server.ts
// (JSON-RPC envelope, batch and notification handling). Changes: protocol
// version negotiation, a batch limit, per-call rate limit, zod-validated tools.
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { McpContext, McpTool, McpToolError } from './tool.types';

export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export const MAX_BATCH = 10;

export const RATE_LIMIT_MESSAGE = 'Rate limit reached, try again in a minute';
export const READ_ONLY_MESSAGE = 'This token is read-only';

const INSTRUCTIONS =
  'Use list_spaces first to find space ids, then list_pages to browse. ' +
  'Call get_page_markdown before update_page_markdown, and read its lossy_node_types.';

type RpcId = string | number | null;
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string } };

export type RpcOptions = {
  // false when the token's allowance for the minute is spent
  takeToolCall?: (tokenId: string) => Promise<boolean>;
  logger?: Pick<Logger, 'error'>;
};

const defaultLogger = new Logger('AgentMcp');

const rpcError = (
  id: RpcId,
  code: number,
  message: string,
): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

const toolError = (text: string) => ({
  isError: true,
  content: [{ type: 'text', text }],
});

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns null when nothing is to be sent back (HTTP 204). */
export async function handleRpc(
  body: unknown,
  tools: McpTool[],
  ctx: McpContext,
  opts: RpcOptions = {},
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return rpcError(null, -32600, 'Empty batch');
    }
    if (body.length > MAX_BATCH) {
      return rpcError(
        null,
        -32600,
        `Batch too large: at most ${MAX_BATCH} messages`,
      );
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      const r = await handleOne(item, tools, ctx, opts);
      if (r) responses.push(r);
    }
    return responses.length ? responses : null;
  }
  return handleOne(body, tools, ctx, opts);
}

async function handleOne(
  msg: unknown,
  tools: McpTool[],
  ctx: McpContext,
  opts: RpcOptions,
): Promise<JsonRpcResponse | null> {
  if (!isRecord(msg)) {
    return rpcError(null, -32600, 'Invalid request');
  }
  const hasId = 'id' in msg;
  const idRaw = msg.id;
  const id: RpcId =
    typeof idRaw === 'string' || typeof idRaw === 'number' ? idRaw : null;

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || !msg.method) {
    return rpcError(id, -32600, 'Invalid request');
  }
  // A message without an id is a notification: never answered.
  if (!hasId) return null;

  const method = msg.method;
  const params = isRecord(msg.params) ? msg.params : {};

  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      const protocolVersion =
        typeof asked === 'string' &&
        (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
          ? asked
          : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'docmost', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map((t) => {
            const { $schema: _s, ...inputSchema } = z.toJSONSchema(
              t.input,
            ) as Record<string, unknown>;
            return {
              name: t.name,
              description: t.description,
              inputSchema,
              annotations: { readOnlyHint: t.scope === 'read' },
            };
          }),
        },
      };
    case 'tools/call':
      return callTool(id, params, tools, ctx, opts);
    default:
      if (method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `Unknown method: ${method}`);
  }
}

async function callTool(
  id: RpcId,
  params: Record<string, unknown>,
  tools: McpTool[],
  ctx: McpContext,
  opts: RpcOptions,
): Promise<JsonRpcResponse> {
  const tool =
    typeof params.name === 'string'
      ? tools.find((t) => t.name === params.name)
      : undefined;
  if (!tool) {
    return rpcError(id, -32602, `Unknown tool: ${String(params.name ?? '')}`);
  }

  const wrap = (result: unknown): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    result,
  });
  const logger = opts.logger ?? defaultLogger;

  try {
    if (opts.takeToolCall && !(await opts.takeToolCall(ctx.tokenId))) {
      return wrap(toolError(RATE_LIMIT_MESSAGE));
    }
    if (tool.scope === 'write' && ctx.scope !== 'write') {
      return wrap(toolError(READ_ONLY_MESSAGE));
    }
    const parsed = tool.input.safeParse(params.arguments ?? {});
    if (!parsed.success) {
      return wrap(toolError(z.prettifyError(parsed.error)));
    }
    return wrap(toolResult(await tool.run(parsed.data, ctx)));
  } catch (e) {
    if (e instanceof McpToolError) return wrap(toolError(e.message));
    logger.error(
      `Tool ${tool.name} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    return wrap(toolError('Internal error'));
  }
}
