import { ServiceUnavailableException } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { pushElements, readFiles, setFile } from '@docmost/live-blocks';
import { PageService } from './page.service';
import { LiveBlockService } from '../../live-block/live-block.service';
import { findLiveBlocks } from '../../live-block/page-content.util';

const WS = '019a1f00-0000-7000-8000-000000000001';
const SPACE = '019a1f00-0000-7000-8000-000000000002';
const PAGE = '019a1f00-0000-7000-8000-000000000003';
const CHILD = '019a1f00-0000-7000-8000-000000000004';
const USER = '019a1f00-0000-7000-8000-000000000005';
const A = '0193c7a0-1111-7abc-8def-00000000000a';
const B = '0193c7a0-1111-7abc-8def-00000000000b';
const STALE = '0193c7a0-1111-7abc-8def-00000000000c';
const PREVIEW = '0193c7a0-1111-7abc-8def-0000000000a1';
const IMG = '0193c7a0-1111-7abc-8def-0000000000a2';

const user = { id: USER, workspaceId: WS } as any;

const doc = (...content: any[]) => ({ type: 'doc', content });
const board = (blockId: string, extra: any = {}) => ({
  type: 'whiteboard',
  attrs: { blockId, title: 'Plan', height: null, ...extra },
});

function boardBytes(withImage: boolean) {
  const d = new Y.Doc();
  pushElements(d, [
    {
      id: 'e1',
      version: 1,
      type: withImage ? 'image' : 'rectangle',
      fileId: 'f1',
    },
  ]);
  if (withImage) setFile(d, 'f1', { attachmentId: IMG, mimeType: 'image/png' });
  return Buffer.from(Y.encodeStateAsUpdate(d));
}

const B_BYTES = boardBytes(false);

function attachmentRow(id: string, pageId = PAGE) {
  return {
    id,
    type: 'file',
    filePath: `${WS}/files/${id}/x.png`,
    fileName: 'x.png',
    fileSize: 1,
    mimeType: 'image/png',
    fileExt: '.png',
    creatorId: USER,
    workspaceId: WS,
    pageId,
    spaceId: SPACE,
  };
}

