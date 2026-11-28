import * as Y from 'yjs';
import { Logger } from '@nestjs/common';
import {
  pushElements,
  readElements,
  STORE_SNAPSHOT_BUDGET_MS,
} from '@docmost/live-blocks';
import { LiveBlockCollabService } from './live-block-collab.service';

const BLOCK_ID = '0193c7a0-1111-7abc-8def-000000000001';
const NAME = `block.${BLOCK_ID}`;

function makeService(row: any) {
  const repo = {
    findById: jest.fn(async () => (row ? { ...row } : undefined)),
    saveYdoc: jest.fn(async () => undefined),
    saveSnapshot: jest.fn(async () => undefined),
  };
  return { service: new LiveBlockCollabService(repo as any), repo };
}

describe('LiveBlockCollabService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('resolves a block of the workspace and remembers its page', async () => {
    const { service } = makeService({
      id: BLOCK_ID,
      kind: 'whiteboard',
      pageId: 'page-1',
      workspaceId: 'ws-1',
    });
    expect(await service.resolve(BLOCK_ID, 'ws-1')).toMatchObject({
      pageId: 'page-1',
    });
    expect(service.pageIdOf(NAME)).toBe('page-1');
    service.forget(NAME);
    expect(service.pageIdOf(NAME)).toBeUndefined();
  });

  it('resolve is null for a missing block or one in another workspace', async () => {
    expect(
      await makeService(undefined).service.resolve(BLOCK_ID, 'ws-1'),
    ).toBeNull();
    const other = makeService({
      id: BLOCK_ID,
      pageId: 'p',
      workspaceId: 'ws-2',
    });
    expect(await other.service.resolve(BLOCK_ID, 'ws-1')).toBeNull();
    expect(other.service.pageIdOf(NAME)).toBeUndefined();
  });

  it('load applies the stored bytes, or gives an empty doc', async () => {
    const source = new Y.Doc();
    pushElements(source, [{ id: 'r1', type: 'rectangle', version: 3 }]);
    const { service, repo } = makeService({
      id: BLOCK_ID,
      kind: 'whiteboard',
      pageId: 'page-1',
      workspaceId: 'ws-1',
      ydoc: Buffer.from(Y.encodeStateAsUpdate(source)),
    });
    const doc = await service.load(BLOCK_ID);
    expect(readElements(doc)).toEqual([
      { id: 'r1', type: 'rectangle', version: 3 },
    ]);
    expect(repo.findById).toHaveBeenCalledWith(BLOCK_ID, { includeYdoc: true });
    expect(service.pageIdOf(NAME)).toBe('page-1');

    const empty = await makeService(undefined).service.load(BLOCK_ID);
    expect(readElements(empty)).toEqual([]);
  });

  it('store saves the ydoc, then a snapshot built for the kind', async () => {
    const { service, repo } = makeService({
      id: BLOCK_ID,
      kind: 'whiteboard',
      pageId: 'page-1',
      workspaceId: 'ws-1',
    });
    const doc = new Y.Doc();
    pushElements(doc, [{ id: 'r1', version: 1, type: 'rectangle' }]);
    await service.store(BLOCK_ID, doc);
    expect(repo.saveYdoc).toHaveBeenCalledWith(
      BLOCK_ID,
      Buffer.from(Y.encodeStateAsUpdate(doc)),
    );
    expect(repo.saveSnapshot).toHaveBeenCalledWith(
      BLOCK_ID,
      {
        kind: 'whiteboard',
        elements: [{ id: 'r1', version: 1, type: 'rectangle' }],
        files: {},
      },
      null,
    );
    expect(repo.saveYdoc.mock.invocationCallOrder[0]).toBeLessThan(
      repo.saveSnapshot.mock.invocationCallOrder[0],
    );
  });

  it('store records the error and still succeeds when the snapshot cannot be built', async () => {
    const { service, repo } = makeService({ id: BLOCK_ID, kind: 'whiteboard' });
    jest.spyOn(service as any, 'snapshotOf').mockImplementation(() => {
      throw new Error('bad scene');
    });
    await expect(service.store(BLOCK_ID, new Y.Doc())).resolves.toBeUndefined();
    expect(repo.saveYdoc).toHaveBeenCalled();
    expect(repo.saveSnapshot).toHaveBeenCalledWith(BLOCK_ID, null, 'bad scene');
  });

  it('store rethrows when the ydoc cannot be saved, without touching the snapshot', async () => {
    const { service, repo } = makeService({ id: BLOCK_ID, kind: 'whiteboard' });
    const error = new Error('db down');
    repo.saveYdoc.mockRejectedValueOnce(error);
    await expect(service.store(BLOCK_ID, new Y.Doc())).rejects.toBe(error);
    expect(repo.saveSnapshot).not.toHaveBeenCalled();
  });

  it('isOpen is true after a successful load and false after a failed one', async () => {
    const { service, repo } = makeService({
      id: BLOCK_ID,
      kind: 'whiteboard',
      pageId: 'page-1',
      workspaceId: 'ws-1',
    });
    repo.findById.mockRejectedValueOnce(new Error('db down'));
    await expect(service.load(BLOCK_ID)).rejects.toThrow('db down');
    expect(service.isOpen(NAME)).toBe(false);
    await service.load(BLOCK_ID);
    expect(service.isOpen(NAME)).toBe(true);
    service.forget(NAME);
    expect(service.isOpen(NAME)).toBe(false);
  });

  it('the store path builds the snapshot with the short store deadline', async () => {
    const { service } = makeService({
      id: BLOCK_ID,
      kind: 'sheet',
      pageId: 'p',
      workspaceId: 'w',
    });
    const build = jest.spyOn(service as any, 'snapshotOf');
    await service.store(BLOCK_ID, new Y.Doc());
    expect(STORE_SNAPSHOT_BUDGET_MS).toBe(250);
    expect(build).toHaveBeenCalledWith('sheet', expect.any(Y.Doc), {
      budgetMs: 250,
    });
  });
});
