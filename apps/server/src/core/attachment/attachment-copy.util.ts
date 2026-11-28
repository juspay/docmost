import { posix } from 'node:path';
import { Attachment } from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { StorageService } from '../../integrations/storage/storage.service';

/** Copies an attachment's file and inserts the copy as a new attachment of another page. */
export async function copyAttachment(
  storageService: StorageService,
  db: KyselyDB | KyselyTransaction,
  attachment: Pick<
    Attachment,
    | 'id'
    | 'type'
    | 'filePath'
    | 'fileName'
    | 'fileSize'
    | 'mimeType'
    | 'fileExt'
    | 'workspaceId'
  >,
  target: {
    attachmentId: string;
    pageId: string;
    spaceId: string;
    creatorId: string;
  },
  /** called once the file is copied, before the row is inserted */
  onFileCopied?: (path: string) => void,
): Promise<void> {
  // A legacy path without its id would be copied onto itself (and cleaning
  // up the "copy" would delete the original): give the copy a folder of its own.
  const newPathFile = attachment.filePath.includes(attachment.id)
    ? attachment.filePath.replace(attachment.id, target.attachmentId)
    : `${posix.dirname(attachment.filePath)}/${target.attachmentId}/${posix.basename(attachment.filePath)}`;

  await storageService.copy(attachment.filePath, newPathFile);
  onFileCopied?.(newPathFile);

  await db
    .insertInto('attachments')
    .values({
      id: target.attachmentId,
      type: attachment.type,
      filePath: newPathFile,
      fileName: attachment.fileName,
      fileSize: attachment.fileSize,
      mimeType: attachment.mimeType,
      fileExt: attachment.fileExt,
      creatorId: target.creatorId,
      workspaceId: attachment.workspaceId,
      pageId: target.pageId,
      spaceId: target.spaceId,
    })
    .execute();
}
