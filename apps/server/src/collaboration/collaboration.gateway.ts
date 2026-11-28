import { Hocuspocus } from '@hocuspocus/server';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { AuthenticationExtension } from './extensions/authentication.extension';
import { PersistenceExtension } from './extensions/persistence.extension';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EnvironmentService } from '../integrations/environment/environment.service';
import {
  createRetryStrategy,
  parseRedisUrl,
  RedisConfig,
  resolveClientIp,
} from '../common/helpers';
import { LoggerExtension } from './extensions/logger.extension';
import {
  RedisSyncExtension,
  SerializedHTTPRequest,
} from './extensions/redis-sync';
import { toWebRequest } from './extensions/redis-sync/redis-sync.types';
import { WsSocketWrapper } from './extensions/redis-sync/ws-socket-wrapper';
import RedisClient from 'ioredis';
import { pack, unpack } from 'msgpackr';
import { nanoid } from 'nanoid';
import * as os from 'node:os';
import { CollabWsAdapter } from './adapter/collab-ws.adapter';
import {
  CollaborationHandler,
  CollabEventHandlers,
} from './collaboration.handler';

@Injectable()
export class CollaborationGateway {
  private readonly logger = new Logger(CollaborationGateway.name);
  private readonly hocuspocus: Hocuspocus;
  private redisConfig: RedisConfig;
  // @ts-ignore
  private readonly redisSync: RedisSyncExtension<CollabEventHandlers> | null =
    null;
  private readonly withRedis: boolean;
  private readonly eventHandlers: CollabEventHandlers;

  constructor(
    private authenticationExtension: AuthenticationExtension,
    private persistenceExtension: PersistenceExtension,
    private loggerExtension: LoggerExtension,
    private environmentService: EnvironmentService,
    private collabEventsService: CollaborationHandler,
  ) {
    this.redisConfig = parseRedisUrl(this.environmentService.getRedisUrl());
    this.withRedis = !this.environmentService.isCollabDisableRedis();

    this.hocuspocus = new Hocuspocus({
      debounce: 10000,
      maxDebounce: 45000,
      unloadImmediately: false,
      extensions: [
        this.authenticationExtension,
        this.persistenceExtension,
        this.loggerExtension,
      ],
    });

    this.eventHandlers = this.collabEventsService.getHandlers(this.hocuspocus);

    if (this.withRedis) {
      // @ts-ignore
      this.redisSync = new RedisSyncExtension({
        redis: new RedisClient({
          // The extension connects its publisher and subscriber duplicates.
          lazyConnect: true,
          host: this.redisConfig.host,
          port: this.redisConfig.port,
          username: this.redisConfig.username,
          password: this.redisConfig.password,
          db: this.redisConfig.db,
          family: this.redisConfig.family,
          tls: this.redisConfig.tls,
          retryStrategy: createRetryStrategy(),
        }),
        serverId: `collab-${os?.hostname()}-${nanoid(10)}`,
        prefix: 'collab',
        pack,
        unpack,
        // @ts-ignore
        customEvents: this.eventHandlers,
      });
      this.hocuspocus.configuration.extensions.push(this.redisSync);
      // @ts-ignore
      this.redisSync.onConfigure({ instance: this.hocuspocus });
    }
  }

  private serializeRequest(request: IncomingMessage): SerializedHTTPRequest {
    return {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: {
        'sec-websocket-key': request.headers['sec-websocket-key'] ?? '',
        'sec-websocket-protocol':
          request.headers['sec-websocket-protocol'] ?? '',
      },
      socket: { remoteAddress: resolveClientIp(request) ?? '' },
    };
  }

