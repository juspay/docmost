import { Injectable, Logger } from '@nestjs/common';
import * as Y from 'yjs';
import {
  blockDocumentName,
  buildSnapshot,
  LiveBlockKind,
  LiveBlockSnapshot,
  STORE_SNAPSHOT_BUDGET_MS,
  type BuildOptions,
} from '@docmost/live-blocks';
import { LiveBlockRepo } from '@docmost/db/repos/live-block/live-block.repo';
import { LiveBlock } from '@docmost/db/types/entity.types';

/** Loads and stores `block.<id>` documents for the sync server. */
@Injectable()
export class LiveBlockCollabService {
  private readonly logger = new Logger(LiveBlockCollabService.name);
  private readonly known = new Map<
    string,
    { pageId: string; kind: LiveBlockKind }
  >();
  // block documents loaded in this process
  private readonly loaded = new Set<string>();

  constructor(private readonly liveBlockRepo: LiveBlockRepo) {}

  /** Null when the block is missing, soft-deleted, or in another workspace. */
  async resolve(
    blockId: string,
    workspaceId: string,
  ): Promise<LiveBlock | null> {
    const block = await this.liveBlockRepo.findById(blockId);
    if (!block || block.workspaceId !== workspaceId) return null;
    this.remember(block);
    return block;
  }

  async load(blockId: string): Promise<Y.Doc> {
    const doc = new Y.Doc();
    const block = await this.liveBlockRepo.findById(blockId, {
      includeYdoc: true,
    });
    if (block) {
      this.remember(block);
      if (block.ydoc) Y.applyUpdate(doc, new Uint8Array(block.ydoc));
    }
    // only once the load can no longer fail
    this.loaded.add(blockDocumentName(blockId));
    return doc;
  }

  /** Saves the document; a snapshot that cannot be built never stops that save. */
  async store(blockId: string, document: Y.Doc): Promise<void> {
    await this.liveBlockRepo.saveYdoc(
      blockId,
      Buffer.from(Y.encodeStateAsUpdate(document)),
    );

    try {
      const kind = await this.kindOf(blockId);
      const snapshot = this.snapshotOf(kind, document, {
        budgetMs: STORE_SNAPSHOT_BUDGET_MS,
      });
      await this.liveBlockRepo.saveSnapshot(blockId, snapshot, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Snapshot of live block ${blockId} failed: ${message}`);
      try {
        await this.liveBlockRepo.saveSnapshot(blockId, null, message);
      } catch (saveErr) {
        this.logger.warn(
          `Could not record the snapshot error of live block ${blockId}`,
          saveErr,
        );
      }
    }
  }

  pageIdOf(documentName: string): string | undefined {
    return this.known.get(documentName)?.pageId;
  }

  forget(documentName: string): void {
    this.known.delete(documentName);
    this.loaded.delete(documentName);
  }

  /** Whether the block document is loaded by the sync server in this process. */
  isOpen(documentName: string): boolean {
    return this.loaded.has(documentName);
  }

  protected snapshotOf(
    kind: LiveBlockKind,
    doc: Y.Doc,
    options?: BuildOptions,
  ): LiveBlockSnapshot {
    return buildSnapshot(kind, doc, options);
  }

  private async kindOf(blockId: string): Promise<LiveBlockKind> {
    const cached = this.known.get(blockDocumentName(blockId))?.kind;
    if (cached) return cached;
    const block = await this.liveBlockRepo.findById(blockId);
    if (!block) throw new Error('The block no longer exists');
    this.remember(block);
    return block.kind as LiveBlockKind;
  }

  private remember(block: LiveBlock) {
    this.known.set(blockDocumentName(block.id), {
      pageId: block.pageId,
      kind: block.kind as LiveBlockKind,
    });
  }
}
