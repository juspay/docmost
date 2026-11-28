import type { WhiteboardFileRef } from '@docmost/live-blocks';
import type { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import type { StorageService } from '../integrations/storage/storage.service';
import type { EnvironmentService } from '../integrations/environment/environment.service';
import { WhiteboardFilesService } from '../core/live-block/whiteboard-files.service';

export type InlineFile = { dataURL: string; mimeType?: string };

export type StoreResult = {
  refs: Record<string, WhiteboardFileRef>;
  skipped: { fileId: string; reason: string }[];
};

/** The shape of WhiteboardFilesService.store (task 6.4), so tests can use a fake. */
export interface WhiteboardFileStore {
  store(
    files: Record<string, InlineFile>,
    page: { id: string; spaceId: string; workspaceId: string },
    creatorId: string,
    options?: { attachmentId?: (fileId: string) => string },
  ): Promise<StoreResult>;
}

export const WHITEBOARD_FILE_STORE = Symbol('WHITEBOARD_FILE_STORE');

/**
 * The dry run's store: the real WhiteboardFilesService, so every file is
 * accepted or skipped by the same rules, over a storage and an attachment
 * repository that only count what they would have written.
 */
export class DryRunFileStore implements WhiteboardFileStore {
  uploads = 0;
  attachments = 0;
  private readonly service: WhiteboardFilesService;

  constructor(uploadSizeLimit: string) {
    const storage = {
      upload: async () => {
        this.uploads++;
      },
    } as unknown as StorageService;
    const repo = {
      findById: async () => undefined,
      insertAttachment: async () => {
        this.attachments++;
      },
    } as unknown as AttachmentRepo;
    const environment = {
      getFileUploadSizeLimit: () => uploadSizeLimit,
    } as unknown as EnvironmentService;
    this.service = new WhiteboardFilesService(repo, storage, environment);
  }

  store(
    files: Record<string, InlineFile>,
    page: { id: string; spaceId: string; workspaceId: string },
    creatorId: string,
    options?: { attachmentId?: (fileId: string) => string },
  ): Promise<StoreResult> {
    return this.service.store(files, page, creatorId, options);
  }
}
