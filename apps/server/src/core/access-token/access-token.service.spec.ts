import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AccessTokenController } from './access-token.controller';
import { AGENT_ACCESS_OFF } from './agent-access';
import {
  AccessTokenService,
  hashToken,
  TOKEN_PREFIX,
} from './access-token.service';

const WS = 'ws-1';
const user: any = {
  id: 'u1',
  workspaceId: WS,
  deactivatedAt: null,
  deletedAt: null,
};
const workspace: any = { id: WS, settings: { agentMcp: { enabled: true } } };

function setup(
  overrides: {
    row?: any;
    userRow?: any;
    envOn?: boolean;
    workspaceRow?: any;
  } = {},
) {
  const inserted: any[] = [];
  const repo = {
    // the cap is applied by the repository, inside the insert's transaction
    active: 0,
    insert: jest.fn(async (v: any, maxActive: number) => {
      if (repo.active >= maxActive) return null;
      repo.active++;
      inserted.push(v);
      const { tokenHash, ...rest } = v;
      return { id: 'tok-1', createdAt: new Date(), ...rest };
    }),
    findByHash: jest.fn(async () => overrides.row),
    listByUser: jest.fn(async () => []),
    findOwned: jest.fn(async () => undefined),
    revoke: jest.fn(async () => undefined),
    touchLastUsed: jest.fn(async () => undefined),
  };
  const userRepo = {
    findById: jest.fn(async () =>
      'userRow' in overrides ? overrides.userRow : user,
    ),
  };
  const workspaceRepo = {
    findById: jest.fn(async () =>
      'workspaceRow' in overrides ? overrides.workspaceRow : workspace,
    ),
  };
  const audit = { log: jest.fn() };
  const env = { isAgentMcpEnabled: () => overrides.envOn ?? true };
  const service = new AccessTokenService(
    repo as any,
    userRepo as any,
    workspaceRepo as any,
    audit as any,
    env as any,
  );
  return { service, repo, userRepo, workspaceRepo, audit, inserted };
}

function row(extra: Partial<any> = {}) {
  return {
    id: 'tok-1',
    userId: 'u1',
    workspaceId: WS,
    scope: 'read',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    tokenHash: 'x',
    ...extra,
  };
}

const RAW = TOKEN_PREFIX + 'a'.repeat(40);

