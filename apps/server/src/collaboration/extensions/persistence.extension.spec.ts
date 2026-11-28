import {
  Document,
  Hocuspocus,
  type onChangePayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
} from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { Logger } from '@nestjs/common';
import * as Y from 'yjs';
import { PersistenceExtension } from './persistence.extension';
import { tiptapExtensions } from '../collaboration.util';
import { QueueJob } from '../../integrations/queue/constants';
import { pushElements, readElements } from '@docmost/live-blocks';
import { LiveBlockCollabService } from '../live-block/live-block-collab.service';

const textDoc = (text: string, marks?: object[]) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text, ...(marks && { marks }) }],
    },
  ],
});

describe('PersistenceExtension.onStoreDocument', () => {
  const updatedAt = new Date('2026-01-01T00:00:00.000Z');
  let pageRepo: any;
  let historyQueue: any;
  let collabHistory: any;
  let extension: PersistenceExtension;

  beforeEach(() => {
    pageRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'page-1',
        slugId: 'slug-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
        creatorId: 'creator-1',
        contributorIds: [],
        content: textDoc('hello'),
        createdAt: new Date(0),
        updatedAt,
      }),
      updatePage: jest.fn().mockResolvedValue(undefined),
    };
    const db: any = {
      transaction: () => ({ execute: (callback: any) => callback({}) }),
    };
    const queue = () => ({ add: jest.fn().mockResolvedValue(undefined) });
    historyQueue = queue();
    collabHistory = { addContributors: jest.fn().mockResolvedValue(undefined) };
    extension = new PersistenceExtension(
      pageRepo,
      db,
      queue() as any,
      historyQueue,
      queue() as any,
      collabHistory,
      {
        syncPageTransclusions: jest.fn().mockResolvedValue(undefined),
        syncPageReferences: jest.fn().mockResolvedValue(undefined),
      } as any,
      {
        invalidateForEdit: jest.fn().mockResolvedValue(null),
        notifyInvalidated: jest.fn().mockResolvedValue(undefined),
      } as any,
      { getPageHistoryInterval: () => 5 * 60_000 } as any,
      {} as any,
    );
  });

  async function store(content: object) {
    const document: any = TiptapTransformer.toYdoc(
      content,
      'default',
      tiptapExtensions,
    );
    document.broadcastStateless = jest.fn();
    const context = { user: { id: 'user-1', name: 'User' } };
    await extension.onChange({
      documentName: 'page.page-1',
      context,
    } as any);
    await extension.onStoreDocument({
      documentName: 'page.page-1',
      document,
      lastContext: context,
    } as any);
    return document;
  }

  it('saves a comment without counting it as an edit', async () => {
    const document = await store(
      textDoc('hello', [
        { type: 'comment', attrs: { commentId: 'comment-1', resolved: false } },
      ]),
    );

    const update = pageRepo.updatePage.mock.calls[0][0];
    expect(update.content).toEqual(
      TiptapTransformer.fromYdoc(document, 'default'),
    );
    expect(update.updatedAt).toBe(updatedAt);
    expect(update).not.toHaveProperty('lastUpdatedById');
    expect(update).not.toHaveProperty('contributorIds');
    expect(collabHistory.addContributors).not.toHaveBeenCalled();
    expect(document.broadcastStateless).not.toHaveBeenCalled();
    expect(historyQueue.add).not.toHaveBeenCalled();
  });

  it('credits a visible change to the editor', async () => {
    const document = await store(textDoc('hello world'));

    const update = pageRepo.updatePage.mock.calls[0][0];
    expect(update).not.toHaveProperty('updatedAt');
    expect(update.lastUpdatedById).toBe('user-1');
    expect(update.contributorIds).toEqual(['user-1', 'creator-1']);
    expect(collabHistory.addContributors).toHaveBeenCalledWith('page-1', [
      'user-1',
    ]);
    expect(document.broadcastStateless).toHaveBeenCalledTimes(1);
    expect(historyQueue.add).toHaveBeenCalledWith(
      QueueJob.PAGE_HISTORY,
      { pageId: 'page-1' },
      expect.objectContaining({ jobId: 'page-1' }),
    );
  });
});

const documentName = 'page.test-page';
const previousContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Published' }] }],
};

