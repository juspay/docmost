import { WhiteboardFilesService } from '../core/live-block/whiteboard-files.service';
import { PNG_DATA_URL } from './testing/synthetic-mindspace';
import { DryRunFileStore, type InlineFile } from './whiteboard-file-store';

const PAGE = { id: 'page-1', spaceId: 'space-1', workspaceId: 'ws-1' };
const png = Buffer.from(PNG_DATA_URL.split(',')[1], 'base64');

const files: Record<string, InlineFile> = {
  png: { dataURL: PNG_DATA_URL, mimeType: 'image/png' },
  // a PNG labelled as SVG is still a PNG
  labelled: { dataURL: `data:image/svg+xml;base64,${png.toString('base64')}` },
  svg: {
    dataURL: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
  },
  // percent-encoded instead of base64
  encoded: {
    dataURL: `data:image/png,${encodeURIComponent(png.toString('latin1'))}`,
  },
  big: {
    dataURL: `data:image/png;base64,${Buffer.concat([png, Buffer.alloc(2048)]).toString('base64')}`,
  },
  long: { dataURL: 'data:image/png;base64,' + 'A'.repeat(7_000_001) },
  none: {} as InlineFile,
};

describe('DryRunFileStore', () => {
  it('accepts and skips exactly what WhiteboardFilesService accepts and skips', async () => {
    const uploads: string[] = [];
    const inserted: unknown[] = [];
    const real = new WhiteboardFilesService(
      {
        insertAttachment: async (row: unknown) => void inserted.push(row),
      } as any,
      { upload: async (path: string) => void uploads.push(path) } as any,
      { getFileUploadSizeLimit: () => '1kb' } as any,
    );
    const dry = new DryRunFileStore('1kb');

    const want = await real.store(files, PAGE, 'user-1');
    const got = await dry.store(files, PAGE, 'user-1');

    expect(got.skipped).toEqual(want.skipped);
    expect(Object.keys(got.refs).sort()).toEqual(Object.keys(want.refs).sort());
    expect(Object.values(got.refs).map((r) => r.mimeType)).toEqual(
      Object.values(want.refs).map((r) => r.mimeType),
    );
    expect(Object.keys(want.refs).sort()).toEqual(['labelled', 'png']);
    // the dry run counted what it would have written, and wrote nothing
    expect(dry.uploads).toBe(2);
    expect(dry.attachments).toBe(2);
    expect(uploads).toHaveLength(2);
  });

  it('with derived ids, a second attempt reuses what the first stored and stores nothing again', async () => {
    const rows = new Map<string, any>();
    const uploads: string[] = [];
    const service = new WhiteboardFilesService(
      {
        findById: async (id: string) => rows.get(id),
        insertAttachment: async (row: any) => void rows.set(row.id, row),
      } as any,
      { upload: async (path: string) => void uploads.push(path) } as any,
      { getFileUploadSizeLimit: () => '50mb' } as any,
    );
    const idFor = (fileId: string) =>
      `00000000-0000-5000-8000-0000000000${fileId === 'png' ? '01' : '02'}`;
    const two = { png: files.png, labelled: files.labelled };

    const first = await service.store(two, PAGE, 'user-1', {
      attachmentId: idFor,
    });
    const second = await service.store(two, PAGE, 'user-1', {
      attachmentId: idFor,
    });
    expect(first.refs).toEqual({
      png: { attachmentId: idFor('png'), mimeType: 'image/png' },
      labelled: { attachmentId: idFor('labelled'), mimeType: 'image/png' },
    });
    expect(second).toEqual(first);
    expect(uploads).toHaveLength(2);
    expect(rows.size).toBe(2);

    // the same id on another page is never taken over
    const other = await service.store(
      { png: files.png },
      { ...PAGE, id: 'page-2' },
      'user-1',
      { attachmentId: idFor },
    );
    expect(other).toEqual({
      refs: {},
      skipped: [
        {
          fileId: 'png',
          reason: 'The attachment id is already used by another page',
        },
      ],
    });
  });
});
