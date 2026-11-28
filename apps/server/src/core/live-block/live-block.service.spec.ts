import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as Y from 'yjs';
import {
  buildSnapshot,
  emptySnapshot,
  pushElements,
  readFiles,
  seedYdoc,
  setFile,
  sheet,
} from '@docmost/live-blocks';
import { LiveBlockService } from './live-block.service';
import { ShareController } from '../share/share.controller';

const WS = '019a1f00-0000-7000-8000-000000000001';
const SPACE = '019a1f00-0000-7000-8000-000000000002';
const PAGE = '019a1f00-0000-7000-8000-000000000003';
const OTHER_PAGE = '019a1f00-0000-7000-8000-000000000004';
const SECRET_PAGE = '019a1f00-0000-7000-8000-000000000005';
const TRASHED_PAGE = '019a1f00-0000-7000-8000-000000000006';
const USER = '019a1f00-0000-7000-8000-000000000009';
const NEW = '0193c7a0-1111-7abc-8def-000000000001';
const SRC = '0193c7a0-1111-7abc-8def-000000000002';
const SECRET_BLOCK = '0193c7a0-1111-7abc-8def-000000000003';
const IMG = '0193c7a0-1111-7abc-8def-0000000000aa';

const user = { id: USER, workspaceId: WS } as any;

function boardBytes(withImage = false) {
  const doc = new Y.Doc();
  pushElements(doc, [
    {
      id: 'r1',
      version: 2,
      type: withImage ? 'image' : 'rectangle',
      fileId: withImage ? 'f1' : undefined,
    },
  ]);
  if (withImage)
    setFile(doc, 'f1', { attachmentId: IMG, mimeType: 'image/png' });
  return {
    ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)),
    snapshot: buildSnapshot('whiteboard', doc),
  };
}

function makeService(
  opts: {
    canEdit?: Set<string>;
    canView?: Set<string>;
    pageService?: Record<string, jest.Mock>;
  } = {},
) {
  const canEdit = opts.canEdit ?? new Set([PAGE, OTHER_PAGE]);
  const canView = opts.canView ?? new Set([PAGE, OTHER_PAGE, TRASHED_PAGE]);
  const pages: Record<string, any> = {
    [PAGE]: {
      id: PAGE,
      spaceId: SPACE,
      workspaceId: WS,
      deletedAt: null,
      content: {
        type: 'doc',
        content: [{ type: 'whiteboard', attrs: { blockId: SRC } }],
      },
    },
    [OTHER_PAGE]: {
      id: OTHER_PAGE,
      spaceId: SPACE,
      workspaceId: WS,
      deletedAt: null,
      content: { type: 'doc', content: [] },
    },
    [SECRET_PAGE]: {
      id: SECRET_PAGE,
      spaceId: SPACE,
      workspaceId: WS,
      deletedAt: null,
      content: null,
    },
    [TRASHED_PAGE]: {
      id: TRASHED_PAGE,
      spaceId: SPACE,
      workspaceId: WS,
      deletedAt: new Date(),
      content: null,
    },
  };
  const rows = new Map<string, any>();
  // when set, inserts wait until every racing caller has reached its insert
  let raceGate: () => Promise<void> = async () => undefined;
  const race = (callers: number) => {
    let arrived = 0;
    let open: () => void;
    const all = new Promise<void>((r) => (open = r));
    raceGate = async () => {
      if (++arrived >= callers) open();
      await all;
    };
  };
  const events: string[] = [];
  const liveBlockRepo = {
    findById: jest.fn(async (id: string, o?: any) => {
      events.push(`find:${id}:${o?.includeYdoc ? 'ydoc' : 'meta'}`);
      const row = rows.get(id);
      // like the repo: soft-deleted rows are not found
      if (!row || row.deletedAt) return undefined;
      const { ydoc, snapshot, ...meta } = row;
      return {
        ...meta,
        ...(o?.includeYdoc ? { ydoc } : {}),
        ...(o?.includeSnapshot ? { snapshot } : {}),
      };
    }),
    findByPageIds: jest.fn(async (pageIds: string[], o?: any) =>
      [...rows.values()]
        .filter((r) => pageIds.includes(r.pageId) && !r.deletedAt)
        .map(({ ydoc, snapshot, ...meta }) => ({
          ...meta,
          ...(o?.includeYdoc ? { ydoc } : {}),
          ...(o?.includeSnapshot ? { snapshot } : {}),
        })),
    ),
    saveYdoc: jest.fn(),
    saveSnapshot: jest.fn(),
    // like the repo: written only when the document is still the one read
    saveRebuiltSnapshot: jest.fn(
      async (id: string, snapshot: any, updatedAt: Date) => {
        const row = rows.get(id);
        // by value, like the database (which compares at millisecond precision)
        if (!row || row.updatedAt?.getTime() !== updatedAt?.getTime())
          return false;
        row.snapshot = snapshot;
        row.snapshotError = null;
        return true;
      },
    ),
    seedIfEmpty: jest.fn(),
    softDelete: jest.fn(async (id: string) => {
      const row = rows.get(id);
      if (row && !row.deletedAt) row.deletedAt = new Date();
    }),
    insertNew: jest.fn(async (block: any) => {
      await raceGate();
      if (rows.has(block.id)) return false;
      rows.set(block.id, { updatedAt: new Date(), ...block });
      return true;
    }),
    // INSERT … ON CONFLICT DO NOTHING, then read back (soft-deleted rows included)
    insertIfAbsent: jest.fn(async (block: any) => {
      await raceGate();
      if (!rows.has(block.id))
        rows.set(block.id, {
          ydoc: null,
          snapshot: null,
          updatedAt: new Date(),
          ...block,
        });
      const { ydoc, snapshot, ...meta } = rows.get(block.id);
      // like the repo: another workspace's row is never returned
      return meta.workspaceId === block.workspaceId ? meta : undefined;
    }),
  };
  const pageRepo = {
    findById: jest.fn(async (id: string) => pages[id] && { ...pages[id] }),
    removePage: jest.fn(async (id: string) => {
      if (pages[id]) pages[id].deletedAt = new Date();
    }),
  };
  const pageAccessService = {
    validateCanEdit: jest.fn(async (page: any) => {
      if (!canEdit.has(page.id)) throw new ForbiddenException();
      return { hasRestriction: false };
    }),
    validateCanView: jest.fn(async (page: any) => {
      if (!canView.has(page.id)) throw new ForbiddenException();
    }),
    validateCanCreate: jest.fn(async () => undefined),
  };
  const bridge = {
    flush: jest.fn(async (ids: string[]) => {
      events.push('flush');
      return { flushed: ids, unreachable: [] };
    }),
    apply: jest.fn(async () => undefined),
    liveDocumentsReachable: jest.fn(() => true),
  };
  const attachments = new Map<string, any>([
    [
      IMG,
      {
        id: IMG,
        type: 'file',
        filePath: `${WS}/files/${IMG}/a.png`,
        fileName: 'a.png',
        fileSize: 3,
        mimeType: 'image/png',
        fileExt: '.png',
        workspaceId: WS,
        pageId: PAGE,
        spaceId: SPACE,
      },
    ],
  ]);
  const attachmentRepo = {
    findByIds: jest.fn(async (ids: string[]) =>
      ids.map((i) => attachments.get(i)).filter(Boolean),
    ),
  };
  const insertedAttachments: any[] = [];
  const trx = {
    insertInto: () => ({
      values: (v: any) => ({
        execute: async () => insertedAttachments.push(v),
      }),
    }),
  };
  const db = { transaction: () => ({ execute: (fn: any) => fn(trx) }), ...trx };
  const storageService = {
    copy: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
  };
  const service = new LiveBlockService(
    liveBlockRepo as any,
    pageRepo as any,
    attachmentRepo as any,
    pageAccessService as any,
    bridge as any,
    storageService as any,
    db as any,
    {} as any, // WhiteboardFilesService
    { get: () => opts.pageService ?? {} } as any, // ModuleRef
  );
  return {
    race,
    attachments,
    db,
    service,
    rows,
    liveBlockRepo,
    pageAccessService,
    bridge,
    events,
    storageService,
    insertedAttachments,
    pages,
    pageRepo,
  };
}

