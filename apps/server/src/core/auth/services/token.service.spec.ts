import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';
import { JwtType } from '../dto/jwt-payload';

const USER = { id: 'user_1', deactivatedAt: null, deletedAt: null } as any;

function createService() {
  const jwtService = new JwtService({
    secret: 'test-secret',
    signOptions: { expiresIn: '90d', issuer: 'Docmost' },
  });

  return { service: new TokenService(jwtService, {} as any), jwtService };
}

describe('TokenService.generateApiToken', () => {
  it('signs the token with the lifetime of the key', async () => {
    const { service, jwtService } = createService();

    const token = await service.generateApiToken({
      apiKeyId: 'key_1',
      user: USER,
      workspaceId: 'ws_1',
      expiresIn: 3600,
    });

    const { type, iat, exp } = jwtService.decode(token);
    expect(type).toBe(JwtType.API_KEY);
    expect(exp - iat).toBe(3600);
  });

  it('refuses to sign without a lifetime instead of using the session one', async () => {
    const { service } = createService();

    await expect(
      service.generateApiToken({
        apiKeyId: 'key_1',
        user: USER,
        workspaceId: 'ws_1',
        expiresIn: undefined as any,
      }),
    ).rejects.toThrow();
  });
});

describe('TokenService.generateAttachmentToken', () => {
  const opts = { attachmentId: 'a1', pageId: 'p1', workspaceId: 'ws_1' };

  it('lives one hour and is cached publicly when no lifetime is given', async () => {
    const { service, jwtService } = createService();

    const payload = jwtService.decode(
      await service.generateAttachmentToken(opts),
    );

    expect(payload.exp - payload.iat).toBe(3600);
    expect(payload).not.toHaveProperty('expiring');
  });

  it('lives only as long as asked and marks itself as belonging to an expiring link', async () => {
    const { service, jwtService } = createService();

    const payload = jwtService.decode(
      await service.generateAttachmentToken({ ...opts, expiresInSeconds: 600 }),
    );

    expect(payload.exp - payload.iat).toBe(600);
    expect(payload.expiring).toBe(true);
  });
});