  private openSocket(socket: WsSocketWrapper, request: SerializedHTTPRequest) {
    const relay = this.redisSync;
    if (relay) {
      const socketId = request.headers['sec-websocket-key'];
      relay.onSocketOpen(socket, request);
      return {
        onMessage: (data: Buffer) => relay.onSocketMessage(request, data),
        onClose: (code: number, reason: Buffer) =>
          relay.onSocketClose(socketId, code, new Uint8Array(reason).buffer),
      };
    }

    const connection = this.hocuspocus.handleConnection(
      socket,
      toWebRequest(request),
    );
    return {
      onMessage: (data: Buffer) =>
        connection.handleMessage(new Uint8Array(data)),
      onClose: (code: number, reason: Buffer) =>
        connection.handleClose({ code, reason: reason.toString() }),
    };
  }

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    const onFailure = (err: unknown) => {
      this.logger.error({ err }, 'Failed to handle collaboration WebSocket');
      if (client.readyState === WebSocket.OPEN) client.close(1011);
    };
    try {
      const connection = this.openSocket(
        new WsSocketWrapper(client, onFailure),
        this.serializeRequest(request),
      );
      client.on('message', async (data: Buffer) => {
        try {
          await connection.onMessage(data);
        } catch (err) {
          onFailure(err);
        }
      });
      client.on('close', (code: number, reason: Buffer) => {
        try {
          connection.onClose(code, reason);
        } catch (err) {
          onFailure(err);
        }
      });
    } catch (err) {
      onFailure(err);
    }
  }

  getConnectionCount() {
    return this.hocuspocus.getConnectionsCount();
  }

  getDocumentCount() {
    return this.hocuspocus.getDocumentsCount();
  }

  handleYjsEvent<TName extends keyof CollabEventHandlers>(
    eventName: TName,
    documentName: string,
    payload: Parameters<CollabEventHandlers[TName]>[1],
    onlyIfOpen = false,
  ) {
    if (this.redisSync) {
      return this.redisSync.handleEvent(
        eventName,
        documentName,
        payload,
        onlyIfOpen,
      );
    }
    return this.handleEventLocally(
      eventName,
      documentName,
      payload,
      onlyIfOpen,
    );
  }

  // Without Redis this process is the only sync server, so its own documents
  // are the live ones; same contract as the relay's handleEvent.
  private async handleEventLocally<TName extends keyof CollabEventHandlers>(
    eventName: TName,
    documentName: string,
    payload: Parameters<CollabEventHandlers[TName]>[1],
    onlyIfOpen: boolean,
  ): Promise<Awaited<ReturnType<CollabEventHandlers[TName]>> | undefined> {
    // the live documents are in a separate sync server this process cannot
    // reach without Redis: refuse rather than edit a copy that gets overwritten
    if (!this.environmentService.isCollabEmbedded()) {
      throw new ServiceUnavailableException(
        'The collaboration server cannot be reached without Redis',
      );
    }
    if (onlyIfOpen && !this.hocuspocus.documents.has(documentName)) return;
    if (!this.eventHandlers[eventName]) {
      throw new Error(`Invalid eventName: ${String(eventName)}`);
    }
    const handler = this.eventHandlers[eventName] as (
      documentName: string,
      payload: unknown,
    ) => Promise<Awaited<ReturnType<CollabEventHandlers[TName]>>>;
    return handler(documentName, payload);
  }

  openDirectConnection(documentName: string, context?: any) {
    return this.hocuspocus.openDirectConnection(documentName, context);
  }

  /*
   *Can be used before calling openDirectConnection directly
   */
  async lockDocument(documentName: string) {
    this.assertRedis();
    return this.redisSync.lockDocument(documentName);
  }

  /*
   *Releases a document lock and stops the interval that maintains it.
   */
  async releaseLock(documentName: string) {
    this.assertRedis();
    return this.redisSync.releaseLock(documentName);
  }

  private assertRedis() {
    if (!this.redisSync) {
      throw new Error(
        'Document locks need Redis (COLLAB_DISABLE_REDIS is true)',
      );
    }
  }

  async destroy(collabWsAdapter: CollabWsAdapter): Promise<void> {
    // eslint-disable-next-line no-async-promise-executor
    await new Promise(async (resolve) => {
      try {
        // Wait for all documents to unload
        this.hocuspocus.configuration.extensions.push({
          async afterUnloadDocument({ instance }) {
            if (instance.getDocumentsCount() === 0) resolve('');
          },
        });

        collabWsAdapter?.close();

        if (this.hocuspocus.getDocumentsCount() === 0) resolve('');
        this.hocuspocus.closeConnections();
        this.hocuspocus.flushPendingStores();
      } catch (error) {
        console.error(error);
      }
    });

    await this.hocuspocus.hooks('onDestroy', { instance: this.hocuspocus });
  }
}
