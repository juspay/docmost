import { Module } from '@nestjs/common';
import { AccessTokenController } from './access-token.controller';
import { AccessTokenService } from './access-token.service';
import { PatAuthGuard } from './pat-auth.guard';

@Module({
  controllers: [AccessTokenController],
  providers: [AccessTokenService, PatAuthGuard],
  exports: [AccessTokenService, PatAuthGuard],
})
export class AccessTokenModule {}
