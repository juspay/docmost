import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PasskeyController, PasskeyEnabledGuard } from './passkey.controller';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import { AUTH_THROTTLER } from '../../integrations/throttle/throttler-names';
import { REQUIRE_SESSION_AUTH_KEY } from '../../common/decorators/require-session-auth.decorator';

function makeController() {
  const passkeyService = {
    adminRemoveAll: jest.fn(async () => 2),
    verifyLogin: jest.fn(async () => 'jwt-token'),
    registrationOptions: jest.fn(async () => ({
      challengeId: 'c',
      options: {},
    })),
  };
  const expires = new Date('2026-12-01T00:00:00Z');
  const env = {
    getCookieExpiresIn: () => expires,
    isHttps: () => true,
    isCloud: () => false,
  };
  const userSessionRepo = {
    findActiveById: jest.fn(async () => ({ createdAt: new Date() })),
  };
  const controller = new PasskeyController(
    passkeyService as any,
    env as any,
    userSessionRepo as any,
    new WorkspaceAbilityFactory(),
  );
  return { controller, passkeyService, userSessionRepo, expires };
}

const workspace: any = { id: 'ws1' };

describe('PasskeyController', () => {
  it('admin-delete is refused for a member and removes all passkeys for an admin', async () => {
    const { controller, passkeyService } = makeController();
    await expect(
      controller.adminDelete(
        { userId: 'u2' },
        { id: 'u1', role: 'member' } as any,
        workspace,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(passkeyService.adminRemoveAll).not.toHaveBeenCalled();

    await controller.adminDelete(
      { userId: 'u2' },
      { id: 'u1', role: 'admin' } as any,
      workspace,
    );
    expect(passkeyService.adminRemoveAll).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      'u2',
      'ws1',
    );

    await controller.adminDelete(
      { userId: 'u2' },
      { id: 'u3', role: 'owner' } as any,
      workspace,
    );
    expect(passkeyService.adminRemoveAll).toHaveBeenCalledTimes(2);
  });

  it('login/verify sets the authToken cookie with httpOnly, sameSite lax and path /', async () => {
    const { controller, expires } = makeController();
    const res = { setCookie: jest.fn() };
    await controller.loginVerify(
      { challengeId: 'c', response: {} },
      workspace,
      res as any,
    );
    expect(res.setCookie).toHaveBeenCalledWith('authToken', 'jwt-token', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires,
      secure: true,
    });
  });

  it('register/options needs a live session to measure its age', async () => {
    const { controller, userSessionRepo, passkeyService } = makeController();
    await expect(
      controller.registerOptions({}, { id: 'u1' } as any, { raw: {} } as any),
    ).rejects.toThrow(ForbiddenException);

    userSessionRepo.findActiveById.mockResolvedValueOnce(undefined);
    await expect(
      controller.registerOptions(
        { currentPassword: 'x' },
        { id: 'u1' } as any,
        { raw: { sessionId: 's1' } } as any,
      ),
    ).rejects.toThrow(ForbiddenException);

    await controller.registerOptions(
      { currentPassword: 'x' },
      { id: 'u1' } as any,
      { raw: { sessionId: 's1' } } as any,
    );
    expect(passkeyService.registrationOptions).toHaveBeenCalledWith(
      { id: 'u1' },
      expect.any(Date),
      'x',
    );
  });

  it('every route that acts on a signed-in person refuses token-authenticated callers', () => {
    const proto = PasskeyController.prototype as any;
    for (const name of [
      'registerOptions',
      'registerVerify',
      'list',
      'rename',
      'delete',
      'adminDelete',
    ]) {
      expect(Reflect.getMetadata(REQUIRE_SESSION_AUTH_KEY, proto[name])).toBe(
        true,
      );
    }
    for (const name of ['loginOptions', 'loginVerify']) {
      expect(
        Reflect.getMetadata(REQUIRE_SESSION_AUTH_KEY, proto[name]),
      ).toBeUndefined();
    }
  });

  it('register/options also carries the password-login limit', () => {
    const proto = PasskeyController.prototype as any;
    expect(
      Reflect.getMetadata(
        'THROTTLER:SKIP' + AUTH_THROTTLER,
        proto.registerOptions,
      ),
    ).toBe(false);
    expect(
      Reflect.getMetadata('THROTTLER:SKIP' + AUTH_THROTTLER, PasskeyController),
    ).toBe(true);
    expect(
      Reflect.getMetadata('THROTTLER:SKIP' + AUTH_THROTTLER, proto.list),
    ).toBeUndefined();
  });

  it('answers 404 on cloud', () => {
    const cloud = new PasskeyEnabledGuard({ isCloud: () => true } as any);
    expect(() => cloud.canActivate()).toThrow(NotFoundException);
    const selfHosted = new PasskeyEnabledGuard({ isCloud: () => false } as any);
    expect(selfHosted.canActivate()).toBe(true);
  });
});
