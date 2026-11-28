import { Module } from '@nestjs/common';
import { DatabaseModule } from '@docmost/db/database.module';
import { EnvironmentModule } from '../integrations/environment/environment.module';
import { StorageModule } from '../integrations/storage/storage.module';
import { ShareExpiryService } from '../core/share-expiry/share-expiry.service';
import { ImportInfraModule } from './import-infra.module';
import { MindspaceImportService } from './mindspace-import.service';
import { WHITEBOARD_FILE_STORE } from './whiteboard-file-store';
import { IMPORT_EMAIL_QUEUE, createEmailQueue } from './invites';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { WhiteboardFilesService } from '../core/live-block/whiteboard-files.service';

/**
 * Only the database, environment and storage modules. Not the page, comment
 * or collaboration modules: a one-off process must not start the sync
 * gateway, a queue worker or notifications.
 */
@Module({
  imports: [
    EnvironmentModule,
    ImportInfraModule,
    DatabaseModule.forRoot({ runMigrations: false }),
    StorageModule.forRootAsync({ imports: [EnvironmentModule] }),
  ],
  providers: [
    ShareExpiryService,
    WhiteboardFilesService,
    { provide: WHITEBOARD_FILE_STORE, useExisting: WhiteboardFilesService },
    {
      provide: IMPORT_EMAIL_QUEUE,
      useFactory: (environment: EnvironmentService) => () =>
        createEmailQueue(environment),
      inject: [EnvironmentService],
    },
    MindspaceImportService,
  ],
})
export class MindspaceImportModule {}
