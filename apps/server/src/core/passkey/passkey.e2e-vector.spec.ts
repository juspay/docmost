// Uses the real @simplewebauthn/server: nothing about the library is mocked.
import { UnauthorizedException } from '@nestjs/common';
import { PasskeyService } from './passkey.service';
import { SoftwareAuthenticator } from './testing/software-authenticator';

const APP_URL = 'https://wiki.example.com';
const user: any = {
  id: '0190a6c0-0000-7000-8000-000000000001',
  workspaceId: 'ws1',
  email: 'a@example.com',
  name: 'Ann',
  emailVerifiedAt: new Date(),
  password: null,
  hasGeneratedPassword: true,
};
const workspace: any = { id: 'ws1', enforceSso: false };

class FakeRedis {
  store = new Map<string, string>();
  async set(key: string, value: string, _mode?: string, _ttl?: number) {
    this.store.set(key, value);
    return 'OK';
  }
  async getdel(key: string) {
    const v = this.store.get(key) ?? null;
    this.store.delete(key);
    return v;
  }
}

function build() {
  const rows: any[] = [];
  const passkeyRepo = {
    findByUser: async () => rows,
    findByCredentialId: async (id: string, ws: string) =>
      rows.find((r) => r.credentialId === id && r.workspaceId === ws),
    insert: async (row: any) => {
      const saved = { ...row, id: 'pk1', createdAt: new Date() };
      rows.push(saved);
      return saved;
    },
    recordUse: async (id: string, counter: number) => {
      rows.find((r) => r.id === id).counter = String(counter);
    },
  };
  const redis = new FakeRedis();
  const service = new PasskeyService(
    passkeyRepo as any,
    {
      findById: async () => user,
      updateLastLogin: async () => undefined,
    } as any,
    { createSessionAndToken: async () => 'token' } as any,
    { sendToQueue: async () => undefined } as any,
    {
      getAppUrl: () => APP_URL,
      isCloud: () => false,
      getAppSecret: () => 's',
    } as any,
    { getOrThrow: () => redis } as any,
    { log: () => undefined } as any,
  );
  const authenticator = new SoftwareAuthenticator({
    rpID: 'wiki.example.com',
    origin: APP_URL,
    userHandle: user.id,
    backedUp: true,
  });
  return { service, rows, authenticator };
}

async function register(ctx: ReturnType<typeof build>) {
  const { challengeId, options } = await ctx.service.registrationOptions(
    user,
    new Date(),
  );
  return ctx.service.verifyRegistration(
    user,
    challengeId,
    ctx.authenticator.createRegistrationResponse(options.challenge),
    'Test key',
  );
}

async function signIn(ctx: ReturnType<typeof build>) {
  const { challengeId, options } = await ctx.service.loginOptions('ws1');
  return ctx.service.verifyLogin(
    workspace,
    challengeId,
    ctx.authenticator.createAssertion(options.challenge),
  );
}

describe('passkeys end to end with the real library', () => {
  it('a registration and a sign-in made by the software authenticator verify end to end', async () => {
    const ctx = build();
    await register(ctx);
    expect(ctx.rows).toHaveLength(1);
    expect(ctx.rows[0].credentialId).toBe(ctx.authenticator.id);
    expect(ctx.rows[0].deviceType).toBe('multiDevice');

    ctx.authenticator.counter = 1;
    await expect(signIn(ctx)).resolves.toBe('token');
    expect(ctx.rows[0].counter).toBe('1');
  });

  it('a sign-in with user verification switched off is refused', async () => {
    const ctx = build();
    await register(ctx);
    const noUv = new SoftwareAuthenticator({
      rpID: 'wiki.example.com',
      origin: APP_URL,
      userHandle: user.id,
      userVerified: false,
    });
    // same credential, but the authenticator reports that it did not verify the person
    Object.assign(noUv, {
      credentialId: (ctx.authenticator as any).credentialId,
      keys: (ctx.authenticator as any).keys,
    });
    ctx.authenticator = noUv;
    await expect(signIn(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('a synced passkey reporting counter 0 twice is accepted', async () => {
    const ctx = build();
    await register(ctx);
    ctx.authenticator.counter = 0;
    await expect(signIn(ctx)).resolves.toBe('token');
    await expect(signIn(ctx)).resolves.toBe('token');
  });

  it('a counter that goes backwards is rejected', async () => {
    const ctx = build();
    await register(ctx);
    ctx.authenticator.counter = 7;
    await expect(signIn(ctx)).resolves.toBe('token');
    ctx.authenticator.counter = 3;
    await expect(signIn(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('an assertion for another origin is rejected', async () => {
    const ctx = build();
    await register(ctx);
    const other = new SoftwareAuthenticator({
      rpID: 'wiki.example.com',
      origin: 'https://evil.example.com',
      userHandle: user.id,
    });
    Object.assign(other, {
      credentialId: (ctx.authenticator as any).credentialId,
      keys: (ctx.authenticator as any).keys,
    });
    ctx.authenticator = other;
    await expect(signIn(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
