import { Global, Module } from '@nestjs/common';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { LiveBlockController } from './live-block.controller';
import { LiveBlockService } from './live-block.service';
import { WhiteboardFilesService } from './whiteboard-files.service';

// Global so the share controller and page service can use it without
// changing their own modules.
@Global()
@Module({
  imports: [CollaborationModule],
  controllers: [LiveBlockController],
  providers: [LiveBlockService, WhiteboardFilesService],
  exports: [LiveBlockService, WhiteboardFilesService],
})
export class LiveBlockModule {}
