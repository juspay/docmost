import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import {
  isRegisteredKind,
  LiveBlockInputError,
  registerKind,
} from '@docmost/live-blocks';
import { LiveBlockSyncBridge } from './live-block-sync.bridge';
import { LiveBlockCollabService } from './live-block-collab.service';
import { CollaborationHandler } from '../collaboration.handler';

const A = '0193c7a0-1111-7abc-8def-00000000000a';
const B = '0193c7a0-1111-7abc-8def-00000000000b';
const user = { id: 'user-1' } as any;

// a test-only kind, so no real kind's definition is touched
const OP_KIND = 'test-op-kind' as any;
if (!isRegisteredKind(OP_KIND)) {
  registerKind({
    kind: OP_KIND,
    // a kind outside the snapshot union, so its snapshots are untyped
    empty: () => ({ kind: OP_KIND }) as any,
    build: () => ({ kind: OP_KIND }) as any,
    seed: () => undefined,
    validate: () => ({ kind: OP_KIND }) as any,
    staticNodes: () => [],
    applyOp: (doc: Y.Doc, op: any) => {
      if (op.type === 'bad') throw new LiveBlockInputError('bad op');
      doc.getMap('test').set(op.type, true);
    },
  });
}

/** A gateway that answers the way the Redis sync extension does for one server. */
function gatewayOver(hocuspocus: Hocuspocus) {
  const handlers = new CollaborationHandler().getHandlers(hocuspocus);
  return {
    handleYjsEvent: jest.fn(
      async (event: string, name: string, payload: any, onlyIfOpen = false) => {
        if (onlyIfOpen && !hocuspocus.documents.has(name)) return undefined;
        return handlers[event](name, payload);
      },
    ),
    openDirectConnection: (name: string, context?: any) =>
      hocuspocus.openDirectConnection(name, context),
  };
}

function makeBridge(
  gateway: any,
  opts: { redisDisabled?: boolean; collab?: any; separate?: boolean } = {},
) {
  const env = {
    isCollabDisableRedis: () => opts.redisDisabled ?? false,
    isCollabEmbedded: () => !opts.separate,
  };
  const collab = opts.collab ?? { isOpen: () => false };
  return new LiveBlockSyncBridge(gateway, env as any, collab);
}

describe('LiveBlockSyncBridge.liveDocumentsReachable', () => {
  it('is false only without Redis and with a separate sync server', () => {
    const g = {} as any;
    expect(makeBridge(g).liveDocumentsReachable()).toBe(true);
    expect(makeBridge(g, { separate: true }).liveDocumentsReachable()).toBe(
      true,
    );
    expect(
      makeBridge(g, { redisDisabled: true }).liveDocumentsReachable(),
    ).toBe(true);
    expect(
      makeBridge(g, {
        redisDisabled: true,
        separate: true,
      }).liveDocumentsReachable(),
    ).toBe(false);
  });
});

