import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PatAuthGuard } from './pat-auth.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtType } from '../auth/dto/jwt-payload';
import { AccessTokenController } from './access-token.controller';

function ctx(
  headers: Record<string, string>,
  cookies: any = {},
  workspaceId?: string,
) {
  const req: any = { headers, cookies, raw: { workspaceId } };
  const reply: any = { header: jest.fn() };
  const context = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
  } as unknown as ExecutionContext;
  return { context, req, reply };
}

describe('PatAuthGuard', () => {
  const verified = {
    user: { id: 'u' },
    workspace: { id: 'w' },
    scope: 'write',
    tokenId: 't1',
  };

  it('answers 401 with WWW-Authenticate when the header is missing', async () => {
    const guard = new PatAuthGuard({ verify: jest.fn() } as any);
    const { context, reply } = ctx({});
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(reply.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
  });

  it('answers 401 for a token that does not verify', async () => {
    const guard = new PatAuthGuard({
      verify: jest.fn(async () => null),
    } as any);
    const { context, reply } = ctx({ authorization: 'Bearer dmp_nope' });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(reply.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
  });

  it('ignores the session cookie', async () => {
    const service = { verify: jest.fn(async () => verified) };
    const guard = new PatAuthGuard(service as any);
    const { context } = ctx({}, { authToken: 'dmp_' + 'a'.repeat(40) });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.verify).not.toHaveBeenCalled();
  });

  it('sets request.user and passes the resolved workspace to verify', async () => {
    const service = { verify: jest.fn(async () => verified) };
    const guard = new PatAuthGuard(service as any);
    const { context, req } = ctx({ authorization: 'Bearer dmp_x' }, {}, 'w');
    expect(await guard.canActivate(context)).toBe(true);
    expect(service.verify).toHaveBeenCalledWith('dmp_x', 'w');
    expect(req.user).toEqual({
      user: verified.user,
      workspace: verified.workspace,
      pat: { id: 't1', scope: 'write' },
    });
  });
});

describe('access token routes', () => {
  it('the create and revoke routes refuse a caller that is not a browser session', () => {
    const reflector = new Reflector();
    const guard = new JwtAuthGuard(reflector, { isCloud: () => false } as any);
    for (const handler of [
      AccessTokenController.prototype.create,
      AccessTokenController.prototype.revoke,
      AccessTokenController.prototype.list,
    ]) {
      const c: any = {
        getHandler: () => handler,
        getClass: () => AccessTokenController,
      };
      expect(() =>
        guard.handleRequest(
          null,
          { user: {}, workspace: {}, authType: JwtType.API_KEY },
          null,
          c,
        ),
      ).toThrow('interactive user session');
      expect(() =>
        guard.handleRequest(
          null,
          { user: {}, workspace: {}, authType: JwtType.OAUTH_ACCESS },
          null,
          c,
        ),
      ).toThrow('interactive user session');
    }
  });
});
