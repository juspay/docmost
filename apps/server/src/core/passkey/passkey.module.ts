import { Module } from '@nestjs/common';
import { PasskeyController, PasskeyEnabledGuard } from './passkey.controller';
import { PasskeyService } from './passkey.service';

@Module({
  controllers: [PasskeyController],
  providers: [PasskeyService, PasskeyEnabledGuard],
  exports: [PasskeyService],
})
export class PasskeyModule {}