function setup() {
  const page = {
    id: 'test-page',
    spaceId: 'space',
    workspaceId: 'workspace',
    creatorId: 'creator',
    createdAt: new Date(),
    content: previousContent,
    textContent: 'Published',
    ydoc: null as Buffer | null,
  };
  const repo = {
    findById: jest.fn(async () => ({ ...page })),
    saveYdocState: jest.fn(async (_id: string, state: Buffer) => {
      page.ydoc = state;
    }),
    updatePage: jest.fn(async (values) => {
      Object.assign(page, values);
    }),
  };
  const db = { transaction: () => ({ execute: (fn) => fn({}) }) };
  const queue = { add: jest.fn() };
  const history = { addContributors: jest.fn() };
  const transclusion = {
    syncPageTransclusions: jest.fn(),
    syncPageReferences: jest.fn(),
  };
  const extension = new PersistenceExtension(
    repo as any,
    db as any,
    queue as any,
    queue as any,
    queue as any,
    history as any,
    transclusion as any,
    {
      invalidateForEdit: jest.fn(async () => null),
      notifyInvalidated: jest.fn(),
    } as any,
    { getPageHistoryInterval: () => 300_000 } as any,
    {} as any,
  );
  return { extension, page, repo, queue, history, transclusion };
}

function failConversion() {
  return jest.spyOn(TiptapTransformer, 'fromYdoc').mockImplementation(() => {
    throw new Error('Editor conversion failed');
  });
}

describe('PersistenceExtension document storage', () => {
  let doc: Document;
  let text: Y.XmlText;
  let payload: onStoreDocumentPayload;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    doc = new Document(documentName);
    const paragraph = new Y.XmlElement('paragraph');
    text = new Y.XmlText();
    doc.getXmlFragment('default').insert(0, [paragraph]);
    paragraph.insert(0, [text]);
    text.insert(0, 'Latest edit');
    payload = {
      document: doc,
      documentName,
      instance: new Hocuspocus(),
      lastContext: { user: { id: 'editor' } },
    } as onStoreDocumentPayload;
  });

  afterEach(() => {
    doc.destroy();
    jest.restoreAllMocks();
  });

  it('restores the latest Yjs edit while keeping the last good editor content', async () => {
    const { extension, page, queue, history, transclusion } = setup();
    const broadcast = jest.spyOn(doc, 'broadcastStateless');
    const converter = failConversion();
    await extension.onChange({
      documentName,
      context: { user: { id: 'editor' } },
    } as onChangePayload);
    await extension.onStoreDocument(payload);
    expect(page.content).toEqual(previousContent);
    expect(page.textContent).toBe('Published');
    expect(queue.add).not.toHaveBeenCalled();
    expect(history.addContributors).not.toHaveBeenCalled();
    expect(transclusion.syncPageTransclusions).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();

    const empty = new Document(documentName);
    try {
      const restored = await extension.onLoadDocument({
        document: empty,
        documentName,
      } as onLoadDocumentPayload);
      expect(restored.getXmlFragment('default').toString()).toBe(
        '<paragraph>Latest edit</paragraph>',
      );
      restored.destroy();
    } finally {
      empty.destroy();
    }

    converter.mockRestore();
    await extension.onStoreDocument(payload);
    expect(page.textContent).toBe('Latest edit');
    expect(history.addContributors).toHaveBeenCalledWith(page.id, ['editor']);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('saves a repair that converts back to the previously published JSON', async () => {
    const { extension, page, queue } = setup();
    const converter = failConversion();
    await extension.onStoreDocument(payload);
    converter.mockRestore();
    text.delete(0, text.length);
    text.insert(0, 'Published');
    await extension.onStoreDocument(payload);

    expect(page.ydoc).toEqual(Buffer.from(Y.encodeStateAsUpdate(doc)));
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('surfaces a failed snapshot write and can retry it', async () => {
    const { extension, repo, page } = setup();
    const error = new Error('Database unavailable');
    repo.saveYdocState.mockRejectedValueOnce(error);
    failConversion();
    await expect(extension.onStoreDocument(payload)).rejects.toBe(error);
    expect(page.ydoc).toBeNull();
    await extension.onStoreDocument(payload);
    expect(page.ydoc).toEqual(Buffer.from(Y.encodeStateAsUpdate(doc)));
  });

  it.each([
    { kind: 'page', unloadImmediately: true },
    { kind: 'snapshot', unloadImmediately: false },
  ])(
    'keeps the last edit and retries a failed $kind write after the last connection closes',
    async ({ kind, unloadImmediately }) => {
      jest.useFakeTimers();
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const { extension, repo, page } = setup();
      const server = new Hocuspocus({ debounce: 1000, extensions: [extension] });
      try {
        const connection = await server.openDirectConnection(documentName, {
          user: { id: 'editor' },
        });
        await connection.transact((document) => {
          const paragraph = document.getXmlFragment('default').get(0) as Y.XmlElement;
          (paragraph.get(0) as Y.XmlText).insert(0, 'Last edit: ');
        });
        const expected = Buffer.from(Y.encodeStateAsUpdate(connection.document!));
        const error = new Error('Temporary database outage');
        if (kind === 'snapshot') {
          failConversion();
          repo.saveYdocState.mockRejectedValueOnce(error);
        } else {
          repo.updatePage.mockRejectedValueOnce(error);
        }

        await connection.disconnect({ unloadImmediately });
        if (!unloadImmediately) await jest.advanceTimersByTimeAsync(1000);
        expect(page.ydoc).toBeNull();
        expect(server.getDocumentsCount()).toBe(1);

        if (unloadImmediately) {
          await jest.advanceTimersByTimeAsync(1001);
        } else {
          server.flushPendingStores();
          await jest.advanceTimersByTimeAsync(1);
        }
        expect(page.ydoc).toEqual(expected);
        expect(server.getDocumentsCount()).toBe(0);
      } finally {
        for (const document of server.documents.values()) document.destroy();
        jest.useRealTimers();
      }
    },
  );

  it('credits the latest editor when a newer save waits behind a failed write', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { extension, repo } = setup();
    const server = new Hocuspocus({ debounce: 1000, extensions: [extension] });
    const outage = new Error('Temporary database outage');
    let failFirstWrite: (error: Error) => void;
    repo.updatePage
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        failFirstWrite = reject;
      }))
      .mockRejectedValueOnce(outage);
    try {
      for (const id of ['alice', 'bob']) {
        const connection = await server.openDirectConnection(documentName, { user: { id } });
        await connection.transact((document) => {
          const paragraph = document.getXmlFragment('default').get(0) as Y.XmlElement;
          const text = paragraph.get(0) as Y.XmlText;
          text.insert(text.length, ' ' + id);
        });
        await jest.advanceTimersByTimeAsync(1000);
      }
      expect(repo.updatePage).toHaveBeenCalledTimes(1);

      failFirstWrite(outage);
      await jest.advanceTimersByTimeAsync(1001);

      expect(repo.updatePage).toHaveBeenCalledTimes(3);
      expect(repo.updatePage.mock.lastCall[0]).toMatchObject({
        textContent: 'Published alice bob',
        lastUpdatedById: 'bob',
        contributorIds: expect.arrayContaining(['alice', 'bob']),
      });
    } finally {
      for (const document of server.documents.values()) document.destroy();
      jest.useRealTimers();
    }
  });

  it('reports a database failure when saving a repaired document', async () => {
    const { extension, repo } = setup();
    const converter = failConversion();
    await extension.onStoreDocument(payload);
    converter.mockRestore();
    text.delete(0, text.length);
    text.insert(0, 'Published');
    const error = new Error('Database unavailable');
    repo.saveYdocState.mockRejectedValueOnce(error);
    await expect(extension.onStoreDocument(payload)).rejects.toBe(error);
  });
});