function makeService(
  opts: { withChild?: boolean; unreachable?: boolean } = {},
) {
  const root = {
    id: PAGE,
    slugId: 'rootSlug01',
    title: 'Board page',
    content: doc(
      board(A, {
        attachmentId: PREVIEW,
        src: `/api/files/${PREVIEW}/preview.svg`,
      }),
      { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
    ),
    coverPhoto: null,
    position: 'a0',
    parentPageId: null,
    spaceId: SPACE,
    workspaceId: WS,
  } as any;
  const child = {
    ...root,
    id: CHILD,
    slugId: 'childSlug1',
    title: 'Child',
    content: doc(board(B)),
    parentPageId: PAGE,
  };
  const pages = opts.withChild ? [root, child] : [root];
  const originalContent = JSON.stringify(root.content);

  const rows = [
    {
      id: A,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      creatorId: USER,
      ydoc: boardBytes(true),
      snapshot: {
        kind: 'whiteboard',
        elements: [],
        files: { f1: { attachmentId: IMG, mimeType: 'image/png' } },
      },
    },
    {
      id: B,
      kind: 'whiteboard',
      pageId: CHILD,
      workspaceId: WS,
      creatorId: USER,
      ydoc: B_BYTES,
      snapshot: { kind: 'whiteboard', elements: [], files: {} },
    },
    {
      id: STALE,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      creatorId: USER,
      ydoc: boardBytes(false),
      snapshot: null,
    },
  ];
  const events: string[] = [];
  const liveBlockRepo = {
    findByPageIds: jest.fn(async (pageIds: string[], o?: any) => {
      events.push(o?.includeYdoc ? 'read-ydoc' : 'read-meta');
      return rows
        .filter((r) => pageIds.includes(r.pageId))
        .map(({ ydoc, snapshot, ...meta }) => ({
          ...meta,
          ...(o?.includeYdoc ? { ydoc } : {}),
          ...(o?.includeSnapshot ? { snapshot } : {}),
        }));
    }),
    insertNew: jest.fn(async (row: any, trx?: any) => {
      events.push(trx ? 'insert-block-in-trx' : 'insert-block');
      return true;
    }),
  };
  const bridge = {
    flush: jest.fn(async (ids: string[]) => {
      events.push('flush');
      return opts.unreachable
        ? { flushed: [], unreachable: ids }
        : { flushed: ids, unreachable: [] };
    }),
  };
  const attachmentRepo = {
    findByIds: jest.fn(async (ids: string[]) =>
      ids.filter((i) => i === IMG).map((i) => attachmentRow(i)),
    ),
  };
  const inserted: any[] = [];
  const trx = {
    insertInto: (table: string) => ({
      values: (values: any) => ({
        execute: async () => {
          events.push(`insert-${table}`);
          inserted.push({ table, values });
        },
      }),
    }),
  };
  const selectQuery: any = {
    selectAll: () => selectQuery,
    where: () => selectQuery,
    execute: async () => [attachmentRow(PREVIEW)],
  };
  const db = {
    transaction: () => ({ execute: (callback: any) => callback(trx) }),
    selectFrom: () => selectQuery,
    insertInto: (table: string) => ({
      values: (values: any) => ({
        execute: async () => {
          inserted.push({ table, values, outsideTrx: true });
        },
      }),
    }),
  };
  const storageService = { copy: jest.fn(async () => undefined) };
  const liveBlockService = new LiveBlockService(
    liveBlockRepo as any,
    {} as any,
    attachmentRepo as any,
    {} as any,
    bridge as any,
    storageService as any,
    db as any,
    {} as any, // WhiteboardFilesService
    {} as any, // ModuleRef
  );
  const pageRepo = {
    getPageAndDescendants: jest.fn(async () => pages),
    findById: jest.fn(async () => root),
  };
  const service = new PageService(
    pageRepo as any,
    { copyRestrictions: jest.fn(async () => 0) } as any,
    {} as any,
    db as any,
    storageService as any,
    {} as any,
    {} as any,
    {} as any,
    { emit: jest.fn() } as any,
    {} as any,
    {} as any,
    {
      insertTransclusionsForPages: jest.fn(async () => undefined),
      insertReferencesForPages: jest.fn(async () => undefined),
    } as any,
    { copyLabelsToPages: jest.fn(async () => undefined) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    liveBlockService,
  );
  jest
    .spyOn(service as any, 'filterAccessibleTreePages')
    .mockResolvedValue(pages);

  const insertedPages = () =>
    inserted.find((i) => i.table === 'pages')?.values ?? [];
  const blockInserts = () =>
    liveBlockRepo.insertNew.mock.calls.map((c) => c[0]);
  return {
    service,
    root,
    child,
    originalContent,
    inserted,
    insertedPages,
    blockInserts,
    liveBlockRepo,
    bridge,
    storageService,
    events,
  };
}

const blockIdsOf = (content: any) =>
  findLiveBlocks(content).map((b) => b.blockId);

describe('PageService.duplicatePage live blocks', () => {
  it('duplicating a page gives each live block a new id in both content and ydoc', async () => {
    const { service, root, insertedPages } = makeService();
    await service.duplicatePage(root, undefined, user);
    const [copy] = insertedPages();
    const [newId] = blockIdsOf(copy.content);
    expect(newId).toBeDefined();
    expect(newId).not.toBe(A);
    const fromYdoc = TiptapTransformer.fromYdoc(
      (() => {
        const d = new Y.Doc();
        Y.applyUpdate(d, new Uint8Array(copy.ydoc));
        return d;
      })(),
      'default',
    );
    expect(blockIdsOf(fromYdoc)).toEqual([newId]);
  });

  it('the copied block row holds the source bytes and belongs to the new page', async () => {
    const { service, root, insertedPages, blockInserts } = makeService({
      withChild: true,
    });
    await service.duplicatePage(root, undefined, user);
    const copiedChild = insertedPages().find((p: any) => p.title === 'Child');
    const [newB] = blockIdsOf(copiedChild.content);
    const row = blockInserts().find((r: any) => r.id === newB);
    expect(row).toMatchObject({
      kind: 'whiteboard',
      pageId: copiedChild.id,
      workspaceId: WS,
      creatorId: USER,
    });
    expect(Buffer.compare(row.ydoc, B_BYTES)).toBe(0);
  });

  it("a duplicated whiteboard's images are new attachments of the new page", async () => {
    const {
      service,
      root,
      insertedPages,
      blockInserts,
      inserted,
      storageService,
    } = makeService();
    await service.duplicatePage(root, undefined, user);
    const [copy] = insertedPages();
    const row = blockInserts()[0];
    const d = new Y.Doc();
    Y.applyUpdate(d, new Uint8Array(row.ydoc));
    const newImg = readFiles(d).f1.attachmentId;
    expect(newImg).not.toBe(IMG);
    const attachmentInsert = inserted.find(
      (i) => i.table === 'attachments' && i.values.id === newImg,
    );
    expect(attachmentInsert.values).toMatchObject({
      pageId: copy.id,
      spaceId: SPACE,
      creatorId: USER,
    });
    expect(storageService.copy).toHaveBeenCalledWith(
      `${WS}/files/${IMG}/x.png`,
      `${WS}/files/${newImg}/x.png`,
    );
    expect(row.snapshot.files.f1.attachmentId).toBe(newImg);
    // the preview image is a node attribute and goes through the page's own attachment copy
    expect(copy.content.content[0].attrs.attachmentId).not.toBe(PREVIEW);
    expect(copy.content.content[0].attrs.src).toBe(
      `/api/files/${copy.content.content[0].attrs.attachmentId}/preview.svg`,
    );
  });

  it('duplicating a page tree copies blocks of child pages too', async () => {
    const { service, root, insertedPages, blockInserts } = makeService({
      withChild: true,
    });
    await service.duplicatePage(root, undefined, user);
    const ids = insertedPages().flatMap((p: any) => blockIdsOf(p.content));
    expect(ids).toHaveLength(2);
    expect(
      blockInserts()
        .map((r: any) => r.id)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it('a block row that is no longer in the page content is not copied', async () => {
    const { service, root, blockInserts, bridge } = makeService();
    await service.duplicatePage(root, undefined, user);
    expect(blockInserts()).toHaveLength(1);
    expect(bridge.flush).toHaveBeenCalledWith([A]);
  });

  it('the original page keeps its own block ids', async () => {
    const { service, root, originalContent } = makeService();
    await service.duplicatePage(root, undefined, user);
    expect(JSON.stringify(root.content)).toBe(originalContent);
    expect(blockIdsOf(root.content)).toEqual([A]);
  });

  it('duplicate flushes open blocks first and fails with 503 when one is unreachable', async () => {
    const ok = makeService();
    await ok.service.duplicatePage(ok.root, undefined, user);
    expect(ok.events.indexOf('flush')).toBeLessThan(
      ok.events.indexOf('read-ydoc'),
    );
    expect(ok.events.indexOf('insert-pages')).toBeLessThan(
      ok.events.indexOf('insert-block-in-trx'),
    );

    const down = makeService({ unreachable: true });
    await expect(
      down.service.duplicatePage(down.root, undefined, user),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(down.insertedPages()).toEqual([]);
  });
});