describe('AccessTokenService', () => {
  it('create returns a dmp_ token of 44 characters and stores only its hash and prefix', async () => {
    const { service, inserted } = setup();
    const out = await service.create(user, { name: 'laptop', scope: 'read' });
    expect(out.token).toMatch(/^dmp_[0-9a-f]{40}$/);
    expect(out.token).toHaveLength(44);
    expect(inserted[0].tokenHash).toBe(hashToken(out.token));
    expect(inserted[0].tokenPrefix).toBe(out.token.slice(0, 12));
    expect(JSON.stringify(inserted[0])).not.toContain(out.token);
  });

  it('list never returns token_hash', async () => {
    const { service, repo } = setup();
    repo.listByUser.mockResolvedValue([
      { id: 'a', tokenHash: 'secret', tokenPrefix: 'dmp_abcd1234' },
    ] as any);
    const out = await service.list(user);
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('tokenHash');
  });

  it('verify accepts a fresh token and returns its user, workspace and scope', async () => {
    const { service } = setup({ row: row({ scope: 'write' }) });
    const out = await service.verify(RAW);
    expect(out).toEqual({
      user,
      workspace,
      scope: 'write',
      tokenId: 'tok-1',
    });
  });

  it('verify rejects a malformed token without querying the database', async () => {
    const { service, repo } = setup();
    for (const bad of [
      '',
      'dmp_short',
      'abc_' + 'a'.repeat(40),
      RAW + 'a',
      'dmp_' + 'g'.repeat(40),
    ]) {
      expect(await service.verify(bad)).toBeNull();
    }
    expect(repo.findByHash).not.toHaveBeenCalled();
  });

  it('verify rejects revoked, expired, and disabled-user tokens', async () => {
    const past = new Date(Date.now() - 1000);
    expect(
      await setup({ row: row({ revokedAt: past }) }).service.verify(RAW),
    ).toBeNull();
    expect(
      await setup({ row: row({ expiresAt: past }) }).service.verify(RAW),
    ).toBeNull();
    expect(await setup({ row: undefined }).service.verify(RAW)).toBeNull();
    expect(
      await setup({
        row: row(),
        userRow: { ...user, deactivatedAt: past },
      }).service.verify(RAW),
    ).toBeNull();
    expect(
      await setup({
        row: row(),
        userRow: { ...user, deletedAt: past },
      }).service.verify(RAW),
    ).toBeNull();
    expect(
      await setup({ row: row(), userRow: undefined }).service.verify(RAW),
    ).toBeNull();
  });

  it('verify rejects a token used on another workspace host', async () => {
    const { service } = setup({ row: row() });
    expect(await service.verify(RAW, 'other-ws')).toBeNull();
    expect(await service.verify(RAW, WS)).not.toBeNull();
  });

  it('last_used_at is not rewritten within a minute', async () => {
    const recent = setup({
      row: row({ lastUsedAt: new Date(Date.now() - 10_000) }),
    });
    await recent.service.verify(RAW);
    expect(recent.repo.touchLastUsed).not.toHaveBeenCalled();

    const stale = setup({
      row: row({ lastUsedAt: new Date(Date.now() - 120_000) }),
    });
    await stale.service.verify(RAW);
    expect(stale.repo.touchLastUsed).toHaveBeenCalledTimes(1);

    const never = setup({ row: row() });
    await never.service.verify(RAW);
    expect(never.repo.touchLastUsed).toHaveBeenCalledTimes(1);
  });

  it('the 21st token is refused', async () => {
    const { service, repo, inserted } = setup();
    repo.active = 20;
    await expect(
      service.create(user, { name: 'x', scope: 'read' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.insert).toHaveBeenCalledWith(expect.anything(), 20);
    expect(inserted).toEqual([]);
  });

  it('revoke refuses a token that belongs to someone else', async () => {
    const { service, repo } = setup();
    repo.findOwned.mockResolvedValue(undefined);
    await expect(service.revoke(user, 'tok-9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.revoke).not.toHaveBeenCalled();
  });

  it('revoke revokes an owned token and audits it', async () => {
    const { service, repo, audit } = setup();
    repo.findOwned.mockResolvedValue({ id: 'tok-1', name: 'n' } as any);
    await service.revoke(user, 'tok-1');
    expect(repo.revoke).toHaveBeenCalledWith('tok-1');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'access_token.revoked',
        resourceId: 'tok-1',
      }),
    );
  });

  it('a token stops working when its user is deactivated', async () => {
    const live = setup({ row: row() });
    expect(await live.service.verify(RAW)).not.toBeNull();
    const gone = setup({
      row: row(),
      userRow: { ...user, deactivatedAt: new Date() },
    });
    expect(await gone.service.verify(RAW)).toBeNull();
    // the user is loaded on every call, never cached
    await live.service.verify(RAW);
    expect(live.userRepo.findById).toHaveBeenCalledTimes(2);
  });

  describe('while agent access is off', () => {
    const off = (over: any) => {
      const { service, inserted } = setup(over);
      return { service, inserted };
    };
    it.each([
      [
        'the workspace setting is off',
        {
          workspaceRow: { id: WS, settings: { agentMcp: { enabled: false } } },
        },
      ],
      [
        'the workspace never switched it on',
        { workspaceRow: { id: WS, settings: {} } },
      ],
      ['the server switch is off', { envOn: false }],
    ])(
      'creating a token is refused when %s, for an admin too',
      async (_l, over) => {
        for (const role of ['member', 'admin', 'owner']) {
          const { service, inserted } = off(over);
          const err = await service
            .create({ ...user, role }, { name: 'x', scope: 'write' })
            .catch((e) => e);
          expect(err).toBeInstanceOf(ForbiddenException);
          expect(err.message).toBe(AGENT_ACCESS_OFF);
          expect(inserted).toEqual([]);
        }
      },
    );
  });

  it('the controller passes the refusal on as 403', async () => {
    const { service } = setup({ envOn: false });
    const controller = new AccessTokenController(service);
    const err = await controller
      .create({ name: 'x', scope: 'read' } as any, user)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
  });
});