describe('block documents', () => {
  const BLOCK = '0193c7a0-1111-7abc-8def-000000000001';
  const NAME = `block.${BLOCK}`;

  function setupBlock() {
    const pageRepo = {
      findById: jest.fn(),
      saveYdocState: jest.fn(),
      updatePage: jest.fn(),
    };
    const stored = new Y.Doc();
    pushElements(stored, [{ id: 'r1', version: 2, type: 'rectangle' }]);
    const liveBlockRepo = {
      findById: jest.fn(async () => ({
        id: BLOCK,
        kind: 'whiteboard',
        pageId: 'page-1',
        workspaceId: 'ws-1',
        ydoc: Buffer.from(Y.encodeStateAsUpdate(stored)),
      })),
      saveYdoc: jest.fn(async () => undefined),
      saveSnapshot: jest.fn(async () => undefined),
    };
    const liveBlockCollab = new LiveBlockCollabService(liveBlockRepo as any);
    const queue = { add: jest.fn() };
    const history = { addContributors: jest.fn() };
    const extension = new PersistenceExtension(
      pageRepo as any,
      { transaction: () => ({ execute: (fn) => fn({}) }) } as any,
      queue as any,
      queue as any,
      queue as any,
      history as any,
      {
        syncPageTransclusions: jest.fn(),
        syncPageReferences: jest.fn(),
      } as any,
      { invalidateForEdit: jest.fn(), notifyInvalidated: jest.fn() } as any,
      { getPageHistoryInterval: () => 300_000 } as any,
      liveBlockCollab,
    );
    return {
      extension,
      pageRepo,
      liveBlockRepo,
      liveBlockCollab,
      queue,
      history,
    };
  }

  const storePayload = (document: Y.Doc, instance: any = new Hocuspocus()) =>
    ({
      document,
      documentName: NAME,
      instance,
      lastContext: { user: { id: 'editor' } },
    }) as any;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('loads a block from live_blocks and never queries pages', async () => {
    const { extension, pageRepo, liveBlockRepo } = setupBlock();
    const document = new Document(NAME);
    const loaded = (await extension.onLoadDocument({
      document,
      documentName: NAME,
    } as onLoadDocumentPayload)) as Y.Doc;
    expect(readElements(loaded)).toEqual([
      { id: 'r1', version: 2, type: 'rectangle' },
    ]);
    expect(liveBlockRepo.findById).toHaveBeenCalledWith(BLOCK, {
      includeYdoc: true,
    });
    expect(pageRepo.findById).not.toHaveBeenCalled();
    document.destroy();
  });

  it('stores the ydoc and then a snapshot built for the block kind', async () => {
    const { extension, pageRepo, liveBlockRepo } = setupBlock();
    const doc = new Y.Doc();
    pushElements(doc, [{ id: 'r9', version: 1, type: 'ellipse' }]);
    await extension.onStoreDocument(storePayload(doc));
    expect(liveBlockRepo.saveYdoc).toHaveBeenCalledWith(
      BLOCK,
      Buffer.from(Y.encodeStateAsUpdate(doc)),
    );
    expect(liveBlockRepo.saveSnapshot).toHaveBeenCalledWith(
      BLOCK,
      {
        kind: 'whiteboard',
        elements: [{ id: 'r9', version: 1, type: 'ellipse' }],
        files: {},
      },
      null,
    );
    expect(pageRepo.findById).not.toHaveBeenCalled();
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  it('the document is saved even when the snapshot builder throws', async () => {
    const { extension, liveBlockRepo, liveBlockCollab } = setupBlock();
    jest.spyOn(liveBlockCollab as any, 'snapshotOf').mockImplementation(() => {
      throw new Error('cannot build');
    });
    await expect(
      extension.onStoreDocument(storePayload(new Y.Doc())),
    ).resolves.toBeUndefined();
    expect(liveBlockRepo.saveYdoc).toHaveBeenCalled();
    expect(liveBlockRepo.saveSnapshot).toHaveBeenCalledWith(
      BLOCK,
      null,
      'cannot build',
    );
  });

  it('does not record page history or contributors for a block', async () => {
    const { extension, queue, history, pageRepo } = setupBlock();
    await extension.onChange({
      documentName: NAME,
      context: { user: { id: 'editor' } },
    } as onChangePayload);
    expect((extension as any).contributors.size).toBe(0);
    expect((extension as any).lastChanges.size).toBe(0);
    await extension.onStoreDocument(storePayload(new Y.Doc()));
    expect(queue.add).not.toHaveBeenCalled();
    expect(history.addContributors).not.toHaveBeenCalled();
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  it('a failed ydoc save re-queues the store and rethrows', async () => {
    const { extension, liveBlockRepo } = setupBlock();
    const error = new Error('db down');
    liveBlockRepo.saveYdoc.mockRejectedValueOnce(error);
    const document = new Y.Doc();
    const instance = {
      documents: new Map([[NAME, document]]),
      debouncer: { isDebounced: jest.fn(() => false) },
      storeDocumentHooks: jest.fn(async () => undefined),
    };
    const payload = storePayload(document, instance);
    await expect(extension.onStoreDocument(payload)).rejects.toBe(error);
    expect(instance.storeDocumentHooks).toHaveBeenCalledWith(document, payload);
    expect(liveBlockRepo.saveSnapshot).not.toHaveBeenCalled();
  });

  it('afterUnloadDocument forgets the block', async () => {
    const { extension, liveBlockCollab } = setupBlock();
    await liveBlockCollab.resolve(BLOCK, 'ws-1');
    expect(liveBlockCollab.pageIdOf(NAME)).toBe('page-1');
    await extension.afterUnloadDocument({ documentName: NAME } as any);
    expect(liveBlockCollab.pageIdOf(NAME)).toBeUndefined();
  });

  it('awareness is still sanitised for a block document', async () => {
    const { extension } = setupBlock();
    const states = new Map<number, any>([
      [
        1,
        {
          user: { id: 'someone-else', name: 'Mallory' },
          pointer: { x: 1, y: 2 },
        },
      ],
      [2, 'junk'],
    ]);
    await extension.beforeHandleAwareness({
      states,
      context: { user: { id: 'editor', avatarUrl: null } },
      documentName: NAME,
    } as any);
    expect(states.get(1).user.id).toBe('editor');
    expect(states.has(2)).toBe(false);
  });
});