describe('LiveBlockSyncBridge without Redis and a separate sync server', () => {
  it('apply answers 503 and never touches a document of its own', async () => {
    const gateway = {
      openDirectConnection: jest.fn(),
      handleYjsEvent: jest.fn(),
    };
    const bridge = makeBridge(gateway, { redisDisabled: true, separate: true });
    await expect(
      bridge.apply(A, OP_KIND, [{ type: 'one' } as any], user),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(gateway.openDirectConnection).not.toHaveBeenCalled();
    expect(gateway.handleYjsEvent).not.toHaveBeenCalled();
  });

  it('flush reports every block unreachable, so readers answer 503 instead of serving a stale row', async () => {
    const gateway = {
      openDirectConnection: jest.fn(),
      handleYjsEvent: jest.fn(),
    };
    const bridge = makeBridge(gateway, {
      redisDisabled: true,
      separate: true,
      collab: { isOpen: () => true },
    });
    expect(await bridge.flush([A, B])).toEqual({
      flushed: [],
      unreachable: [A, B],
    });
    expect(gateway.openDirectConnection).not.toHaveBeenCalled();
  });

  it('with the sync server in this process the direct path still works', async () => {
    const hocuspocus = new Hocuspocus({ debounce: 10, extensions: [] });
    const bridge = makeBridge(gatewayOver(hocuspocus), {
      redisDisabled: true,
      separate: false,
    });
    await expect(
      bridge.apply(A, OP_KIND, [{ type: 'one' } as any], user),
    ).resolves.toBeUndefined();
  });
});

describe('collaboration handler for live blocks', () => {
  it('applyLiveBlockOps applies the ops to the live document and returns true', async () => {
    const hocuspocus = new Hocuspocus({ debounce: 10, extensions: [] });
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);
    const name = `block.${A}`;
    const watcher = await hocuspocus.openDirectConnection(name, {});
    try {
      const result = await handlers.applyLiveBlockOps(name, {
        kind: OP_KIND,
        ops: [{ type: 'one' }, { type: 'two' }],
        user,
      });
      expect(result).toBe(true);
      expect(watcher.document.getMap('test').toJSON()).toEqual({
        one: true,
        two: true,
      });
    } finally {
      await watcher.disconnect();
    }
  });

  it('applyLiveBlockOps answers a refused op with 400', async () => {
    const hocuspocus = new Hocuspocus({ extensions: [] });
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);
    await expect(
      handlers.applyLiveBlockOps(`block.${A}`, {
        kind: OP_KIND,
        ops: [{ type: 'bad' }],
        user,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('both live block handlers refuse a page document', async () => {
    const hocuspocus = new Hocuspocus({ extensions: [] });
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);
    await expect(
      handlers.applyLiveBlockOps('page.x', { kind: OP_KIND, ops: [], user }),
    ).rejects.toThrow();
    await expect(handlers.flushLiveBlock('page.x', {})).rejects.toThrow();
  });
});

describe('LiveBlockSyncBridge', () => {
  it('bridge.apply sends the ops to the open block document', async () => {
    const hocuspocus = new Hocuspocus({ extensions: [] });
    const watcher = await hocuspocus.openDirectConnection(`block.${A}`, {});
    try {
      const bridge = makeBridge(gatewayOver(hocuspocus));
      await bridge.apply(A.toUpperCase(), OP_KIND, [{ type: 'x' }], user);
      expect(watcher.document.getMap('test').get('x')).toBe(true);
    } finally {
      await watcher.disconnect();
    }
  });

  it('bridge.apply throws ServiceUnavailable when the event is not delivered', async () => {
    for (const handleYjsEvent of [
      jest.fn(async () => undefined),
      jest.fn(async () => {
        throw new Error('TIMEOUT');
      }),
    ]) {
      const bridge = makeBridge({ handleYjsEvent });
      await expect(bridge.apply(A, OP_KIND, [], user)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    }
  });

  it('a bad op is a 400 on the gateway path, locally and from another server', async () => {
    const hocuspocus = new Hocuspocus({ extensions: [] });
    const local = makeBridge(gatewayOver(hocuspocus));
    await expect(
      local.apply(A, OP_KIND, [{ type: 'bad' }], user),
    ).rejects.toBeInstanceOf(BadRequestException);
    // the Redis relay rebuilds an HttpException from the owner's reply
    const remote = makeBridge({
      handleYjsEvent: jest.fn(async () => {
        throw new BadRequestException('bad op');
      }),
    });
    await expect(
      remote.apply(A, OP_KIND, [{ type: 'bad' }], user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('bridge.flush reports an open block as flushed and a closed one as neither', async () => {
    const stored: string[] = [];
    const hocuspocus = new Hocuspocus({
      debounce: 60_000,
      extensions: [
        {
          onStoreDocument: async ({ documentName }) =>
            void stored.push(documentName),
        },
      ],
    });
    const open = await hocuspocus.openDirectConnection(`block.${A}`, {});
    try {
      await open.transact((doc) => doc.getMap('test').set('pending', true));
      stored.length = 0;
      const bridge = makeBridge(gatewayOver(hocuspocus));
      expect(await bridge.flush([A, B])).toEqual({
        flushed: [A],
        unreachable: [],
      });
      // the pending store of the open block ran; the closed block was not loaded
      expect(stored).toEqual([`block.${A}`]);
      expect(hocuspocus.documents.has(`block.${B}`)).toBe(false);
    } finally {
      await open.disconnect();
    }
  });

  it('bridge.flush reports a block whose owner does not answer as unreachable', async () => {
    const bridge = makeBridge({
      handleYjsEvent: jest.fn(async () => {
        throw new Error('TIMEOUT');
      }),
    });
    expect(await bridge.flush([A])).toEqual({ flushed: [], unreachable: [A] });
  });

  describe('with Redis sync off', () => {
    function setup() {
      const rows: Record<string, Buffer> = {};
      const repo = {
        findById: jest.fn(async (id: string) => ({
          id,
          kind: OP_KIND,
          pageId: 'p',
          workspaceId: 'w',
          ydoc: rows[id] ?? null,
        })),
        saveYdoc: jest.fn(
          async (id: string, ydoc: Buffer) => void (rows[id] = ydoc),
        ),
        saveSnapshot: jest.fn(async () => undefined),
      };
      const collab = new LiveBlockCollabService(repo as any);
      const parse = (name: string) => name.slice('block.'.length);
      const hocuspocus = new Hocuspocus({
        debounce: 60_000,
        extensions: [
          {
            onLoadDocument: async ({ documentName }) =>
              collab.load(parse(documentName)),
            onStoreDocument: async ({ documentName, document }) =>
              collab.store(parse(documentName), document),
            afterUnloadDocument: async ({ documentName }) =>
              collab.forget(documentName),
          },
        ],
      });
      const gateway = {
        handleYjsEvent: jest.fn(),
        openDirectConnection: (name: string, context?: any) =>
          hocuspocus.openDirectConnection(name, context),
      };
      const bridge = makeBridge(gateway, { redisDisabled: true, collab });
      return { bridge, gateway, repo, hocuspocus };
    }

    it('the bridge uses a direct connection', async () => {
      const { bridge, gateway, repo } = setup();
      await bridge.apply(A, OP_KIND, [{ type: 'x' }], user);
      expect(gateway.handleYjsEvent).not.toHaveBeenCalled();
      const saved = new Y.Doc();
      Y.applyUpdate(
        saved,
        new Uint8Array(
          repo.saveYdoc.mock.calls[repo.saveYdoc.mock.calls.length - 1][1],
        ),
      );
      expect(saved.getMap('test').get('x')).toBe(true);
    });

    it('a bad op is a 400 on the direct path', async () => {
      const { bridge } = setup();
      await expect(
        bridge.apply(A, OP_KIND, [{ type: 'bad' }], user),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('flush stores an open block and leaves a closed one untouched', async () => {
      const { bridge, repo, hocuspocus } = setup();
      const open = await hocuspocus.openDirectConnection(`block.${A}`, {});
      try {
        await open.transact((doc) => doc.getMap('test').set('pending', true));
        repo.saveYdoc.mockClear();
        expect(await bridge.flush([A, B])).toEqual({
          flushed: [A],
          unreachable: [],
        });
        expect(repo.saveYdoc.mock.calls.map((c) => c[0])).toEqual([A]);
        expect(repo.findById).not.toHaveBeenCalledWith(B, expect.anything());
      } finally {
        await open.disconnect();
      }
    });

    it('a failed direct connection is a 503 and unreachable', async () => {
      const { bridge, hocuspocus } = setup();
      const open = await hocuspocus.openDirectConnection(`block.${A}`, {});
      jest
        .spyOn(hocuspocus, 'openDirectConnection')
        .mockRejectedValue(new Error('no'));
      try {
        await expect(bridge.apply(A, OP_KIND, [], user)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(await bridge.flush([A])).toEqual({
          flushed: [],
          unreachable: [A],
        });
      } finally {
        await open.disconnect();
      }
    });
  });
});
