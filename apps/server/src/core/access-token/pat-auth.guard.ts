import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AccessTokenService } from './access-token.service';
import { extractBearerTokenFromHeader } from '../../common/helpers';

// Bearer header only: the session cookie is never consulted.
@Injectable()
export class PatAuthGuard implements CanActivate {
  constructor(private readonly accessTokenService: AccessTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const reply = http.getResponse();

    const fail = (): never => {
      reply?.header?.('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException();
    };

    const raw = extractBearerTokenFromHeader(req);
    if (!raw) return fail();

    const verified = await this.accessTokenService.verify(
      raw,
      req.raw?.workspaceId,
    );
    if (!verified) return fail();

    req.user = {
      user: verified.user,
      workspace: verified.workspace,
      pat: { id: verified.tokenId, scope: verified.scope },
    };
    return true;
  }
}
