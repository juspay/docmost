import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User } from '@docmost/db/types/entity.types';
import { AccessTokenService } from './access-token.service';
import {
  CreateAccessTokenDto,
  RevokeAccessTokenDto,
} from './dto/access-token.dto';

@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
@Controller('access-tokens')
export class AccessTokenController {
  constructor(private readonly service: AccessTokenService) {}

  @HttpCode(HttpStatus.OK)
  @Post('list')
  async list(@AuthUser() user: User) {
    return this.service.list(user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(@Body() dto: CreateAccessTokenDto, @AuthUser() user: User) {
    const { token, record } = await this.service.create(user, {
      name: dto.name,
      scope: dto.scope,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });
    return { ...record, token };
  }

  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  async revoke(@Body() dto: RevokeAccessTokenDto, @AuthUser() user: User) {
    await this.service.revoke(user, dto.id);
  }
}
