jest.mock('./tool-registry.service', () => ({ ToolRegistryService: class {} }));

import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { TransformHttpResponseInterceptor } from '../../common/interceptors/http-response.interceptor';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import {
  AgentMcpController,
  AgentMcpEnabledGuard,
} from './agent-mcp.controller';
import { ToolRegistryService } from './tool-registry.service';
import { buildTools } from './tool-registry';
import { AccessTokenService } from '../access-token/access-token.service';
import { PatAuthGuard } from '../access-token/pat-auth.guard';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { ALICE, buildWorld } from './testing/tool-fixtures';

const READ = 'dmp_' + '1'.repeat(40);
const WRITE = 'dmp_' + '2'.repeat(40);

// `setting` is the workspace's settings.agentMcp.enabled; null leaves it unset
async function boot(enabled = true, setting: boolean | null = true) {
  const workspace = {
    id: 'ws-1',
    settings: setting === null ? {} : { agentMcp: { enabled: setting } },
  };
  const world = buildWorld();
  const counts = new Map<string, number>();
  const verify = jest.fn(async (raw: string) =>
    raw === READ || raw === WRITE
      ? {
          user: ALICE,
          workspace: { id: 'ws-1' },
          scope: raw === WRITE ? 'write' : 'read',
          tokenId: raw === WRITE ? 'tw' : 'tr',
        }
      : null,
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [AgentMcpController],
    providers: [
      // the real one, as in main.ts: it would wrap every body in { data, success, status }
      { provide: APP_INTERCEPTOR, useClass: TransformHttpResponseInterceptor },
      AgentMcpEnabledGuard,
      PatAuthGuard,
      { provide: AccessTokenService, useValue: { verify } },
      {
        provide: ToolRegistryService,
        useValue: { tools: buildTools(world.deps) },
      },
      {
        provide: EnvironmentService,
        useValue: { isAgentMcpEnabled: () => enabled },
      },
      {
        provide: WorkspaceRepo,
        useValue: { findById: jest.fn(async () => workspace) },
      },
      {
        provide: RedisService,
        useValue: {
          getOrThrow: () => ({
            incr: async (k: string) => {
              counts.set(k, (counts.get(k) ?? 0) + 1);
              return counts.get(k);
            },
            expire: async () => 1,
          }),
        },
      },
    ],
  })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const adapter = new FastifyAdapter();
  // what DomainMiddleware puts on every request
  adapter.getInstance().addHook('onRequest', async (req: any) => {
    req.raw.workspaceId = workspace.id;
    req.raw.workspace = workspace;
  });
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, verify };
}

const post = (app: NestFastifyApplication, payload: any, token?: string) =>
  app.inject({
    method: 'POST',
    url: '/agent-mcp',
    payload,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe('AgentMcpController', () => {
  it('a missing or wrong token gets 401 from the guard', async () => {
    const { app } = await boot();
    const none = await post(app, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    const wrong = await post(
      app,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      'dmp_' + '9'.repeat(40),
    );
    expect(wrong.statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/agent-mcp' })).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('answers a request with JSON, a notification with 204, and GET with status', async () => {
    const { app } = await boot();
    const ok = await post(app, { jsonrpc: '2.0', id: 7, method: 'ping' }, READ);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    const note = await post(
      app,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      READ,
    );
    expect(note.statusCode).toBe(204);
    expect(note.body).toBe('');
    const status = await app.inject({
      method: 'GET',
      url: '/agent-mcp',
      headers: { authorization: `Bearer ${READ}` },
    });
    expect(status.json()).toEqual({ ok: true, server: 'docmost' });
    await app.close();
  });

  it('runs a tool as the token owner and enforces the token scope', async () => {
    const { app } = await boot();
    const res = await post(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_spaces', arguments: {} },
      },
      READ,
    );
    expect(res.json().result.isError).toBeUndefined();
    expect(JSON.parse(res.json().result.content[0].text).spaces).toHaveLength(
      1,
    );
    await app.close();
  });

  it('refuses a batch of eleven whole', async () => {
    const { app } = await boot();
    const batch = Array.from({ length: 11 }, (_, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'ping',
    }));
    const res = await post(app, batch, READ);
    expect(res.json().error.code).toBe(-32600);
    await app.close();
  });

  it('the route answers 404 when AGENT_MCP_ENABLED is false', async () => {
    const { app, verify } = await boot(false);
    const res = await post(
      app,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      READ,
    );
    expect(res.statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/agent-mcp' })).statusCode,
    ).toBe(404);
    expect(verify).not.toHaveBeenCalled();
    await app.close();
  });

  it('is refused while the workspace has agent access switched off, or never switched it on', async () => {
    for (const setting of [false, null]) {
      const { app, verify } = await boot(true, setting);
      const res = await post(
        app,
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        READ,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toBe(
        'Agent access is switched off for this workspace. An admin can switch it on under Settings > Access tokens.',
      );
      expect(verify).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('answers when both the server switch and the workspace setting are on', async () => {
    const { app } = await boot(true, true);
    const res = await post(
      app,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      READ,
    );
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
