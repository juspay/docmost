// bcrypt at cost 12 per test made this file time out under a parallel run
jest.mock('../../../common/helpers', () => ({
  ...jest.requireActual('../../../common/helpers'),
  hashPassword: async (plain: string) => `hashed:${plain}`,
  comparePasswordHash: async (plain: string, hash: string) =>
    hash === `hashed:${plain}`,
}));

import { hashPassword } from '../../../common/helpers';
import { AuthService } from './auth.service';

// Password reset and change are recovery steps: a token minted with a stolen
// session must not outlive them.
describe('AuthService and personal access tokens', () => {
  function setup() {
    const events: string[] = [];
    const trx = {
      deleteFrom: jest.fn(() => ({
        where: () => ({ where: () => ({ execute: async () => [] }) }),
      })),
    };
    const db = {
      transaction: () => ({
        execute: async (cb: any) => {
          events.push('tx:start');
          const out = await cb(trx);
          events.push('tx:commit');
          return out;
        },
      }),
    };
    const userRepo = {
      findById: jest.fn(async () => ({
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.test',
        password: undefined as string | undefined,
      })),
      updateUser: jest.fn(async (_v: any, _u: any, _w: any, t?: any) => {
        events.push(t === trx ? 'password:in-tx' : 'password:outside-tx');
      }),
    };
    const accessTokenRepo = {
      revokeAllForUser: jest.fn(async (_u: any, _w: any, t?: any) => {
        events.push(t === trx ? 'tokens:in-tx' : 'tokens:outside-tx');
        return 2;
      }),
    };
    const userTokenRepo = {
      findById: jest.fn(async () => ({
        type: 'forgot-password',
        userId: 'u1',
        expiresAt: new Date(Date.now() + 60_000),
      })),
    };
    const audit = { log: jest.fn(), setActorId: jest.fn() };
    const auth = new AuthService(
      {} as any,
      {} as any,
      { createSessionAndToken: jest.fn(async () => 'session-token') } as any,
      {
        deleteByUserId: jest.fn(),
        deleteAllExceptCurrent: jest.fn(),
      } as any,
      userRepo as any,
      userTokenRepo as any,
      { sendToQueue: jest.fn() } as any,
      {} as any,
      { isCloud: () => false } as any,
      { emitAsync: jest.fn() } as any,
      db as any,
      audit as any,
      { disconnectUser: jest.fn(), disconnectOtherSessions: jest.fn() } as any,
      { deleteAllForUser: jest.fn(async () => 0) } as any,
      accessTokenRepo as any,
    );
    return { auth, events, accessTokenRepo, userRepo, audit };
  }

  it('a password reset revokes all of the person’s access tokens in the same transaction', async () => {
    const { auth, events, accessTokenRepo } = setup();
    await auth.passwordReset(
      { token: 't', newPassword: 'a-new-password' } as any,
      { id: 'ws1' } as any,
    );
    expect(accessTokenRepo.revokeAllForUser).toHaveBeenCalledWith(
      'u1',
      'ws1',
      expect.anything(),
    );
    expect(events.slice(0, 4)).toEqual([
      'tx:start',
      'password:in-tx',
      'tokens:in-tx',
      'tx:commit',
    ]);
  });

  it('a password change revokes all of the person’s access tokens with the new password', async () => {
    const { auth, events, accessTokenRepo, userRepo } = setup();
    const current = await hashPassword('the-old-password');
    userRepo.findById.mockResolvedValue({
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.test',
      password: current,
    });
    await auth.changePassword(
      { oldPassword: 'the-old-password', newPassword: 'a-new-password' } as any,
      'u1',
      'ws1',
      'session-1',
    );
    expect(accessTokenRepo.revokeAllForUser).toHaveBeenCalledWith(
      'u1',
      'ws1',
      expect.anything(),
    );
    expect(events).toEqual([
      'tx:start',
      'password:in-tx',
      'tokens:in-tx',
      'tx:commit',
    ]);
  });

  it('a wrong current password revokes nothing', async () => {
    const { auth, accessTokenRepo, userRepo } = setup();
    userRepo.findById.mockResolvedValue({
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.test',
      password: await hashPassword('the-old-password'),
    });
    await expect(
      auth.changePassword(
        { oldPassword: 'wrong', newPassword: 'a-new-password' } as any,
        'u1',
        'ws1',
      ),
    ).rejects.toThrow('Current password is incorrect');
    expect(accessTokenRepo.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('the revocation is audited, with the reason and the count', async () => {
    const { auth, audit } = setup();
    await auth.passwordReset(
      { token: 't', newPassword: 'a-new-password' } as any,
      { id: 'ws1' } as any,
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'access_token.revoked',
        resourceType: 'user',
        resourceId: 'u1',
        metadata: { reason: 'password_reset', count: 2 },
      }),
    );
    // the reset request is not signed in: the entry names the person as actor
    const order = [
      ...audit.setActorId.mock.invocationCallOrder.map((n) => ['actor', n]),
      ...audit.log.mock.invocationCallOrder.map((n) => ['log', n]),
    ]
      .sort((a: any, b: any) => a[1] - b[1])
      .map((x) => x[0]);
    expect(order[0]).toBe('actor');
    expect(audit.setActorId).toHaveBeenCalledWith('u1');
  });
});
