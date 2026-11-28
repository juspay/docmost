import { Injectable, Logger } from '@nestjs/common';
import * as bytes from 'bytes';
import { v7 as uuid7 } from 'uuid';
import type { WhiteboardFileRef } from '@docmost/live-blocks';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { StorageService } from '../../integrations/storage/storage.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AttachmentType } from '../attachment/attachment.constants';
import { getAttachmentFolderPath } from '../attachment/attachment.utils';

export const WHITEBOARD_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type WhiteboardImageType = (typeof WHITEBOARD_IMAGE_TYPES)[number];

export const MAX_DATA_URL_LENGTH = 7_000_000;

/** The skip reason when storage or the database failed, not the file. */
export const STORE_FAILED_REASON = 'The file could not be stored';

export type WhiteboardFileInput = { dataURL: string; mimeType?: string };

export type WhiteboardFilesResult = {
  refs: Record<string, WhiteboardFileRef>;
  skipped: { fileId: string; reason: string }[];
};

const EXTENSION: Record<WhiteboardImageType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const startsWith = (buf: Buffer, sig: number[], at = 0) =>
  buf.length >= at + sig.length && sig.every((b, i) => buf[at + i] === b);

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The image type the bytes say, whatever the caller declared. */
export function sniffImageType(buf: Buffer): WhiteboardImageType | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a')))
    return 'image/gif';
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8))
    return 'image/webp';
  return null;
}

const DATA_URL = /^data:[^,]*;base64,/i;

/**
 * Stores whiteboard images (Excalidraw's `files`, as data URLs) as
 * attachments of a page. Depends only on the attachment repository, storage
 * and the environment, so the migration tool can use it on its own.
 */
@Injectable()
export class WhiteboardFilesService {
  private readonly logger = new Logger(WhiteboardFilesService.name);

  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storageService: StorageService,
    private readonly environmentService: EnvironmentService,
  ) {}

  async store(
    files: Record<string, WhiteboardFileInput>,
    page: { id: string; spaceId: string; workspaceId: string },
    creatorId: string,
    // the migration tool derives ids, so a second attempt reuses what the
    // first one stored instead of storing the image again
    options: { attachmentId?: (fileId: string) => string } = {},
  ): Promise<WhiteboardFilesResult> {
    const limitText = this.environmentService.getFileUploadSizeLimit();
    const limit = bytes(limitText);
    const result: WhiteboardFilesResult = { refs: {}, skipped: [] };
    const skip = (fileId: string, reason: string) =>
      result.skipped.push({ fileId, reason });

    for (const [fileId, file] of Object.entries(files ?? {})) {
      const dataURL = file?.dataURL;
      if (typeof dataURL !== 'string') {
        skip(fileId, 'The file has no dataURL');
        continue;
      }
      // checked before decoding, so a huge string costs nothing more
      if (dataURL.length > MAX_DATA_URL_LENGTH) {
        skip(
          fileId,
          `The data URL is longer than ${MAX_DATA_URL_LENGTH.toLocaleString('en-US')} characters`,
        );
        continue;
      }
      const header = DATA_URL.exec(dataURL);
      if (!header) {
        skip(fileId, 'The file is not a base64 data URL');
        continue;
      }

      const data = Buffer.from(dataURL.slice(header[0].length), 'base64');
      const mimeType = sniffImageType(data);
      if (!mimeType) {
        skip(fileId, 'The file is not a PNG, JPEG, GIF or WebP image');
        continue;
      }
      if (typeof limit === 'number' && data.length > limit) {
        skip(
          fileId,
          `The file is larger than the upload limit of ${limitText}`,
        );
        continue;
      }

      try {
        const wanted = options.attachmentId?.(fileId);
        if (wanted) {
          const existing = await this.attachmentRepo.findById(wanted);
          if (existing) {
            if (
              existing.pageId !== page.id ||
              existing.workspaceId !== page.workspaceId
            ) {
              skip(fileId, 'The attachment id is already used by another page');
            } else {
              result.refs[fileId] = { attachmentId: existing.id, mimeType };
            }
            continue;
          }
        }
        const attachmentId = await this.save(
          data,
          mimeType,
          page,
          creatorId,
          wanted,
        );
        result.refs[fileId] = { attachmentId, mimeType };
      } catch (err) {
        this.logger.error(
          `Whiteboard image ${fileId} could not be stored`,
          err as Error,
        );
        skip(fileId, STORE_FAILED_REASON);
      }
    }
    return result;
  }

  private async save(
    data: Buffer,
    mimeType: WhiteboardImageType,
    page: { id: string; spaceId: string; workspaceId: string },
    creatorId: string,
    id?: string,
  ): Promise<string> {
    const attachmentId = id ?? uuid7();
    const fileExt = EXTENSION[mimeType];
    const fileName = `whiteboard-image${fileExt}`;
    // the same layout as an uploaded file of the page
    const filePath = `${getAttachmentFolderPath(AttachmentType.File, page.workspaceId)}/${attachmentId}/${fileName}`;

    await this.storageService.upload(filePath, data);
    await this.attachmentRepo.insertAttachment({
      id: attachmentId,
      type: AttachmentType.File,
      filePath,
      fileName,
      fileSize: data.length,
      mimeType,
      fileExt,
      creatorId,
      workspaceId: page.workspaceId,
      pageId: page.id,
      spaceId: page.spaceId,
    });
    return attachmentId;
  }
}
