import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  applyOps,
  blockDocumentName,
  LiveBlockInputError,
  LiveBlockKind,
  LiveBlockOp,
} from '@docmost/live-blocks';
import { User } from '@docmost/db/types/entity.types';
import { CollaborationGateway } from '../collaboration.gateway';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { LiveBlockCollabService } from './live-block-collab.service';

export type LiveBlockFlushResult = { flushed: string[]; unreachable: string[] };

function unreachable() {
  return new ServiceUnavailableException('The block could not be reached');
}

/** A refused op is the caller's fault, not a delivery failure. */
function asCallerError(err: unknown): HttpException | null {
  if (err instanceof LiveBlockInputError) {
    return new BadRequestException(err.message);
  }
  if (err instanceof HttpException && err.getStatus() < 500) return err;
  return null;
}

/** The only way the API server touches an open block document. */
@Injectable()
export class LiveBlockSyncBridge {
  private readonly logger = new Logger(LiveBlockSyncBridge.name);

  constructor(
    private readonly collaborationGateway: CollaborationGateway,
    private readonly environmentService: EnvironmentService,
    private readonly liveBlockCollab: LiveBlockCollabService,
  ) {}

  /**
   * False without Redis and with a separate sync server: then no live
   * document can be reached from here, and every server-side write answers 503.
   */
  liveDocumentsReachable(): boolean {
    return (
      !this.environmentService.isCollabDisableRedis() ||
      this.environmentService.isCollabEmbedded()
    );
  }

  async apply(
    blockId: string,
    kind: LiveBlockKind,
    ops: LiveBlockOp[],
    user: User,
  ): Promise<void> {
    const documentName = blockDocumentName(blockId);

    if (this.environmentService.isCollabDisableRedis()) {
      // without Redis only an embedded sync server is reachable; writing to a
      // copy here would be overwritten by the real one
      if (!this.environmentService.isCollabEmbedded()) throw unreachable();
      try {
        await this.direct(documentName, { user }, (doc) =>
          applyOps(kind, doc, ops),
        );
        return;
      } catch (err) {
        const callerError = asCallerError(err);
        if (callerError) throw callerError;
        this.logger.warn(
          `Live block ${blockId} unreachable: ${(err as Error)?.message}`,
        );
        throw unreachable();
      }
    }

    let result: unknown;
    try {
      result = await this.collaborationGateway.handleYjsEvent(
        'applyLiveBlockOps',
        documentName,
        { kind, ops, user },
      );
    } catch (err) {
      const callerError = asCallerError(err);
      if (callerError) throw callerError;
      this.logger.warn(
        `Live block ${blockId} unreachable: ${(err as Error)?.message}`,
      );
      throw unreachable();
    }
    // the gateway answers undefined when no handler ran
    if (result !== true) throw unreachable();
  }

  /** A block that is not open anywhere is in neither list: its stored row is current. */
  async flush(blockIds: string[]): Promise<LiveBlockFlushResult> {
    const result: LiveBlockFlushResult = { flushed: [], unreachable: [] };
    const directOnly = this.environmentService.isCollabDisableRedis();
    if (directOnly && !this.environmentService.isCollabEmbedded()) {
      // the open copies are in a process this one cannot reach
      return { flushed: [], unreachable: [...blockIds] };
    }

    await Promise.all(
      blockIds.map(async (blockId) => {
        const documentName = blockDocumentName(blockId);
        try {
          if (directOnly) {
            // without Redis only this process's sync server can hold it open;
            // a closed block is left alone so its row is not rewritten
            if (!this.liveBlockCollab.isOpen(documentName)) return;
            // a direct connection stores the document when it disconnects
            await this.direct(documentName, {}, () => undefined);
            result.flushed.push(blockId);
            return;
          }
          const answer = await this.collaborationGateway.handleYjsEvent(
            'flushLiveBlock',
            documentName,
            {},
            true,
          );
          if (answer === true) result.flushed.push(blockId);
        } catch (err) {
          this.logger.warn(
            `Live block ${blockId} unreachable: ${(err as Error)?.message}`,
          );
          result.unreachable.push(blockId);
        }
      }),
    );

    const order = new Map(blockIds.map((id, i) => [id, i]));
    result.flushed.sort((a, b) => order.get(a) - order.get(b));
    result.unreachable.sort((a, b) => order.get(a) - order.get(b));
    return result;
  }

  private async direct(
    documentName: string,
    context: object,
    fn: (doc: any) => void,
  ): Promise<void> {
    const connection = await this.collaborationGateway.openDirectConnection(
      documentName,
      context,
    );
    try {
      await connection.transact(fn);
    } finally {
      await connection.disconnect();
    }
  }
}
