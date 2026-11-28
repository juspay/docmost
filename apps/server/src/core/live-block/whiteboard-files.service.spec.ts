import {
  MAX_DATA_URL_LENGTH,
  WhiteboardFilesService,
} from './whiteboard-files.service';

const PAGE = {
  id: '0193c7a0-0000-7000-8000-0000000000a1',
  spaceId: 'space-1',
  workspaceId: 'ws-1',
};

// smallest valid images of each accepted type
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46,
]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([26, 0, 0, 0]),
  Buffer.from('WEBPVP8L'),
  Buffer.alloc(14),
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
);

const dataUrl = (mime: string, bytes: Buffer) =>
  `data:${mime};base64,${bytes.toString('base64')}`;

function setup(limit = '50mb') {
  const inserted: any[] = [];
  const uploaded = new Map<string, Buffer>();
  const attachmentRepo = {
    insertAttachment: jest.fn(async (row: any) => {
      inserted.push(row);
      return row;
    }),
  };
  const storage = {
    upload: jest.fn(async (path: string, body: Buffer) => {
      uploaded.set(path, body);
    }),
  };
  const env = { getFileUploadSizeLimit: () => limit };
  const service = new WhiteboardFilesService(
    attachmentRepo as any,
    storage as any,
    env as any,
  );
  return { service, inserted, uploaded, attachmentRepo, storage };
}

describe('WhiteboardFilesService', () => {
  it('stores a PNG as an attachment of the page', async () => {
    const { service, inserted, uploaded } = setup();
    const out = await service.store(
      { f1: { dataURL: dataUrl('image/png', PNG), mimeType: 'image/png' } },
      PAGE,
      'user-1',
    );

    expect(out.skipped).toEqual([]);
    expect(Object.keys(out.refs)).toEqual(['f1']);
    const ref = out.refs.f1;
    expect(ref.mimeType).toBe('image/png');

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row).toEqual(
      expect.objectContaining({
        id: ref.attachmentId,
        type: 'file',
        pageId: PAGE.id,
        spaceId: PAGE.spaceId,
        workspaceId: PAGE.workspaceId,
        creatorId: 'user-1',
        mimeType: 'image/png',
        fileExt: '.png',
        fileSize: PNG.length,
      }),
    );
    // stored where an uploaded file of the page is stored
    expect(row.filePath).toBe(
      `${PAGE.workspaceId}/files/${ref.attachmentId}/${row.fileName}`,
    );
    expect(uploaded.get(row.filePath)?.equals(PNG)).toBe(true);
  });

  it('accepts each image type by its bytes', async () => {
    const { service } = setup();
    const out = await service.store(
      {
        j: { dataURL: dataUrl('image/jpeg', JPEG) },
        g: { dataURL: dataUrl('image/gif', GIF) },
        w: { dataURL: dataUrl('image/webp', WEBP) },
      },
      PAGE,
      'user-1',
    );
    expect(out.skipped).toEqual([]);
    expect(out.refs.j.mimeType).toBe('image/jpeg');
    expect(out.refs.g.mimeType).toBe('image/gif');
    expect(out.refs.w.mimeType).toBe('image/webp');
  });

  it('decides the type from the bytes, not the declared type', async () => {
    const { service, inserted } = setup();
    const out = await service.store(
      {
        pngAsSvg: {
          dataURL: dataUrl('image/svg+xml', PNG),
          mimeType: 'image/svg+xml',
        },
        svgAsPng: { dataURL: dataUrl('image/png', SVG), mimeType: 'image/png' },
      },
      PAGE,
      'user-1',
    );
    expect(out.refs.pngAsSvg.mimeType).toBe('image/png');
    expect(inserted.map((r) => r.mimeType)).toEqual(['image/png']);
    expect(out.refs.svgAsPng).toBeUndefined();
    expect(out.skipped).toEqual([
      {
        fileId: 'svgAsPng',
        reason: expect.stringMatching(/not a PNG, JPEG, GIF or WebP/),
      },
    ]);
  });

  it('skips an SVG, a non-image and an oversize file, each with a reason', async () => {
    const { service, inserted, storage } = setup('1kb');
    const big = Buffer.concat([PNG, Buffer.alloc(2048)]);
    const out = await service.store(
      {
        svg: { dataURL: dataUrl('image/svg+xml', SVG) },
        text: { dataURL: dataUrl('text/plain', Buffer.from('hello world')) },
        big: { dataURL: dataUrl('image/png', big) },
        notADataUrl: { dataURL: 'https://example.com/a.png' },
        ok: { dataURL: dataUrl('image/png', PNG) },
      },
      PAGE,
      'user-1',
    );
    expect(Object.keys(out.refs)).toEqual(['ok']);
    const reasons = Object.fromEntries(
      out.skipped.map((s) => [s.fileId, s.reason]),
    );
    expect(Object.keys(reasons).sort()).toEqual(
      ['big', 'notADataUrl', 'svg', 'text'].sort(),
    );
    expect(reasons.svg).toMatch(/not a PNG, JPEG, GIF or WebP/);
    expect(reasons.text).toMatch(/not a PNG, JPEG, GIF or WebP/);
    expect(reasons.big).toMatch(/larger than the upload limit of 1kb/i);
    expect(reasons.notADataUrl).toMatch(/base64 data URL/);
    expect(inserted).toHaveLength(1);
    expect(storage.upload).toHaveBeenCalledTimes(1);
  });

  it('refuses an over-long data URL without decoding it', async () => {
    const { service, inserted } = setup();
    const from = jest.spyOn(Buffer, 'from');
    try {
      const dataURL =
        'data:image/png;base64,' + 'A'.repeat(MAX_DATA_URL_LENGTH);
      const out = await service.store({ huge: { dataURL } }, PAGE, 'user-1');
      expect(out.refs).toEqual({});
      expect(out.skipped).toEqual([
        {
          fileId: 'huge',
          reason: expect.stringMatching(/7,000,000 characters/),
        },
      ]);
      expect(from).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    } finally {
      from.mockRestore();
    }
    expect(MAX_DATA_URL_LENGTH).toBe(7_000_000);
  });

  it('skips a file whose storage fails and keeps the others', async () => {
    const { service, storage } = setup();
    storage.upload.mockRejectedValueOnce(new Error('disk full'));
    const out = await service.store(
      {
        a: { dataURL: dataUrl('image/png', PNG) },
        b: { dataURL: dataUrl('image/png', PNG) },
      },
      PAGE,
      'user-1',
    );
    expect(Object.keys(out.refs)).toEqual(['b']);
    expect(out.skipped).toEqual([
      { fileId: 'a', reason: 'The file could not be stored' },
    ]);
  });
});
