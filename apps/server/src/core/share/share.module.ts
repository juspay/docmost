import { Module } from '@nestjs/common';
import { ShareController } from './share.controller';
import { ShareService } from './share.service';
import { TokenModule } from '../auth/token.module';
import { ShareSeoController } from './share-seo.controller';
import { ShareExpiryModule } from '../share-expiry/share-expiry.module';
import { TransclusionModule } from '../page/transclusion/transclusion.module';

@Module({
  imports: [TokenModule, TransclusionModule, ShareExpiryModule],
  controllers: [ShareController, ShareSeoController],
  providers: [ShareService],
  exports: [ShareService],
})
export class ShareModule {}
