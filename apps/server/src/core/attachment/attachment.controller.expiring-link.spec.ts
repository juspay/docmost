import { AttachmentController } from './attachment.controller';
import { JwtType } from '../auth/dto/jwt-payload';

const FILE_ID = '019a1f00-0000-7000-8000-000000000c01';
const WORKSPACE_ID = '019a1f00-0000-7000-8000-000000000c02';
const PAGE_ID = '019a1f00-0000-7000-8000-000000000c03';

async function publicFileHeaders(tokenPayload: Record<string, unknown>) {
  const headers: Record<string, unknown> = {};
  const res: any = {
    header: (k: string, v: unknown) => (headers[k] = v),
    headers: (h: Record<string, unknown>) => Object.assign(headers, h),
    status: jest.fn(),
    send: jest.fn(),
  };
  const controller = new AttachmentController(
    {} as any,
    { readStream: async () => 'stream' } as any,
    {} as any,
    {} as any,
    {} as any,
    {
      findById: async () => ({
        id: FILE_ID,
        workspaceId: WORKSPACE_ID,
        pageId: PAGE_ID,
        spaceId: 's',
        fileExt: '.png',
        fileName: 'a.png',
        filePath: 'a.png',
        mimeType: 'image/png',
        fileSize: 10,
      }),
    } as any,
    {} as any,
    {
      verifyJwt: async () => ({
        attachmentId: FILE_ID,
        pageId: PAGE_ID,
        workspaceId: WORKSPACE_ID,
        type: JwtType.ATTACHMENT,
        ...tokenPayload,
      }),
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  await controller.getPublicFile(
    { headers: {} } as any,
    res,
    { id: WORKSPACE_ID } as any,
    FILE_ID,
    'a.png',
    'jwt',
  );
  return headers;
}

describe('public file cache headers', () => {
  it('keeps public caching for a link that does not expire', async () => {
    const headers = await publicFileHeaders({});

    expect(headers['Cache-Control']).toBe('public, max-age=3600');
  });

  it('uses private caching, ending with the token, for a link that expires', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;

    const headers = await publicFileHeaders({ expiring: true, exp });

    expect(headers['Cache-Control']).toMatch(/^private, max-age=(59\d|600)$/);
  });
});
