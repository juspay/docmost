import { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { WebSocket } from 'ws';
import { CollaborationGateway } from './collaboration.gateway';
import { CollaborationHandler } from './collaboration.handler';
import * as Y from 'yjs';

function makeGateway() {
  const environmentService = {
    getRedisUrl: () => 'redis://localhost:6379',
    isCollabDisableRedis: () => true,
    isCollabEmbedded: () => true,
  };
  const gateway = new CollaborationGateway(
    {} as any,
    {} as any,
    {} as any,
    environmentService as any,
    { getHandlers: () => ({}) } as any,
  );
  const redisSync = {
    onSocketOpen: jest.fn(),
    onSocketMessage: jest.fn(),
    onSocketClose: jest.fn(),
  };
  (gateway as any).redisSync = redisSync;
  return { gateway, redisSync };
}

function makeSocket() {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    close: jest.fn(),
    send: jest.fn(),
  });
}

describe('CollaborationGateway.handleConnection', () => {
  const request = {
    headers: { 'sec-websocket-key': 'key' },
    socket: {},
  } as IncomingMessage;
  afterEach(() => jest.restoreAllMocks());

  it('passes the resolved client ip with the connection', () => {
    const { gateway, redisSync } = makeGateway();
    const request = {
      method: 'GET',
      url: '/collab',
      headers: {
        'sec-websocket-key': 'key',
        'x-forwarded-for': '162.158.1.1',
        'cf-connecting-ip': '198.51.100.20',
      },
      socket: { remoteAddress: '10.42.0.66' },
    } as unknown as IncomingMessage;

    gateway.handleConnection(
      { on: jest.fn() } as unknown as WebSocket,
      request,
    );

    expect(redisSync.onSocketOpen).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ socket: { remoteAddress: '198.51.100.20' } }),
    );
  });

  it.each(['open', 'message'] as const)(
    'closes the affected socket on a relay %s error',
    async (phase) => {
      const { gateway, redisSync } = makeGateway();
      const failure = new Error('Redis unavailable');
      const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      if (phase === 'open') {
        redisSync.onSocketOpen.mockImplementation(() => {
          throw failure;
        });
      } else {
        redisSync.onSocketMessage.mockRejectedValue(failure);
      }
      const socket = makeSocket();
      gateway.handleConnection(socket as unknown as WebSocket, request);
      if (phase === 'message') {
        socket.emit('message', Buffer.alloc(0), true);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(socket.close).toHaveBeenCalledWith(1011);
      expect(logger).toHaveBeenCalledWith(
        expect.objectContaining({ err: failure }),
        expect.any(String),
      );
    },
  );

  it('handles a failed outbound WebSocket write on the originating socket', () => {
    const { gateway, redisSync } = makeGateway();
    const failure = new Error('Socket write failed');
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const socket = makeSocket();
    socket.send.mockImplementation((_message, done) => done(failure));
    gateway.handleConnection(socket as unknown as WebSocket, request);
    const [wrappedSocket] = redisSync.onSocketOpen.mock.calls[0];
    wrappedSocket.send(Uint8Array.of(1));
    expect(socket.close).toHaveBeenCalledWith(1011);
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure }),
      expect.any(String),
    );
  });
});

describe('CollaborationGateway.handleYjsEvent without Redis', () => {
  const user = { id: 'u1', workspaceId: 'w1' };
  const block = {
    type: 'doc',
    content: [{ type: 'todoBoard', attrs: { blockId: 'b1', title: 'Tasks' } }],
  };

  function makeLocalGateway(
    handlers?: Record<string, jest.Mock>,
    embedded = true,
  ) {
    const environmentService = {
      getRedisUrl: () => 'redis://localhost:6379',
      isCollabDisableRedis: () => true,
      isCollabEmbedded: () => embedded,
    };
    const events = handlers
      ? { getHandlers: () => handlers }
      : new CollaborationHandler();
    return new CollaborationGateway(
      {} as any,
      {} as any,
      {} as any,
      environmentService as any,
      events as any,
    );
  }

  it('answers 503 when the sync server is a separate process, and runs no handler', async () => {
    const handler = jest.fn();
    const gateway = makeLocalGateway({ updatePageContent: handler }, false);
    await expect(
      gateway.handleYjsEvent('updatePageContent', 'page.p1', {
        prosemirrorJson: block,
        operation: 'append',
        user,
      } as any),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(handler).not.toHaveBeenCalled();
  });

  it('appends to the local document instead of doing nothing', async () => {
    const gateway = makeLocalGateway();
    const held = await gateway.openDirectConnection('page.p1', { user });
    try {
      await gateway.handleYjsEvent('updatePageContent', 'page.p1', {
        prosemirrorJson: block,
        operation: 'append',
        user,
      } as any);
      const fragment = held.document!.getXmlFragment('default');
      expect(fragment.length).toBe(1);
      expect((fragment.get(0) as Y.XmlElement).nodeName).toBe('todoBoard');
    } finally {
      await held.disconnect();
    }
  });

  it('returns what the handler returns', async () => {
    const flushLiveBlock = jest.fn(async () => true);
    const gateway = makeLocalGateway({ flushLiveBlock });
    await expect(
      gateway.handleYjsEvent('flushLiveBlock', 'block.b1', {}),
    ).resolves.toBe(true);
    expect(flushLiveBlock).toHaveBeenCalledWith('block.b1', {});
  });

  it('with onlyIfOpen, skips a document nobody has open', async () => {
    const flushLiveBlock = jest.fn(async () => true);
    const gateway = makeLocalGateway({ flushLiveBlock });
    await expect(
      gateway.handleYjsEvent('flushLiveBlock', 'block.b1', {}, true),
    ).resolves.toBeUndefined();
    expect(flushLiveBlock).not.toHaveBeenCalled();

    const held = await gateway.openDirectConnection('block.b1');
    try {
      await expect(
        gateway.handleYjsEvent('flushLiveBlock', 'block.b1', {}, true),
      ).resolves.toBe(true);
    } finally {
      await held.disconnect();
    }
  });

  it('a handler error reaches the caller, so a failed append is not a success', async () => {
    const updatePageContent = jest.fn(async () => {
      throw new Error('boom');
    });
    const gateway = makeLocalGateway({ updatePageContent });
    await expect(
      gateway.handleYjsEvent('updatePageContent', 'page.p1', {} as any),
    ).rejects.toThrow('boom');
  });
});

describe('CollaborationGateway without Redis: errors', () => {
  const makeLocal = () =>
    new CollaborationGateway(
      {} as any,
      {} as any,
      {} as any,
      {
        getRedisUrl: () => 'redis://localhost:6379',
        isCollabDisableRedis: () => true,
        isCollabEmbedded: () => true,
      } as any,
      { getHandlers: () => ({}) } as any,
    );

  it('refuses an unknown event like the relay does', async () => {
    await expect(
      makeLocal().handleYjsEvent('noSuchEvent' as any, 'page.p1', {} as any),
    ).rejects.toThrow('Invalid eventName: noSuchEvent');
  });

  it('lockDocument and releaseLock say that they need Redis', async () => {
    const gateway = makeLocal();
    await expect(gateway.lockDocument('page.p1')).rejects.toThrow(
      'Document locks need Redis (COLLAB_DISABLE_REDIS is true)',
    );
    await expect(gateway.releaseLock('page.p1')).rejects.toThrow(
      'Document locks need Redis (COLLAB_DISABLE_REDIS is true)',
    );
  });
});