describe('LiveBlockService.ensure', () => {
  it('ensure creates an empty block when none exists', async () => {
    const { service, rows } = makeService();
    expect(
      await service.ensure(
        { blockId: NEW, pageId: PAGE, kind: 'whiteboard' },
        user,
      ),
    ).toEqual({ blockId: NEW });
    expect(rows.get(NEW)).toMatchObject({
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      creatorId: USER,
      ydoc: null,
    });
  });

  it('ensure is a no-op when the block already belongs to the page', async () => {
    const { service, rows } = makeService();
    await service.ensure(
      { blockId: NEW, pageId: PAGE, kind: 'whiteboard' },
      user,
    );
    const first = rows.get(NEW);
    expect(
      await service.ensure(
        { blockId: NEW, pageId: PAGE, kind: 'whiteboard' },
        user,
      ),
    ).toEqual({ blockId: NEW });
    expect(rows.get(NEW)).toBe(first);
  });

  it('ensure never copies anything', async () => {
    const { service, rows, liveBlockRepo, bridge } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    await service.ensure(
      { blockId: NEW, pageId: PAGE, kind: 'whiteboard' },
      user,
    );
    // no document or snapshot is read from any row, or written to the new one
    for (const call of liveBlockRepo.findById.mock.calls) {
      expect(call[1]?.includeYdoc).toBeFalsy();
      expect(call[1]?.includeSnapshot).toBeFalsy();
    }
    expect(liveBlockRepo.saveYdoc).not.toHaveBeenCalled();
    expect(liveBlockRepo.saveSnapshot).not.toHaveBeenCalled();
    expect(liveBlockRepo.seedIfEmpty).not.toHaveBeenCalled();
    for (const [values] of liveBlockRepo.insertIfAbsent.mock.calls) {
      expect(values).not.toHaveProperty('ydoc');
      expect(values).not.toHaveProperty('snapshot');
    }
    expect(bridge.flush).not.toHaveBeenCalled();
    expect(rows.get(NEW).ydoc).toBeNull();
  });

  it('ensure answers 409 BLOCK_ID_TAKEN for a block of another page, whether or not the caller can see it', async () => {
    for (const owner of [OTHER_PAGE, SECRET_PAGE]) {
      const { service, rows } = makeService();
      rows.set(NEW, {
        id: NEW,
        kind: 'whiteboard',
        pageId: owner,
        workspaceId: WS,
      });
      const err = await service
        .ensure({ blockId: NEW, pageId: PAGE, kind: 'whiteboard' }, user)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: 'BLOCK_ID_TAKEN' });
    }
  });

  it('ensure answers 409 KIND_MISMATCH when the row has another kind', async () => {
    const { service, rows } = makeService();
    rows.set(NEW, { id: NEW, kind: 'sheet', pageId: PAGE, workspaceId: WS });
    const err = await service
      .ensure({ blockId: NEW, pageId: PAGE, kind: 'whiteboard' }, user)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'KIND_MISMATCH' });
  });

  it('ensure refuses when the caller cannot edit the page', async () => {
    const { service, rows } = makeService({ canEdit: new Set() });
    await expect(
      service.ensure({ blockId: NEW, pageId: PAGE, kind: 'whiteboard' }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(rows.size).toBe(0);
  });

  it('ensure is refused on a trashed page', async () => {
    const { service, rows } = makeService({ canEdit: new Set([TRASHED_PAGE]) });
    await expect(
      service.ensure(
        { blockId: NEW, pageId: TRASHED_PAGE, kind: 'whiteboard' },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(rows.size).toBe(0);
  });

  it('ensure refusals carry stable codes: not found, not editable, in the trash', async () => {
    const { service } = makeService({ canEdit: new Set([TRASHED_PAGE]) });
    const answer = (pageId: string) =>
      service
        .ensure({ blockId: NEW, pageId, kind: 'whiteboard' }, user)
        .catch((e) => e);
    const missing = await answer('0193c7a0-1111-7abc-8def-00000000ffff');
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(missing.getResponse()).toMatchObject({ code: 'PAGE_NOT_FOUND' });
    const readOnly = await answer(PAGE);
    expect(readOnly).toBeInstanceOf(ForbiddenException);
    expect(readOnly.getResponse()).toMatchObject({ code: 'PAGE_NOT_EDITABLE' });
    const trashed = await answer(TRASHED_PAGE);
    expect(trashed).toBeInstanceOf(ForbiddenException);
    expect(trashed.getResponse()).toMatchObject({ code: 'PAGE_IN_TRASH' });
  });

  it('ensure refuses an unregistered kind with 400', async () => {
    const { service } = makeService();
    await expect(
      service.ensure({ blockId: NEW, pageId: PAGE, kind: 'nope' as any }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('two ensure calls racing on one new id both succeed', async () => {
    const { service, rows, race, liveBlockRepo } = makeService();
    // both callers reach the insert before either has written: the second insert conflicts
    race(2);
    const results = await Promise.all([
      service.ensure({ blockId: NEW, pageId: PAGE, kind: 'whiteboard' }, user),
      service.ensure({ blockId: NEW, pageId: PAGE, kind: 'whiteboard' }, user),
    ]);
    expect(results).toEqual([{ blockId: NEW }, { blockId: NEW }]);
    expect(liveBlockRepo.insertIfAbsent).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(1);
  });

  it('ensure answers 409 BLOCK_ID_TAKEN for a soft-deleted row with the same id', async () => {
    const { service, rows } = makeService();
    rows.set(NEW, {
      id: NEW,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      deletedAt: new Date(),
    });
    const err = await service
      .ensure({ blockId: NEW, pageId: PAGE, kind: 'whiteboard' }, user)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'BLOCK_ID_TAKEN' });
  });
});

describe('LiveBlockService.clone', () => {
  it('clone copies ydoc and snapshot under the new id for the target page', async () => {
    const { service, rows } = makeService();
    const src = boardBytes();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...src,
    });
    expect(
      await service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
    ).toEqual({ blockId: NEW });
    const copy = rows.get(NEW);
    expect(copy).toMatchObject({
      kind: 'whiteboard',
      pageId: OTHER_PAGE,
      workspaceId: WS,
      creatorId: USER,
    });
    expect(Buffer.compare(copy.ydoc, src.ydoc)).toBe(0);
    expect(copy.snapshot).toEqual(src.snapshot);
  });

  it('clone copies a block cut from its page after that page was stored without it (R53)', async () => {
    const { service, rows, pages } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    pages[PAGE].content = { type: 'doc', content: [] };
    await expect(
      service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
    ).resolves.toEqual({ blockId: NEW });
    expect(rows.get(NEW)).toMatchObject({ pageId: OTHER_PAGE });
  });

  it('clone copies a block whose page was not stored yet (copied seconds after creation)', async () => {
    const { service, rows, pages } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    pages[PAGE].content = null;
    await expect(
      service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
    ).resolves.toEqual({ blockId: NEW });
  });

  it('clone refuses a block from an unreadable page', async () => {
    const { service, rows } = makeService();
    rows.set(SECRET_BLOCK, {
      id: SECRET_BLOCK,
      kind: 'whiteboard',
      pageId: SECRET_PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    await expect(
      service.clone(
        { sourceBlockId: SECRET_BLOCK, blockId: NEW, pageId: PAGE },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rows.has(NEW)).toBe(false);
  });

  it('clone gives the same 404 for an unknown source and an unreadable one', async () => {
    const { service, rows } = makeService();
    rows.set(SECRET_BLOCK, {
      id: SECRET_BLOCK,
      kind: 'whiteboard',
      pageId: SECRET_PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    const a = await service
      .clone({ sourceBlockId: SECRET_BLOCK, blockId: NEW, pageId: PAGE }, user)
      .catch((e) => e);
    const b = await service
      .clone(
        {
          sourceBlockId: '0193c7a0-1111-7abc-8def-0000000000ff',
          blockId: NEW,
          pageId: PAGE,
        },
        user,
      )
      .catch((e) => e);
    expect(a).toBeInstanceOf(NotFoundException);
    expect(b).toBeInstanceOf(NotFoundException);
    expect(a.getResponse()).toEqual(b.getResponse());
  });

  it('clone refuses when the caller cannot edit the target page', async () => {
    const { service, rows } = makeService({ canEdit: new Set() });
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    await expect(
      service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('clone answers 409 when the new id is taken', async () => {
    const { service, rows } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    rows.set(NEW, {
      id: NEW,
      kind: 'whiteboard',
      pageId: OTHER_PAGE,
      workspaceId: WS,
    });
    const err = await service
      .clone({ sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE }, user)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'BLOCK_ID_TAKEN' });
  });

  it('clone flushes an open document before copying', async () => {
    const { service, rows, events, bridge } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    await service.clone(
      { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
      user,
    );
    expect(bridge.flush).toHaveBeenCalledWith([SRC]);
    expect(events.indexOf('flush')).toBeLessThan(
      events.indexOf(`find:${SRC}:ydoc`),
    );
  });

  it('clone answers 503 when the source is open but unreachable', async () => {
    const { service, rows, bridge } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    bridge.flush.mockResolvedValueOnce({ flushed: [], unreachable: [SRC] });
    await expect(
      service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(rows.has(NEW)).toBe(false);
  });

  it('clone of a whiteboard copies its image attachments to the target page and rewrites the ids', async () => {
    const { service, rows, storageService, insertedAttachments } =
      makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(true),
    });
    await service.clone(
      { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
      user,
    );
    expect(insertedAttachments).toHaveLength(1);
    const newId = insertedAttachments[0].id;
    expect(newId).not.toBe(IMG);
    expect(insertedAttachments[0]).toMatchObject({
      pageId: OTHER_PAGE,
      spaceId: SPACE,
      workspaceId: WS,
      creatorId: USER,
      filePath: `${WS}/files/${newId}/a.png`,
    });
    expect(storageService.copy).toHaveBeenCalledWith(
      `${WS}/files/${IMG}/a.png`,
      `${WS}/files/${newId}/a.png`,
    );
    const copy = rows.get(NEW);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(copy.ydoc));
    expect(readFiles(doc)).toEqual({
      f1: { attachmentId: newId, mimeType: 'image/png' },
    });
    expect(copy.snapshot.files).toEqual({
      f1: { attachmentId: newId, mimeType: 'image/png' },
    });
    // the source is untouched
    const srcDoc = new Y.Doc();
    Y.applyUpdate(srcDoc, new Uint8Array(rows.get(SRC).ydoc));
    expect(readFiles(srcDoc).f1.attachmentId).toBe(IMG);
  });

  it('clone answers 409 when a soft-deleted row has the new id', async () => {
    const { service, rows } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    rows.set(NEW, {
      id: NEW,
      kind: 'whiteboard',
      pageId: OTHER_PAGE,
      workspaceId: WS,
      ydoc: null,
      snapshot: null,
      deletedAt: new Date(),
    });
    const err = await service
      .clone({ sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE }, user)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'BLOCK_ID_TAKEN' });
    expect(rows.get(NEW).ydoc).toBeNull();
  });

  it('a board image that cannot be copied does not fail the clone', async () => {
    const { service, rows, storageService, insertedAttachments } =
      makeService();
    storageService.copy.mockRejectedValueOnce(new Error('object missing'));
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(true),
    });
    await expect(
      service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
    ).resolves.toEqual({ blockId: NEW });
    expect(insertedAttachments).toHaveLength(0);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(rows.get(NEW).ydoc));
    // the id is left unmapped
    expect(readFiles(doc).f1.attachmentId).toBe(IMG);
    expect(rows.get(NEW).pageId).toBe(OTHER_PAGE);
  });
});

describe('LiveBlockService.getSnapshot', () => {
  it('getSnapshot returns the empty snapshot for a block that was never stored', async () => {
    const { service, rows, pages } = makeService();
    const updatedAt = new Date();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ydoc: null,
      snapshot: null,
      updatedAt,
    });
    expect(await service.getSnapshot(SRC, pages[PAGE])).toEqual({
      kind: 'whiteboard',
      snapshot: { kind: 'whiteboard', elements: [], files: {} },
      snapshotStale: false,
      updatedAt,
    });
  });

  it('getSnapshot returns the stored snapshot', async () => {
    const { service, rows, pages } = makeService();
    const src = boardBytes();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...src,
      updatedAt: new Date(),
    });
    expect((await service.getSnapshot(SRC, pages[PAGE])).snapshot).toEqual(
      src.snapshot,
    );
  });

  it('snapshot refuses a block id that is not in the page content', async () => {
    const { service, rows, pages } = makeService();
    rows.set(NEW, {
      id: NEW,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      updatedAt: new Date(),
    });
    await expect(service.getSnapshot(NEW, pages[PAGE])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('snapshot refuses a block that belongs to another page', async () => {
    const { service, rows, pages } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: OTHER_PAGE,
      workspaceId: WS,
      updatedAt: new Date(),
    });
    await expect(service.getSnapshot(SRC, pages[PAGE])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('LiveBlockService.applyOps', () => {
  it('authorises on the page and goes through the bridge', async () => {
    const { service, rows, bridge, pageAccessService } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
    });
    await service.applyOps(SRC, [{ type: 'x' }], user);
    expect(pageAccessService.validateCanEdit).toHaveBeenCalled();
    expect(bridge.apply).toHaveBeenCalledWith(
      SRC,
      'whiteboard',
      [{ type: 'x' }],
      user,
    );
  });

  it('refuses a block of a page the caller cannot edit', async () => {
    const { service, rows, bridge } = makeService({ canEdit: new Set() });
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
    });
    await expect(service.applyOps(SRC, [], user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(bridge.apply).not.toHaveBeenCalled();
  });
});

describe('share route for a block snapshot', () => {
  function makeController(opts: { covered: boolean; allowed: boolean }) {
    const { service, rows, pages } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      updatedAt: new Date(),
    });
    const shareService = {
      getSharedPage: jest.fn(async (dto: any) => {
        if (!opts.covered || dto.pageId !== PAGE)
          throw new NotFoundException('Shared page not found');
        return { page: pages[PAGE], share: { spaceId: SPACE } };
      }),
      isSharingAllowed: jest.fn(async () => opts.allowed),
    };
    const getSnapshot = jest.spyOn(service, 'getSnapshot');
    const controller = new ShareController(
      shareService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      service,
    );
    return { controller, shareService, getSnapshot };
  }

  it('share snapshot is refused for a page the share does not cover, and when sharing is not allowed', async () => {
    const uncovered = makeController({ covered: false, allowed: true });
    await expect(
      uncovered.controller.getSharedLiveBlock(
        { pageId: PAGE, blockId: SRC, shareId: 'k' },
        { id: WS } as any,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(uncovered.getSnapshot).not.toHaveBeenCalled();

    const disallowed = makeController({ covered: true, allowed: false });
    await expect(
      disallowed.controller.getSharedLiveBlock({ pageId: PAGE, blockId: SRC }, {
        id: WS,
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(disallowed.getSnapshot).not.toHaveBeenCalled();
  });

  it('share snapshot goes through getSharedPage and uses the content it returns', async () => {
    const { controller, shareService } = makeController({
      covered: true,
      allowed: true,
    });
    const res = await controller.getSharedLiveBlock(
      { pageId: PAGE, blockId: SRC, shareId: 'k' },
      { id: WS } as any,
    );
    expect(shareService.getSharedPage).toHaveBeenCalledWith(
      { pageId: PAGE, shareId: 'k' },
      WS,
    );
    expect(res.kind).toBe('whiteboard');
  });

  it('share snapshot refuses a block that is not on the shared page', async () => {
    const { controller } = makeController({ covered: true, allowed: true });
    await expect(
      controller.getSharedLiveBlock({ pageId: PAGE, blockId: NEW }, {
        id: WS,
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('LiveBlockService.createOnPage cleanup', () => {
  const NEW_PAGE = '019a1f00-0000-7000-8000-000000000010';

  function setup(opts: { appendFails?: boolean } = {}) {
    let ctx: ReturnType<typeof makeService>;
    const pageService = {
      create: jest.fn(async () => {
        ctx.pages[NEW_PAGE] = {
          id: NEW_PAGE,
          slugId: 'new-page',
          spaceId: SPACE,
          workspaceId: WS,
          deletedAt: null,
          content: { type: 'doc', content: [] },
        };
        return { ...ctx.pages[NEW_PAGE] };
      }),
      updatePageContent: jest.fn(async () => {
        if (opts.appendFails) throw new Error('append failed');
      }),
    };
    ctx = makeService({ pageService });
    return { ...ctx, pageService };
  }

  const args = (target: any) => ({
    kind: 'todo' as const,
    title: 'Board',
    user,
    target,
    baseUrl: 'http://x',
  });

  it('fails before making a page when the sync server cannot be reached', async () => {
    const { service, pages, pageService, bridge } = setup();
    bridge.liveDocumentsReachable.mockReturnValue(false);
    await expect(
      service.createOnPage(args({ spaceId: SPACE })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      service.createOnPage(args({ pageId: OTHER_PAGE })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(pageService.create).not.toHaveBeenCalled();
    expect(pages[NEW_PAGE]).toBeUndefined();
  });

  it('trashes the new page and the block row when the append fails', async () => {
    const { service, pages, rows, pageRepo } = setup({ appendFails: true });
    await expect(
      service.createOnPage(args({ spaceId: SPACE })),
    ).rejects.toThrow('append failed');
    expect(pageRepo.removePage).toHaveBeenCalledWith(NEW_PAGE, USER, WS);
    expect(pages[NEW_PAGE].deletedAt).toBeInstanceOf(Date);
    const [row] = [...rows.values()];
    expect(row.deletedAt).toBeInstanceOf(Date);
  });

  it('keeps an existing page when the append fails, and trashes only the row', async () => {
    const { service, pages, rows, pageRepo } = setup({ appendFails: true });
    await expect(
      service.createOnPage(args({ pageId: OTHER_PAGE })),
    ).rejects.toThrow('append failed');
    expect(pageRepo.removePage).not.toHaveBeenCalled();
    expect(pages[OTHER_PAGE].deletedAt).toBeNull();
    const [row] = [...rows.values()];
    expect(row.deletedAt).toBeInstanceOf(Date);
  });

  it('trashes the block row and the new page when the seed fails', async () => {
    const { service, pages, rows, liveBlockRepo, pageService } = setup();
    liveBlockRepo.seedIfEmpty.mockRejectedValueOnce(new Error('seed failed'));
    await expect(
      service.createOnPage(args({ spaceId: SPACE })),
    ).rejects.toThrow('seed failed');
    expect(pageService.updatePageContent).not.toHaveBeenCalled();
    const [row] = [...rows.values()];
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(pages[NEW_PAGE].deletedAt).toBeInstanceOf(Date);
  });

  it('a failed cleanup is logged and the original error is rethrown', async () => {
    const { service, liveBlockRepo, pageRepo } = setup({ appendFails: true });
    liveBlockRepo.softDelete.mockRejectedValueOnce(new Error('db down'));
    pageRepo.removePage.mockRejectedValueOnce(new Error('db down'));
    const logged = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);
    await expect(
      service.createOnPage(args({ spaceId: SPACE })),
    ).rejects.toThrow('append failed');
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it('does not touch a row that belongs to another page', async () => {
    const { service, rows, liveBlockRepo, pageRepo } = setup();
    liveBlockRepo.insertIfAbsent.mockImplementationOnce(async (b: any) => {
      rows.set(b.id, { ...b, pageId: PAGE, deletedAt: null });
      return rows.get(b.id);
    });
    await expect(
      service.createOnPage(args({ spaceId: SPACE })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(liveBlockRepo.softDelete).not.toHaveBeenCalled();
    expect(pageRepo.removePage).toHaveBeenCalledWith(NEW_PAGE, USER, WS);
  });
});

describe('LiveBlockService.inlineForExport', () => {
  it('flushes only blocks that are stored rows of this page, never ids the content merely names', async () => {
    const { service, rows, bridge } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    rows.set(SECRET_BLOCK, {
      id: SECRET_BLOCK,
      kind: 'whiteboard',
      pageId: SECRET_PAGE,
      workspaceId: WS,
    });
    const fake = Array.from(
      { length: 50 },
      (_, i) => `0193c7a0-1111-7abc-8def-${String(i).padStart(12, '0')}`,
    );
    const content = {
      type: 'doc',
      content: [
        { type: 'whiteboard', attrs: { blockId: SRC } },
        // another page's block, and ids that are no block at all
        { type: 'whiteboard', attrs: { blockId: SECRET_BLOCK } },
        ...fake.map((blockId) => ({ type: 'sheet', attrs: { blockId } })),
      ],
    };
    await service.inlineForExport(
      content,
      { id: PAGE, slugId: 's' } as any,
      'https://docs.test',
    );
    expect(bridge.flush).toHaveBeenCalledTimes(1);
    expect(bridge.flush).toHaveBeenCalledWith([SRC]);
  });

  it('flushes nothing when none of the named blocks is a row of the page', async () => {
    const { service, bridge } = makeService();
    const content = {
      type: 'doc',
      content: [{ type: 'sheet', attrs: { blockId: NEW } }],
    };
    await service.inlineForExport(
      content,
      { id: PAGE, slugId: 's' } as any,
      'https://docs.test',
    );
    expect(bridge.flush).not.toHaveBeenCalled();
  });
});

describe('a snapshot that failed or was cut short on the store path', () => {
  const UPDATED = new Date('2026-11-01T00:00:00Z');
  // a small sheet: its full build is complete
  const sheetBytes = () => {
    const doc = seedYdoc(emptySnapshot('sheet'));
    return {
      ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)),
      full: buildSnapshot('sheet', doc),
    };
  };
  const sheetRow = (extra: any = {}) => {
    const { ydoc, full } = sheetBytes();
    return {
      row: {
        id: SRC,
        kind: 'sheet',
        pageId: PAGE,
        workspaceId: WS,
        updatedAt: UPDATED,
        snapshotError: null,
        ydoc,
        // what a 250 ms store build left behind
        snapshot: { ...full, truncated: true },
        ...extra,
      },
      full,
    };
  };

  it('readFresh rebuilds a truncated sheet with the full budget, saves it and serves it', async () => {
    const { service, rows, liveBlockRepo } = makeService();
    const { row, full } = sheetRow();
    rows.set(SRC, row);
    const served = (await service.readFresh(SRC)) as any;
    expect(served.truncated).toBe(false);
    expect(served).toEqual(full);
    expect(liveBlockRepo.saveRebuiltSnapshot).toHaveBeenCalledWith(
      SRC,
      full,
      UPDATED,
    );
    expect(rows.get(SRC).snapshot).toEqual(full);
  });

  it('readFresh rebuilds after a failed store build, and clears the error', async () => {
    const { service, rows } = makeService();
    const { row, full } = sheetRow({
      snapshotError: 'budget exceeded',
      snapshot: null,
    });
    rows.set(SRC, row);
    expect(await service.readFresh(SRC)).toEqual(full);
    expect(rows.get(SRC).snapshotError).toBeNull();
  });

  it('readFresh answers 503 only when the rebuild fails too', async () => {
    const { service, rows } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      updatedAt: UPDATED,
      snapshotError: 'budget exceeded',
      ydoc: Buffer.from([1, 2, 3, 4, 5]), // not a document
      snapshot: null,
    });
    await expect(service.readFresh(SRC)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('readFresh serves the stored snapshot when the last build succeeded, without a rebuild', async () => {
    const { service, rows, liveBlockRepo } = makeService();
    const src = boardBytes();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      snapshotError: null,
      ...src,
    });
    expect(await service.readFresh(SRC)).toEqual(src.snapshot);
    expect(liveBlockRepo.saveRebuiltSnapshot).not.toHaveBeenCalled();
  });

  it('getSnapshot serves the rebuilt snapshot', async () => {
    const { service, rows, pages } = makeService();
    const { row, full } = sheetRow({ snapshotError: 'budget exceeded' });
    rows.set(SRC, row);
    pages[PAGE].content = {
      type: 'doc',
      content: [{ type: 'sheet', attrs: { blockId: SRC } }],
    };
    const result = await service.getSnapshot(SRC, pages[PAGE]);
    expect(result.snapshot).toEqual(full);
    expect(result.snapshotStale).toBe(false);
  });

  it('a rebuild does not overwrite a snapshot stored meanwhile', async () => {
    const { service, rows, liveBlockRepo } = makeService();
    const { row } = sheetRow();
    rows.set(SRC, row);
    const find = liveBlockRepo.findById.getMockImplementation()!;
    liveBlockRepo.findById.mockImplementation(async (id: string, o?: any) => {
      const found = await find(id, o);
      if (o?.includeYdoc) {
        // the sync server stores a newer document while the rebuild runs
        rows.get(SRC).updatedAt = new Date();
        rows.get(SRC).snapshot = { marker: 'newer' };
      }
      return found;
    });
    await service.readFresh(SRC);
    expect(liveBlockRepo.saveRebuiltSnapshot).toHaveBeenCalled();
    expect(rows.get(SRC).snapshot).toEqual({ marker: 'newer' });
  });

  it('concurrent reads share one rebuild', async () => {
    const { service, rows, liveBlockRepo } = makeService();
    const { row } = sheetRow();
    rows.set(SRC, row);
    await Promise.all([
      service.readFresh(SRC),
      service.readFresh(SRC),
      service.readFresh(SRC),
    ]);
    expect(liveBlockRepo.saveRebuiltSnapshot).toHaveBeenCalledTimes(1);
  });

  it('a sheet still truncated with the full budget is served marked truncated, and not rebuilt again until it changes', async () => {
    const { service, rows, events } = makeService();
    // more cells than a snapshot shows: truncated whatever the budget
    const book = sheet.createEmptyBook();
    const tab = book.sheets[0];
    tab.rows = 5000;
    tab.cols = 11;
    for (let r = 0; r < 5000; r++) {
      for (let c = 0; c < 11; c++) sheet.setCellRaw(tab, r, c, String(r + c));
    }
    const doc = new Y.Doc();
    sheet.seedSheet(doc, book);
    rows.set(SRC, {
      id: SRC,
      kind: 'sheet',
      pageId: PAGE,
      workspaceId: WS,
      updatedAt: UPDATED,
      snapshotError: null,
      ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)),
      snapshot: { kind: 'sheet', book, display: {}, truncated: true },
    });
    const rebuilds = () =>
      events.filter((e) => e === `find:${SRC}:ydoc`).length;
    expect(((await service.readFresh(SRC)) as any).truncated).toBe(true);
    expect(((await service.readFresh(SRC)) as any).truncated).toBe(true);
    expect(rebuilds()).toBe(1);
    // a newer stored document is rebuilt again, once the floor has passed
    rows.get(SRC).updatedAt = new Date();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    try {
      await service.readFresh(SRC);
    } finally {
      clock.mockRestore();
    }
    expect(rebuilds()).toBe(2);
  });

  it('a rebuild whose save matched no row is not repeated on every read', async () => {
    const { service, rows, events, liveBlockRepo } = makeService();
    const { row, full } = sheetRow({ snapshotError: 'budget exceeded' });
    rows.set(SRC, row);
    liveBlockRepo.saveRebuiltSnapshot.mockResolvedValue(false);
    const rebuilds = () =>
      events.filter((e) => e === `find:${SRC}:ydoc`).length;
    for (let i = 0; i < 3; i++) {
      expect(await service.readFresh(SRC)).toEqual(full);
    }
    expect(rebuilds()).toBe(1);
  });

  it('a block is rebuilt at most once per 30 s in a process, even when it keeps changing', async () => {
    const { service, rows, events } = makeService();
    const { row } = sheetRow({ snapshotError: 'budget exceeded' });
    rows.set(SRC, row);
    const rebuilds = () =>
      events.filter((e) => e === `find:${SRC}:ydoc`).length;
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await service.readFresh(SRC);
      for (let i = 1; i <= 3; i++) {
        // the stored document changes and its store build fails again
        rows.get(SRC).updatedAt = new Date(start + i);
        rows.get(SRC).snapshotError = 'budget exceeded';
        clock.mockReturnValue(start + i * 1000);
        await service.readFresh(SRC);
      }
      expect(rebuilds()).toBe(1);
      clock.mockReturnValue(start + 31_000);
      await service.readFresh(SRC);
      expect(rebuilds()).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('a rebuild that fails is not retried on every read either', async () => {
    const { service, rows, events } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      updatedAt: UPDATED,
      snapshotError: 'budget exceeded',
      ydoc: Buffer.from([1, 2, 3, 4, 5]),
      snapshot: null,
    });
    for (let i = 0; i < 3; i++) {
      await expect(service.readFresh(SRC)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    }
    expect(events.filter((e) => e === `find:${SRC}:ydoc`)).toHaveLength(1);
  });

  it('export inlines the rebuilt snapshot', async () => {
    const { service, rows } = makeService();
    const { row } = sheetRow({ snapshotError: 'budget exceeded' });
    rows.set(SRC, row);
    const content = {
      type: 'doc',
      content: [{ type: 'sheet', attrs: { blockId: SRC, title: 'Budget' } }],
    };
    await service.inlineForExport(
      content,
      { id: PAGE, slugId: 's' },
      'http://x',
    );
    expect(rows.get(SRC).snapshotError).toBeNull();
  });
});

describe("another workspace's block ids", () => {
  const FOREIGN = {
    id: NEW,
    kind: 'sheet',
    pageId: 'foreign-page',
    workspaceId: 'other-ws',
  };

  it('ensure: a foreign id fails exactly like a taken id of this workspace, with no kind leaked', async () => {
    const foreign = makeService();
    foreign.rows.set(NEW, { ...FOREIGN });
    const ours = makeService();
    ours.rows.set(NEW, {
      id: NEW,
      kind: 'whiteboard',
      pageId: OTHER_PAGE,
      workspaceId: WS,
    });
    // whiteboard was asked for and the foreign row is a sheet: still no KIND_MISMATCH
    const a = await foreign.service
      .ensure({ blockId: NEW, pageId: PAGE, kind: 'whiteboard' }, user)
      .catch((e) => e);
    const b = await ours.service
      .ensure({ blockId: NEW, pageId: PAGE, kind: 'whiteboard' }, user)
      .catch((e) => e);
    expect(a).toBeInstanceOf(ConflictException);
    expect(a.getResponse()).toEqual(b.getResponse());
  });

  it('clone: a foreign target id fails like a taken one, and leaves no copied file', async () => {
    const { service, rows, storageService } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(true),
    });
    rows.set(NEW, { ...FOREIGN });
    const err = await service
      .clone({ sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE }, user)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'BLOCK_ID_TAKEN' });
    // whatever was copied before the clash was found is removed again
    expect(storageService.delete).toHaveBeenCalledTimes(
      storageService.copy.mock.calls.length,
    );
    expect(rows.get(NEW)).toMatchObject({ workspaceId: 'other-ws' });
  });

  it('clone looks up the target id only within the caller workspace', async () => {
    const { service, rows, liveBlockRepo } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(),
    });
    await service.clone(
      { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
      user,
    );
    const probe = liveBlockRepo.findById.mock.calls.find(
      ([id]: any[]) => id === NEW,
    );
    expect(probe?.[1]).toMatchObject({ workspaceId: WS });
  });
});

describe('two clones racing onto one new id', () => {
  it('one wins; the loser removes the files it copied and fails', async () => {
    const { service, rows, race, storageService, insertedAttachments } =
      makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'whiteboard',
      pageId: PAGE,
      workspaceId: WS,
      ...boardBytes(true),
    });
    race(2);
    const results = await Promise.allSettled([
      service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
      service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const lost = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ConflictException);
    // both copied the image; only the winner's file is left
    expect(storageService.copy).toHaveBeenCalledTimes(2);
    expect(storageService.delete).toHaveBeenCalledTimes(1);
    const kept = rows.get(NEW);
    const deleted = (storageService.delete.mock.calls[0] as any[])[0];
    expect(JSON.stringify(kept.snapshot)).not.toContain(
      deleted.split('/').slice(-2, -1)[0],
    );
    expect(insertedAttachments).toHaveLength(2);
  });
});

describe('copied files after a failed copy', () => {
  const COPY_PATH = (id: string) => `${WS}/files/${id}/a.png`;
  const boardRow = () => ({
    id: SRC,
    kind: 'whiteboard',
    pageId: PAGE,
    workspaceId: WS,
    ...boardBytes(true),
  });
  const copiedTo = (storageService: any) =>
    storageService.copy.mock.calls.map((c: any[]) => c[1]);

  it('clone removes the copied files when the insert throws, and rethrows', async () => {
    const { service, rows, liveBlockRepo, storageService } = makeService();
    rows.set(SRC, boardRow());
    liveBlockRepo.insertNew.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
    ).rejects.toThrow('db down');
    const [copied] = copiedTo(storageService);
    expect(copied).toBeDefined();
    expect(storageService.delete).toHaveBeenCalledWith(copied);
  });

  it('clone removes the copied files when the transaction fails to commit', async () => {
    const { service, rows, db, storageService } = makeService();
    rows.set(SRC, boardRow());
    const run = db.transaction;
    db.transaction = () => ({
      execute: async (fn: any) => {
        await run().execute(fn);
        throw new Error('commit failed');
      },
    });
    await expect(
      service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
    ).rejects.toThrow('commit failed');
    const [copied] = copiedTo(storageService);
    expect(storageService.delete).toHaveBeenCalledWith(copied);
  });

  it('a stored path without its attachment id is copied to a path of its own, never onto itself', async () => {
    const { service, rows, attachments, storageService, liveBlockRepo } =
      makeService();
    const legacy = `${WS}/files/legacy/a.png`;
    attachments.get(IMG).filePath = legacy;
    rows.set(SRC, boardRow());
    liveBlockRepo.insertNew.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.clone(
        { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
        user,
      ),
    ).rejects.toThrow('db down');
    const [[from, to]] = storageService.copy.mock.calls as any[];
    expect(from).toBe(legacy);
    expect(to).not.toBe(legacy);
    expect(storageService.delete).toHaveBeenCalledWith(to);
    expect(storageService.delete).not.toHaveBeenCalledWith(legacy);
  });

  it('page duplication removes every copied file when a later step fails', async () => {
    const { service, rows, liveBlockRepo, storageService } = makeService();
    rows.set(SRC, boardRow());
    const plan = await service.planPageCopies([
      {
        id: PAGE,
        content: {
          type: 'doc',
          content: [{ type: 'whiteboard', attrs: { blockId: SRC } }],
        },
      },
    ]);
    await service.insertPageCopies(
      plan,
      new Map([[PAGE, OTHER_PAGE]]),
      {} as any,
      { spaceId: SPACE, creatorId: USER },
    );
    const [copied] = copiedTo(storageService);
    expect(copied).toMatch(/^.+\/files\/.+\/a\.png$/);
    expect(copied).not.toBe(COPY_PATH(IMG));
    // the page transaction then fails
    await service.removeCopiedFiles(plan);
    expect(storageService.delete).toHaveBeenCalledWith(copied);
    expect(liveBlockRepo.insertNew).toHaveBeenCalled();
  });

  it('a copy keeps the source snapshot error, so it does not look fresh', async () => {
    const { service, rows } = makeService();
    rows.set(SRC, {
      id: SRC,
      kind: 'todo',
      pageId: PAGE,
      workspaceId: WS,
      ydoc: null,
      snapshot: null,
      snapshotError: 'budget exceeded',
    });
    await service.clone(
      { sourceBlockId: SRC, blockId: NEW, pageId: OTHER_PAGE },
      user,
    );
    expect(rows.get(NEW).snapshotError).toBe('budget exceeded');
  });
});
