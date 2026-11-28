jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(),
  generateAuthenticationOptions: jest.fn(),
  verifyRegistrationResponse: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
}));

// bcrypt at cost 12 per test made this file time out under a parallel run
jest.mock('../../common/helpers', () => ({
  ...jest.requireActual('../../common/helpers'),
  hashPassword: async (plain: string) => `hashed:${plain}`,
  comparePasswordHash: async (plain: string, hash: string) =>
    hash === `hashed:${plain}`,
}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as webauthn from '@simplewebauthn/server';
import { hashPassword } from '../../common/helpers';
import { AuditEvent } from '../../common/events/audit-events';
import {
  LOGIN_FAILED_MESSAGE,
  PasskeyService,
  RECENT_SESSION_MS,
} from './passkey.service';
import { AuthService } from '../auth/services/auth.service';

const lib = webauthn as jest.Mocked<typeof webauthn>;

class FakeRedis {
  store = new Map<string, string>();
  async set(key: string, value: string, mode?: string, ttl?: number) {
    this.store.set(key, value);
    this.lastTtl = { key, mode, ttl };
    return 'OK';
  }
  lastTtl: any;
  async getdel(key: string) {
    const v = this.store.get(key) ?? null;
    this.store.delete(key);
    return v;
  }
}

const workspace: any = { id: 'ws1', enforceSso: false };
const baseUser: any = {
  id: 'u1',
  workspaceId: 'ws1',
  email: 'a@example.com',
  name: 'Ann',
  emailVerifiedAt: new Date(),
  hasGeneratedPassword: false,
};

const storedPasskey: any = {
  id: 'pk1',
  userId: 'u1',
  workspaceId: 'ws1',
  credentialId: 'cred1',
  publicKey: Buffer.from([1, 2, 3]),
  counter: '5',
  transports: ['internal'],
  deviceType: 'multiDevice',
  backedUp: true,
  name: 'Laptop',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

let passwordHash: Promise<string> | undefined;

async function setup(opts: { user?: any; passkeys?: any[] } = {}) {
  const password = await (passwordHash ??= hashPassword('right-password'));
  const user = { ...baseUser, password, ...opts.user };
  const redis = new FakeRedis();
  const passkeyRepo = {
    findByUser: jest.fn(async () => opts.passkeys ?? []),
    findByCredentialId: jest.fn(async (id: string, ws: string) =>
      id === storedPasskey.credentialId && ws === storedPasskey.workspaceId
        ? storedPasskey
        : undefined,
    ),
    insert: jest.fn(async (row: any) => ({
      ...row,
      id: 'new1',
      createdAt: new Date('2026-02-02T10:00:00Z'),
    })),
    recordUse: jest.fn(async () => undefined),
    rename: jest.fn(async () => true),
    delete: jest.fn(async () => false),
    deleteAllForUser: jest.fn(async () => 2),
  };
  const userRepo = {
    findById: jest.fn(async () => user),
    updateLastLogin: jest.fn(async () => undefined),
  };
  const sessionService = {
    createSessionAndToken: jest.fn(async () => 'token-123'),
  };
  const mailService = { sendToQueue: jest.fn(async () => undefined) };
  const env = {
    getAppUrl: () => 'https://wiki.example.com',
    isCloud: () => false,
    getAppSecret: () => 'secret',
  };
  const audit = { log: jest.fn() };
  const service = new PasskeyService(
    passkeyRepo as any,
    userRepo as any,
    sessionService as any,
    mailService as any,
    env as any,
    { getOrThrow: () => redis } as any,
    audit as any,
  );
  return {
    service,
    redis,
    passkeyRepo,
    userRepo,
    sessionService,
    mailService,
    audit,
    user,
  };
}

const fresh = new Date();

beforeEach(() => {
  jest.resetAllMocks();
  lib.generateRegistrationOptions.mockImplementation(
    async () => ({ challenge: 'chal-' + Math.random() }) as any,
  );
  lib.generateAuthenticationOptions.mockImplementation(
    async () => ({ challenge: 'chal-' + Math.random() }) as any,
  );
});

describe('PasskeyService registration', () => {
  it('relyingParty uses the host and origin of APP_URL', async () => {
    const { service } = await setup();
    expect(service.relyingParty()).toEqual({
      rpID: 'wiki.example.com',
      origin: 'https://wiki.example.com',
      rpName: 'Docmost',
    });
  });

  it('register/options refuses a wrong current password', async () => {
    const { service, user } = await setup();
    await expect(
      service.registrationOptions(user, fresh, 'nope'),
    ).rejects.toThrow(BadRequestException);
    await expect(service.registrationOptions(user, fresh)).rejects.toThrow(
      BadRequestException,
    );
    expect(lib.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('register/options without a password is allowed only for a session under ten minutes old', async () => {
    const { service, user } = await setup({
      user: { hasGeneratedPassword: true },
    });
    await expect(
      service.registrationOptions(user, new Date()),
    ).resolves.toBeDefined();

    const old = new Date(Date.now() - RECENT_SESSION_MS - 1000);
    await expect(service.registrationOptions(user, old)).rejects.toThrow(
      new ForbiddenException('Sign in again to add a passkey'),
    );

    const sso = await setup({ user: { password: null } });
    await expect(
      sso.service.registrationOptions(sso.user, old),
    ).rejects.toThrow(ForbiddenException);
  });

  it('registration options exclude credentials the person already has and require a discoverable, verified credential', async () => {
    const { service, user } = await setup({ passkeys: [storedPasskey] });
    await service.registrationOptions(user, fresh, 'right-password');
    const args = lib.generateRegistrationOptions.mock.calls[0][0];
    expect(args.excludeCredentials).toEqual([
      { id: 'cred1', transports: ['internal'] },
    ]);
    expect(args.authenticatorSelection).toEqual({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(args.rpID).toBe('wiki.example.com');
    expect(Buffer.from(args.userID as Uint8Array).toString()).toBe('u1');
  });

  async function registered() {
    const ctx = await setup();
    const { challengeId, options } = await ctx.service.registrationOptions(
      ctx.user,
      fresh,
      'right-password',
    );
    lib.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'newcred',
          publicKey: new Uint8Array([9, 8, 7]),
          counter: 0,
          transports: ['internal', 'hybrid'],
        },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    } as any);
    return { ...ctx, challengeId, options };
  }

  it('verifyRegistration passes the stored challenge, origin and RP id to the library', async () => {
    const { service, user, challengeId, options } = await registered();
    await service.verifyRegistration(user, challengeId, { id: 'x' }, 'Phone');
    expect(lib.verifyRegistrationResponse).toHaveBeenCalledWith({
      response: { id: 'x' },
      expectedChallenge: options.challenge,
      expectedOrigin: 'https://wiki.example.com',
      expectedRPID: 'wiki.example.com',
      requireUserVerification: true,
    });
  });

  it('verifyRegistration stores credential id, public key, counter and transports, mails the owner and writes an audit event', async () => {
    const { service, user, challengeId, passkeyRepo, mailService, audit } =
      await registered();
    const result = await service.verifyRegistration(
      user,
      challengeId,
      {},
      '  Phone ',
    );
    const row = passkeyRepo.insert.mock.calls[0][0];
    expect(row).toMatchObject({
      userId: 'u1',
      workspaceId: 'ws1',
      credentialId: 'newcred',
      counter: 0,
      transports: ['internal', 'hybrid'],
      deviceType: 'multiDevice',
      backedUp: true,
      name: 'Phone',
    });
    expect([...row.publicKey]).toEqual([9, 8, 7]);
    expect(result).toMatchObject({ id: 'new1', name: 'Phone' });
    expect(mailService.sendToQueue).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@example.com' }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: AuditEvent.PASSKEY_ADDED }),
    );
  });

  it('a registration challenge cannot be used twice, and two tabs get separate challenges', async () => {
    const { service, user, redis, challengeId } = await registered();
    const second = await service.registrationOptions(
      user,
      fresh,
      'right-password',
    );
    expect(second.challengeId).not.toBe(challengeId);
    expect(redis.store.size).toBe(2);
    expect(redis.lastTtl).toMatchObject({ mode: 'EX', ttl: 300 });
    expect(redis.lastTtl.key).toBe(`passkey:reg:${second.challengeId}`);

    await service.verifyRegistration(user, challengeId, {}, 'A');
    await expect(
      service.verifyRegistration(user, challengeId, {}, 'A'),
    ).rejects.toThrow(BadRequestException);
    // the other tab's challenge is untouched
    await expect(
      service.verifyRegistration(user, second.challengeId, {}, 'B'),
    ).resolves.toBeDefined();
  });

  it('a registration challenge belongs to the person who asked for it', async () => {
    const { service, challengeId } = await registered();
    await expect(
      service.verifyRegistration(
        { ...baseUser, id: 'someone-else' },
        challengeId,
        {},
        'A',
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('PasskeyService sign-in', () => {
  async function ready(opts: Parameters<typeof setup>[0] = {}) {
    const ctx = await setup(opts);
    const { challengeId, options } = await ctx.service.loginOptions('ws1');
    lib.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    } as any);
    return { ...ctx, challengeId, options };
  }
  const assertion = { id: 'cred1', response: {} };

  it('verifyLogin passes requireUserVerification true, expectedOrigin, expectedRPID and the stored credential to the library', async () => {
    const { service, challengeId, options } = await ready();
    await service.verifyLogin(workspace, challengeId, assertion);
    const args = lib.verifyAuthenticationResponse.mock.calls[0][0];
    expect(args).toMatchObject({
      response: assertion,
      expectedChallenge: options.challenge,
      expectedOrigin: 'https://wiki.example.com',
      expectedRPID: 'wiki.example.com',
      requireUserVerification: true,
    });
    expect(args.credential.id).toBe('cred1');
    expect(args.credential.counter).toBe(5);
    expect([...args.credential.publicKey]).toEqual([1, 2, 3]);
    expect(args.credential.transports).toEqual(['internal']);
  });

  it('verifyLogin returns a session token, updates last login and writes USER_LOGIN with source passkey', async () => {
    const {
      service,
      challengeId,
      passkeyRepo,
      userRepo,
      audit,
      sessionService,
    } = await ready();
    const token = await service.verifyLogin(workspace, challengeId, assertion);
    expect(token).toBe('token-123');
    expect(sessionService.createSessionAndToken).toHaveBeenCalled();
    expect(userRepo.updateLastLogin).toHaveBeenCalledWith('u1', 'ws1');
    expect(passkeyRepo.recordUse).toHaveBeenCalledWith('pk1', 6);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuditEvent.USER_LOGIN,
        metadata: { source: 'passkey' },
      }),
    );
  });

  it('verifyLogin rejects an unknown credential, one from another workspace, and a replayed challenge', async () => {
    const a = await ready();
    await expect(
      a.service.verifyLogin(workspace, a.challengeId, { id: 'unknown' }),
    ).rejects.toThrow(UnauthorizedException);

    const b = await ready();
    await expect(
      b.service.verifyLogin(
        { ...workspace, id: 'ws2' },
        b.challengeId,
        assertion,
      ),
    ).rejects.toThrow(UnauthorizedException);

    const c = await ready();
    await c.service.verifyLogin(workspace, c.challengeId, assertion);
    await expect(
      c.service.verifyLogin(workspace, c.challengeId, assertion),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('verifyLogin rejects a disabled user and a workspace that enforces SSO', async () => {
    const d = await ready({ user: { deactivatedAt: new Date() } });
    await expect(
      d.service.verifyLogin(workspace, d.challengeId, assertion),
    ).rejects.toThrow(UnauthorizedException);
    expect(d.sessionService.createSessionAndToken).not.toHaveBeenCalled();

    const s = await ready();
    await expect(
      s.service.verifyLogin(
        { ...workspace, enforceSso: true },
        s.challengeId,
        assertion,
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(s.sessionService.createSessionAndToken).not.toHaveBeenCalled();
  });

  describe('second factor', () => {
    it('refuses in a workspace that enforces two-factor sign-in', async () => {
      const ctx = await ready();
      await expect(
        ctx.service.verifyLogin(
          { ...workspace, enforceMfa: true },
          ctx.challengeId,
          assertion,
        ),
      ).rejects.toThrow('Sign in with your password');
      expect(ctx.sessionService.createSessionAndToken).not.toHaveBeenCalled();
    });

    it('refuses a user whose two-factor sign-in is on', async () => {
      const ctx = await ready({ user: { mfa: { isEnabled: true } } });
      await expect(
        ctx.service.verifyLogin(workspace, ctx.challengeId, assertion),
      ).rejects.toThrow('Sign in with your password');
      expect(ctx.userRepo.findById).toHaveBeenCalledWith('u1', 'ws1', {
        includeUserMfa: true,
      });
      expect(ctx.sessionService.createSessionAndToken).not.toHaveBeenCalled();
    });

    it('signs in a user whose two-factor row is switched off', async () => {
      const ctx = await ready({ user: { mfa: { isEnabled: false } } });
      await expect(
        ctx.service.verifyLogin(workspace, ctx.challengeId, assertion),
      ).resolves.toBe('token-123');
    });

    it('signs in a user without two-factor sign-in', async () => {
      const ctx = await ready({ user: { mfa: null } });
      await expect(
        ctx.service.verifyLogin(
          { ...workspace, enforceMfa: false },
          ctx.challengeId,
          assertion,
        ),
      ).resolves.toBe('token-123');
    });

    it('refuses when the lookup fails', async () => {
      const ctx = await ready();
      ctx.userRepo.findById.mockImplementation(async (...args: any[]) => {
        if (args[2]?.includeUserMfa) throw new Error('db down');
        return ctx.user;
      });
      await expect(
        ctx.service.verifyLogin(workspace, ctx.challengeId, assertion),
      ).rejects.toThrow('Sign in with your password');
      expect(ctx.sessionService.createSessionAndToken).not.toHaveBeenCalled();
    });
  });

  it('all verifyLogin failures give the same error', async () => {
    const messages = new Set<string>();
    const statuses = new Set<number>();
    const record = async (p: Promise<unknown>) => {
      try {
        await p;
        throw new Error('expected a rejection');
      } catch (e: any) {
        messages.add(e.message);
        statuses.add(e.getStatus());
      }
    };

    const unknown = await ready();
    await record(
      unknown.service.verifyLogin(workspace, unknown.challengeId, { id: 'zz' }),
    );
    const missing = await ready();
    await record(missing.service.verifyLogin(workspace, 'no-such', assertion));
    const bad = await ready();
    lib.verifyAuthenticationResponse.mockRejectedValue(new Error('bad sig'));
    await record(
      bad.service.verifyLogin(workspace, bad.challengeId, assertion),
    );
    const notVerified = await ready();
    lib.verifyAuthenticationResponse.mockResolvedValue({
      verified: false,
    } as any);
    await record(
      notVerified.service.verifyLogin(
        workspace,
        notVerified.challengeId,
        assertion,
      ),
    );
    const disabled = await ready({ user: { deletedAt: new Date() } });
    await record(
      disabled.service.verifyLogin(workspace, disabled.challengeId, assertion),
    );

    expect([...messages]).toEqual([LOGIN_FAILED_MESSAGE]);
    expect([...statuses]).toEqual([401]);
  });

  it('verifyLogin rejects an assertion whose user handle is another person', async () => {
    const { service, challengeId } = await ready();
    const handle = Buffer.from('someone-else').toString('base64url');
    await expect(
      service.verifyLogin(workspace, challengeId, {
        id: 'cred1',
        response: { userHandle: handle },
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('PasskeyService management', () => {
  it("admin-delete: an admin cannot remove an owner's passkeys, but may remove their own", async () => {
    const { service, passkeyRepo, userRepo } = await setup();
    const admin: any = { id: 'a1', role: 'admin' };

    userRepo.findById.mockResolvedValueOnce({ id: 'o1', role: 'owner' } as any);
    await expect(service.adminRemoveAll(admin, 'o1', 'ws1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(passkeyRepo.deleteAllForUser).not.toHaveBeenCalled();

    userRepo.findById.mockResolvedValueOnce({ id: 'a1', role: 'admin' } as any);
    await expect(service.adminRemoveAll(admin, 'a1', 'ws1')).resolves.toBe(2);

    userRepo.findById.mockResolvedValueOnce({ id: 'o1', role: 'owner' } as any);
    await expect(
      service.adminRemoveAll({ id: 'o2', role: 'owner' } as any, 'o1', 'ws1'),
    ).resolves.toBe(2);
  });

  it('a name of only spaces is refused when adding or renaming', async () => {
    const { service, user, passkeyRepo } = await setup();
    await expect(
      service.verifyRegistration(user, 'c', {}, '   '),
    ).rejects.toThrow(BadRequestException);
    await expect(service.rename(user, 'pk1', '   ')).rejects.toThrow(
      BadRequestException,
    );
    expect(passkeyRepo.rename).not.toHaveBeenCalled();
  });

  it('the DTOs trim the name before validating it', async () => {
    const { plainToInstance } = require('class-transformer');
    const { validate } = require('class-validator');
    const {
      RegisterVerifyDto,
      RenamePasskeyDto,
    } = require('./dto/passkey.dto');
    const blank = plainToInstance(RegisterVerifyDto, {
      challengeId: 'c',
      response: {},
      name: '   ',
    });
    expect((await validate(blank)).map((e: any) => e.property)).toContain(
      'name',
    );
    const blankRename = plainToInstance(RenamePasskeyDto, {
      id: '0190a6c0-0000-7000-8000-000000000001',
      name: '  ',
    });
    expect((await validate(blankRename)).map((e: any) => e.property)).toContain(
      'name',
    );
    const ok = plainToInstance(RegisterVerifyDto, {
      challengeId: 'c',
      response: {},
      name: '  Laptop ',
    });
    expect(await validate(ok)).toHaveLength(0);
    expect(ok.name).toBe('Laptop');
  });

  it('delete refuses a passkey that belongs to someone else', async () => {
    const { service, passkeyRepo, user } = await setup();
    await expect(service.remove(user, 'pk-of-another-user')).rejects.toThrow(
      NotFoundException,
    );
    // the repo is always asked about this caller's id and workspace, never just the passkey id
    expect(passkeyRepo.delete).toHaveBeenCalledWith(
      'pk-of-another-user',
      'u1',
      'ws1',
    );
  });

  it("a password reset removes the person's passkeys", async () => {
    const trx = {
      deleteFrom: jest.fn(() => ({
        where: () => ({ where: () => ({ execute: async () => [] }) }),
      })),
    };
    const db = { transaction: () => ({ execute: (cb: any) => cb(trx) }) };
    const userTokenRepo = {
      findById: jest.fn(async () => ({
        type: 'forgot-password',
        userId: 'u1',
        expiresAt: new Date(Date.now() + 60_000),
      })),
    };
    const userPasskeyRepo = { deleteAllForUser: jest.fn(async () => 1) };
    const auth = new AuthService(
      {} as any,
      {} as any,
      {} as any,
      { deleteByUserId: jest.fn() } as any,
      {
        findById: jest.fn(async () => ({ id: 'u1' })),
        updateUser: jest.fn(),
      } as any,
      userTokenRepo as any,
      {} as any,
      {} as any,
      {} as any,
      { emitAsync: jest.fn() } as any,
      db as any,
      { log: jest.fn() } as any,
      { disconnectUser: jest.fn() } as any,
      userPasskeyRepo as any,
    );
    await auth
      .passwordReset(
        { token: 't', newPassword: 'a-new-password' } as any,
        {
          id: 'ws1',
        } as any,
      )
      .catch(() => undefined);
    expect(userPasskeyRepo.deleteAllForUser).toHaveBeenCalledWith(
      'u1',
      'ws1',
      trx,
    );
  });
});
