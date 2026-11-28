import { Module } from '@nestjs/common';
import { ShareExpiryController } from './share-expiry.controller';
import { ShareExpiryService } from './share-expiry.service';

@Module({
  controllers: [ShareExpiryController],
  providers: [ShareExpiryService],
  exports: [ShareExpiryService],
})
export class ShareExpiryModule {}
