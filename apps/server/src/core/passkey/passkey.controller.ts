import {
  Body,
  CanActivate,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Injectable,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
  PASSKEY_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import { PasskeyService } from './passkey.service';
import {
  AdminDeletePasskeysDto,
  DeletePasskeyDto,
  LoginVerifyDto,
  RegisterOptionsDto,
  RegisterVerifyDto,
  RenamePasskeyDto,
} from './dto/passkey.dto';

// One site identity per installation is assumed, so cloud has no passkeys.
@Injectable()
export class PasskeyEnabledGuard implements CanActivate {
  constructor(private readonly environmentService: EnvironmentService) {}

  canActivate(): boolean {
    if (this.environmentService.isCloud()) throw new NotFoundException();
    return true;
  }
}

@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [PASSKEY_THROTTLER]: false })
@UseGuards(PasskeyEnabledGuard, ThrottlerGuard)
@Controller('passkeys')
export class PasskeyController {
  constructor(
    private readonly passkeyService: PasskeyService,
    private readonly environmentService: EnvironmentService,
    private readonly userSessionRepo: UserSessionRepo,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  // The password is checked here, so the password-login limit applies as well.
  @SkipThrottle({ [AUTH_THROTTLER]: false })
  @RequireSessionAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('register/options')
  async registerOptions(
    @Body() dto: RegisterOptionsDto,
    @AuthUser() user: User,
    @Req() req: FastifyRequest,
  ) {
    const sessionId = (req.raw as any).sessionId;
    const session = sessionId
      ? await this.userSessionRepo.findActiveById(sessionId)
      : undefined;
    if (!session) {
      throw new ForbiddenException('Sign in again to add a passkey');
    }
    return this.passkeyService.registrationOptions(
      user,
      session.createdAt,
      dto.currentPassword,
    );
  }

  @RequireSessionAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('register/verify')
  async registerVerify(@Body() dto: RegisterVerifyDto, @AuthUser() user: User) {
    return this.passkeyService.verifyRegistration(
      user,
      dto.challengeId,
      dto.response,
      dto.name,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('login/options')
  async loginOptions(@AuthWorkspace() workspace: Workspace) {
    return this.passkeyService.loginOptions(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('login/verify')
  async loginVerify(
    @Body() dto: LoginVerifyDto,
    @AuthWorkspace() workspace: Workspace,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const authToken = await this.passkeyService.verifyLogin(
      workspace,
      dto.challengeId,
      dto.response,
    );
    this.setAuthCookie(res, authToken);
  }

  @RequireSessionAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('list')
  async list(@AuthUser() user: User) {
    return this.passkeyService.list(user);
  }

  @RequireSessionAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('rename')
  async rename(@Body() dto: RenamePasskeyDto, @AuthUser() user: User) {
    await this.passkeyService.rename(user, dto.id, dto.name);
  }

  @RequireSessionAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(@Body() dto: DeletePasskeyDto, @AuthUser() user: User) {
    await this.passkeyService.remove(user, dto.id);
  }

  @RequireSessionAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin-delete')
  async adminDelete(
    @Body() dto: AdminDeletePasskeysDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)
    ) {
      throw new ForbiddenException();
    }
    await this.passkeyService.adminRemoveAll(user, dto.userId, workspace.id);
  }

  setAuthCookie(res: FastifyReply, token: string) {
    res.setCookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });
  }
}
