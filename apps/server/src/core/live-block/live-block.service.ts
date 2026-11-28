import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectKysely } from 'nestjs-kysely';
import * as Y from 'yjs';
import { v7 as uuid7 } from 'uuid';
import {
  buildSnapshot,
  emptySnapshot,
  isRegisteredKind,
  kindDefinition,
  LiveBlockInputError,
  LiveBlockKind,
  LiveBlockOp,
  LiveBlockSnapshot,
  SNAPSHOT_BUDGET_MS,
  seedYdoc,
  validateSnapshotInput,
  WhiteboardSnapshot,
} from '@docmost/live-blocks';
import { LiveBlockRepo } from '@docmost/db/repos/live-block/live-block.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { Json } from '@docmost/db/types/db';
import { LiveBlock, Page, User } from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx, executeTx } from '@docmost/db/utils';
import { PageAccessService } from '../page/page-access/page-access.service';
import { LiveBlockSyncBridge } from '../../collaboration/live-block/live-block-sync.bridge';
import { StorageService } from '../../integrations/storage/storage.service';
import { copyAttachment } from '../attachment/attachment-copy.util';
import {
  findLiveBlocks,
  LIVE_BLOCK_NODE_KIND,
  pageContainsBlock,
} from './page-content.util';
import {
  WhiteboardFileInput,
  WhiteboardFilesService,
} from './whiteboard-files.service';
import type { PageService } from '../page/services/page.service';
import { inlineLiveBlocks } from './live-block-export.util';

export type PageCopyPlan = {
  /** old block id → new block id, for every block in the copied content */
  blockIdMap: Map<string, string>;
  /** stored rows to copy, with their documents */
  sources: LiveBlock[];
  /** files copied so far, removed again if the copy is not committed */
  copiedPaths: string[];
};

export type LiveBlockSnapshotResponse = {
  kind: LiveBlockKind;
  snapshot: LiveBlockSnapshot;
  /** true when the last store could not rebuild it: it may be older than the block */
  snapshotStale: boolean;
  updatedAt: Date;
};

export type CreateOnPageArgs = {
  kind: LiveBlockKind;
  title: string;
  user: User;
  target: { spaceId: string; parentPageId?: string } | { pageId: string };
  /** Untrusted; goes through validateSnapshotInput. */
  input?: unknown;
  /** Whiteboard images as data URLs, keyed by Excalidraw file id. */
  files?: Record<string, WhiteboardFileInput>;
  /** The workspace's base URL, for the returned page url. */
  baseUrl: string;
};

export type CreateOnPageResult = {
  pageId: string;
  slugId: string;
  blockId: string;
  url: string;
  /** true when a new page was made for the block */
  createdPage: boolean;
  skippedFiles: { fileId: string; reason: string }[];
};

const NODE_TYPE_OF_KIND = Object.fromEntries(
  Object.entries(LIVE_BLOCK_NODE_KIND).map(([node, kind]) => [kind, node]),
) as Record<LiveBlockKind, string>;

const SOURCE_NOT_FOUND = 'The original block was not found';
const BLOCK_NOT_FOUND = 'Block not found';
const REBUILD_FLOOR_MS = 30_000;
const MAX_REMEMBERED_REBUILDS = 1000;

function blockIdTaken() {
  return new ConflictException({
    code: 'BLOCK_ID_TAKEN',
    message: 'This block id belongs to another page',
  });
}

@Injectable()
export class LiveBlockService {
  private readonly logger = new Logger(LiveBlockService.name);
  // one rebuild per block at a time in this process
  private readonly rebuilds = new Map<string, Promise<LiveBlockSnapshot>>();
  // block id → the last rebuild here: what it gave (null when it failed),
  // for which stored document, and when
  private readonly lastRebuild = new Map<
    string,
    { updatedAt: number; snapshot: LiveBlockSnapshot | null; at: number }
  >();

  constructor(
    private readonly liveBlockRepo: LiveBlockRepo,
    private readonly pageRepo: PageRepo,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly liveBlockSyncBridge: LiveBlockSyncBridge,
    private readonly storageService: StorageService,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly whiteboardFiles: WhiteboardFilesService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // PageService injects this service, so it is looked up when needed instead
  // of injected. Required lazily too: a top-level import makes a module cycle
  // that leaves PageService's constructor metadata undefined.
  private pageService(): PageService {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PageService } = require('../page/services/page.service');
    return this.moduleRef.get(PageService, { strict: false });
  }

  /**
   * Creates a block holding `input` on a new page or at the end of an existing
   * one. The page comes first, because an attachment belongs to a page.
   */
  async createOnPage(args: CreateOnPageArgs): Promise<CreateOnPageResult> {
    const { kind, title, user, target } = args;

    // authorise before anything else, so a refusal says nothing about the input
    let existing: Page | null = null;
    let parentPageId: string | undefined;
    if ('pageId' in target) {
      existing = await this.editablePage(target.pageId, user);
    } else {
      await this.pageAccessService.validateCanCreate(target.spaceId, user);
      if (target.parentPageId) {
        const parent = await this.editablePage(target.parentPageId, user);
        if (parent.spaceId !== target.spaceId) {
          throw new NotFoundException('Page not found');
        }
        parentPageId = parent.id;
      }
    }

    if (!isRegisteredKind(kind)) {
      throw new LiveBlockInputError(`Unknown live block kind: ${kind}`);
    }
    if (kind !== 'whiteboard' && Object.keys(args.files ?? {}).length > 0) {
      throw new LiveBlockInputError('Only a whiteboard takes files');
    }
    let snapshot =
      args.input === undefined
        ? emptySnapshot(kind)
        : validateSnapshotInput(kind, args.input);

    // the block is put on its page through the sync server; when that cannot
    // be reached, fail now rather than leave a new page behind in the trash
    if (!this.liveBlockSyncBridge.liveDocumentsReachable()) {
      throw new ServiceUnavailableException(
        'The collaboration server cannot be reached without Redis',
      );
    }

    const blockId = uuid7();
    const node = { type: NODE_TYPE_OF_KIND[kind], attrs: { blockId, title } };

    // A new page starts empty. The node goes in last, on both paths, so the
    // block id is in no page until its seed is stored and no client can open
    // it (and later save it) empty.
    const page: Pick<Page, 'id' | 'slugId' | 'spaceId' | 'workspaceId'> =
      existing ??
      (await this.pageService().create(user.id, user.workspaceId, {
        spaceId: 'spaceId' in target ? target.spaceId : undefined,
        title,
        parentPageId,
        content: { type: 'doc', content: [] },
        format: 'json',
      }));

    let skippedFiles: CreateOnPageResult['skippedFiles'] = [];
    // set once the row is known to be ours; a row of another page is left alone
    let rowInserted = false;
    try {
      if (kind === 'whiteboard' && args.files) {
        const stored = await this.whiteboardFiles.store(
          args.files,
          page,
          user.id,
        );
        skippedFiles = stored.skipped;
        const board = snapshot as WhiteboardSnapshot;
        snapshot = { ...board, files: { ...board.files, ...stored.refs } };
      }

      const row = await this.liveBlockRepo.insertIfAbsent({
        id: blockId,
        kind,
        pageId: page.id,
        workspaceId: page.workspaceId,
        creatorId: user.id,
      });
      if (!row || row.pageId !== page.id || row.deletedAt) throw blockIdTaken();
      if (row.kind !== kind) {
        throw new ConflictException({
          code: 'KIND_MISMATCH',
          message: 'This block id belongs to a block of another kind',
        });
      }
      rowInserted = true;

      const doc = seedYdoc(snapshot);
      const seeded = await this.liveBlockRepo.seedIfEmpty(
        blockId,
        Buffer.from(Y.encodeStateAsUpdate(doc)),
        snapshot,
      );
      if (!seeded) {
        this.logger.warn(
          `Live block ${blockId} already had a document; its seed was not written`,
        );
      }

      // through the sync server, so open editors see the block appear
      await this.pageService().updatePageContent(
        page.id,
        { type: 'doc', content: [node] },
        'append',
        'json',
        user,
      );
    } catch (err) {
      // no node points at the row, and a page made for the block is empty
      if (rowInserted) {
        await this.liveBlockRepo
          .softDelete(blockId)
          .catch((deleteErr) =>
            this.logger.error(
              `Could not remove live block ${blockId} after a failed create`,
              deleteErr,
            ),
          );
      }
      if (!existing) {
        await this.pageRepo
          .removePage(page.id, user.id, page.workspaceId)
          .catch((deleteErr) =>
            this.logger.error(
              `Could not trash page ${page.id} after a failed block create`,
              deleteErr,
            ),
          );
      }
      throw err;
    }

    return {
      pageId: page.id,
      slugId: page.slugId,
      blockId,
      url: `${args.baseUrl}/p/${page.slugId}`,
      createdPage: !existing,
      skippedFiles,
    };
  }

  /**
   * Stores an open document first, then returns the stored snapshot. The
   * caller has already loaded and authorised the block: pass that row's id.
   */
  async readFresh(blockId: string): Promise<LiveBlockSnapshot> {
    const { unreachable } = await this.liveBlockSyncBridge.flush([blockId]);
    if (unreachable.length > 0) {
      throw new ServiceUnavailableException(
        'The block could not be reached. Try again.',
      );
    }
    const row = await this.liveBlockRepo.findById(blockId, {
      includeSnapshot: true,
    });
    if (!row) throw new NotFoundException(BLOCK_NOT_FOUND);
    return this.currentSnapshotOrUnavailable(row);
  }

  /**
   * The stored snapshot, or one rebuilt from the stored document with the
   * full budget when the store path's build failed or was cut short.
   */
  private async currentSnapshot(row: LiveBlock): Promise<LiveBlockSnapshot> {
    const kind = row.kind as LiveBlockKind;
    const stored = (row.snapshot as LiveBlockSnapshot | null) ?? null;
    if (!this.needsRebuild(row)) return stored ?? emptySnapshot(kind);

    // A rebuild costs up to SNAPSHOT_BUDGET_MS of this event loop and an
    // anonymous share read can ask for one: reuse the last one for the same
    // document (its save may have matched no row), and never rebuild a block
    // more than once per REBUILD_FLOOR_MS.
    const last = this.lastRebuild.get(row.id);
    if (
      last &&
      (last.updatedAt === row.updatedAt?.getTime() ||
        Date.now() - last.at < REBUILD_FLOOR_MS)
    ) {
      if (!last.snapshot) throw new Error('The last rebuild failed');
      return last.snapshot;
    }

    let pending = this.rebuilds.get(row.id);
    if (!pending) {
      pending = this.rebuild(row.id).finally(() =>
        this.rebuilds.delete(row.id),
      );
      this.rebuilds.set(row.id, pending);
    }
    return pending;
  }

  private needsRebuild(row: LiveBlock): boolean {
    if (row.snapshotError) return true;
    return !!(row.snapshot as { truncated?: boolean } | null)?.truncated;
  }

  private rememberRebuild(
    blockId: string,
    updatedAt: Date | undefined,
    snapshot: LiveBlockSnapshot | null,
  ) {
    this.lastRebuild.delete(blockId);
    this.lastRebuild.set(blockId, {
      updatedAt: updatedAt?.getTime(),
      snapshot,
      at: Date.now(),
    });
    // bounded: the oldest entry goes first
    if (this.lastRebuild.size > MAX_REMEMBERED_REBUILDS) {
      this.lastRebuild.delete(this.lastRebuild.keys().next().value);
    }
  }

  private async rebuild(blockId: string): Promise<LiveBlockSnapshot> {
    const row = await this.liveBlockRepo.findById(blockId, {
      includeYdoc: true,
      includeSnapshot: true,
    });
    if (!row) throw new NotFoundException(BLOCK_NOT_FOUND);
    const kind = row.kind as LiveBlockKind;
    if (!row.ydoc) {
      if (row.snapshotError) throw new Error('No stored document to rebuild');
      return (row.snapshot as LiveBlockSnapshot) ?? emptySnapshot(kind);
    }
    let snapshot: LiveBlockSnapshot;
    try {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(row.ydoc));
      snapshot = buildSnapshot(kind, doc, { budgetMs: SNAPSHOT_BUDGET_MS });
    } catch (err) {
      this.rememberRebuild(blockId, row.updatedAt, null);
      throw err;
    }
    this.rememberRebuild(blockId, row.updatedAt, snapshot);
    // a store that landed meanwhile has a newer snapshot; keep that one
    await this.liveBlockRepo.saveRebuiltSnapshot(
      blockId,
      snapshot,
      row.updatedAt,
    );
    return snapshot;
  }

  private async currentSnapshotOrUnavailable(
    row: LiveBlock,
  ): Promise<LiveBlockSnapshot> {
    try {
      return await this.currentSnapshot(row);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      this.logger.warn(
        `Live block ${row.id} snapshot rebuild failed: ${err?.['message']}`,
      );
      throw new ServiceUnavailableException(
        'The block could not be read just now. Try again.',
      );
    }
  }

  /** Makes sure an empty block exists. Never copies anything. */
  async ensure(
    dto: { blockId: string; pageId: string; kind: LiveBlockKind },
    user: User,
  ): Promise<{ blockId: string }> {
    const page = await this.editablePage(dto.pageId, user);
    if (!isRegisteredKind(dto.kind)) {
      throw new BadRequestException('Unknown block kind');
    }

    const row = await this.liveBlockRepo.insertIfAbsent({
      id: dto.blockId,
      kind: dto.kind,
      pageId: page.id,
      workspaceId: page.workspaceId,
      creatorId: user.id,
    });

    // the same answer whether or not the caller can see the other page;
    // a soft-deleted row keeps its id
    if (!row || row.pageId !== page.id || row.deletedAt) throw blockIdTaken();
    if (row.kind !== dto.kind) {
      throw new ConflictException({
        code: 'KIND_MISMATCH',
        message: 'This block id belongs to a block of another kind',
      });
    }
    return { blockId: row.id };
  }

  /** Copies a block now, as the caller. */
  async clone(
    dto: { sourceBlockId: string; blockId: string; pageId: string },
    user: User,
  ): Promise<{ blockId: string }> {
    const page = await this.editablePage(dto.pageId, user);

    const source = await this.liveBlockRepo.findById(dto.sourceBlockId);
    if (!source || source.workspaceId !== user.workspaceId) {
      throw new NotFoundException(SOURCE_NOT_FOUND);
    }
    // Not checked against the source page's content: a cut block is gone
    // from it, or not stored in it yet, and a paste must still copy it (R53).
    const sourcePage = await this.pageRepo.findById(source.pageId);
    if (!sourcePage || sourcePage.workspaceId !== user.workspaceId) {
      throw new NotFoundException(SOURCE_NOT_FOUND);
    }
    try {
      await this.pageAccessService.validateCanView(sourcePage, user);
    } catch {
      throw new NotFoundException(SOURCE_NOT_FOUND);
    }

    // only this workspace's ids are visible; a clash elsewhere fails later,
    // at the insert, with the same answer
    if (
      await this.liveBlockRepo.findById(dto.blockId, {
        workspaceId: user.workspaceId,
      })
    )
      throw blockIdTaken();

    // copying stale data silently is worse than failing; the id is the
    // authorised row's own, not the caller's text
    const { unreachable } = await this.liveBlockSyncBridge.flush([source.id]);
    if (unreachable.length > 0) {
      throw new ServiceUnavailableException(
        'The original block could not be reached. Try again.',
      );
    }

    const fresh = await this.liveBlockRepo.findById(source.id, {
      includeYdoc: true,
      includeSnapshot: true,
    });
    if (!fresh) throw new NotFoundException(SOURCE_NOT_FOUND);

    const copiedPaths: string[] = [];
    try {
      await executeTx(this.db, (trx) =>
        this.copyBlock(
          fresh,
          { blockId: dto.blockId, page, creatorId: user.id },
          trx,
          copiedPaths,
        ),
      );
    } catch (err) {
      // the attachment rows rolled back; their files must go too
      await this.removeFiles(copiedPaths);
      throw err;
    }
    return { blockId: dto.blockId };
  }

  /** The caller has already authorised the page. */
  async getSnapshot(
    blockId: string,
    page: Page,
  ): Promise<LiveBlockSnapshotResponse> {
    const row = await this.liveBlockRepo.findById(blockId, {
      includeSnapshot: true,
    });
    if (
      !row ||
      row.pageId !== page.id ||
      !pageContainsBlock(page.content, blockId)
    ) {
      throw new NotFoundException(BLOCK_NOT_FOUND);
    }
    const kind = row.kind as LiveBlockKind;
    return {
      kind,
      snapshot: await this.currentSnapshotOrUnavailable(row),
      // a snapshot that could not be rebuilt answers 503 instead
      snapshotStale: false,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Copies the document and snapshot to a new row of the target page. For a
   * kind with attachments, each one owned by the source page is copied to the
   * target page and its id rewritten in the copy.
   */
  /**
   * The caller removes `copiedPaths` if the copy fails or is not committed.
   */
  async copyBlock(
    source: LiveBlock,
    target: { blockId: string; page: Page; creatorId?: string },
    trx?: KyselyTransaction,
    copiedPaths: string[] = [],
  ): Promise<void> {
    const kind = source.kind as LiveBlockKind;
    const creatorId = target.creatorId ?? source.creatorId ?? null;
    let ydoc: Buffer | null = source.ydoc ?? null;
    let snapshot = (source.snapshot as unknown) ?? null;
    // a stale snapshot stays marked stale in the copy
    let snapshotError = source.snapshotError ?? null;

    const def = isRegisteredKind(kind) ? kindDefinition(kind) : null;
    const map = new Map<string, string>();
    if (ydoc && def?.attachmentIds && def.remapAttachments) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(ydoc));
      const ids = [...new Set(def.attachmentIds(doc))];
      const attachments = (
        await this.attachmentRepo.findByIds(ids, { trx })
      ).filter(
        (a) =>
          a.workspaceId === source.workspaceId &&
          a.pageId === source.pageId &&
          !a.deletedAt,
      );

      for (const attachment of attachments) {
        const attachmentId = uuid7();
        try {
          await copyAttachment(
            this.storageService,
            dbOrTx(this.db, trx),
            attachment,
            {
              attachmentId,
              pageId: target.page.id,
              spaceId: target.page.spaceId,
              creatorId,
            },
            (path) => copiedPaths.push(path),
          );
          map.set(attachment.id, attachmentId);
        } catch (err) {
          // one unreadable file must not fail the whole copy; the copy keeps the old id
          this.logger.error(
            `Live block copy: failed to copy attachment ${attachment.id}`,
            err,
          );
        }
      }

      if (map.size > 0) {
        def.remapAttachments(doc, map);
        ydoc = Buffer.from(Y.encodeStateAsUpdate(doc));
        snapshot = buildSnapshot(kind, doc);
        snapshotError = null;
      }
    }

    // the row must be new: a racing copy onto the same id, or an id of another
    // workspace, loses here and leaves no files behind
    const inserted = await this.liveBlockRepo.insertNew(
      {
        id: target.blockId,
        kind,
        pageId: target.page.id,
        workspaceId: target.page.workspaceId,
        creatorId,
        ydoc,
        snapshot: snapshot as Json,
        snapshotError,
      },
      trx,
    );
    if (!inserted) throw blockIdTaken();
  }

  /** Removes the files a page duplication copied when it is not committed. */
  async removeCopiedFiles(plan: PageCopyPlan): Promise<void> {
    await this.removeFiles(plan.copiedPaths ?? []);
    plan.copiedPaths = [];
  }

  private async removeFiles(paths: string[]): Promise<void> {
    await Promise.all(
      paths.map((path) =>
        this.storageService
          .delete(path)
          .catch((err) =>
            this.logger.warn(
              `Could not remove copied file ${path}: ${err?.['message']}`,
            ),
          ),
      ),
    );
  }

  /**
   * Plans copies of the blocks in the pages' current content (never rows left
   * over from deleted blocks). Flushes open ones first; 503 if one is unreachable.
   */
  async planPageCopies(
    pages: { id: string; content: unknown }[],
  ): Promise<PageCopyPlan> {
    const pageOf = new Map<string, string>();
    for (const page of pages) {
      for (const block of findLiveBlocks(page.content)) {
        pageOf.set(block.blockId, page.id);
      }
    }
    const blockIdMap = new Map(
      [...pageOf.keys()].map((id) => [id, uuid7()] as const),
    );
    if (blockIdMap.size === 0)
      return { blockIdMap, sources: [], copiedPaths: [] };

    const pageIds = pages.map((p) => p.id);
    const stored = (await this.liveBlockRepo.findByPageIds(pageIds)).filter(
      (row) => pageOf.get(row.id) === row.pageId,
    );
    if (stored.length === 0)
      return { blockIdMap, sources: [], copiedPaths: [] };

    const { unreachable } = await this.liveBlockSyncBridge.flush(
      stored.map((row) => row.id),
    );
    if (unreachable.length > 0) {
      throw new ServiceUnavailableException(
        'A live block on this page could not be reached. Try again.',
      );
    }

    const wanted = new Set(stored.map((row) => row.id));
    const sources = (
      await this.liveBlockRepo.findByPageIds(pageIds, {
        includeYdoc: true,
        includeSnapshot: true,
      })
    ).filter((row) => wanted.has(row.id));
    return { blockIdMap, sources, copiedPaths: [] };
  }

  /** Inserts the planned copies; runs after the new pages are inserted. */
  async insertPageCopies(
    plan: PageCopyPlan,
    pageIdMap: Map<string, string>,
    trx: KyselyTransaction,
    target: { spaceId: string; creatorId: string },
  ): Promise<void> {
    for (const source of plan.sources) {
      const blockId = plan.blockIdMap.get(source.id);
      const pageId = pageIdMap.get(source.pageId);
      if (!blockId || !pageId) continue;
      await this.copyBlock(
        source,
        {
          blockId,
          page: {
            id: pageId,
            spaceId: target.spaceId,
            workspaceId: source.workspaceId,
          } as Page,
          creatorId: target.creatorId,
        },
        trx,
        plan.copiedPaths,
      );
    }
  }

  /** Replaces the page's live blocks with static nodes for an export. */
  async inlineForExport(
    content: unknown,
    page: Pick<Page, 'id' | 'slugId'>,
    baseUrl: string,
  ): Promise<unknown> {
    const blockIds = findLiveBlocks(content).map((b) => b.blockId);
    if (blockIds.length === 0) return content;

    // only ids that are stored rows of this page: page content is untrusted,
    // and a flush per id it names would be unbounded
    const wanted = new Set(blockIds);
    const owned = (await this.liveBlockRepo.findByPageIds([page.id])).filter(
      (row) => wanted.has(row.id),
    );
    if (owned.length > 0) {
      // an export must not fail because a block could not be flushed
      try {
        const { unreachable } = await this.liveBlockSyncBridge.flush(
          owned.map((row) => row.id),
        );
        if (unreachable.length > 0) {
          this.logger.warn(
            `Exporting stored snapshots of unreachable blocks: ${unreachable.join(', ')}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Export could not flush live blocks: ${err?.['message']}`,
        );
      }
    }

    // read after the flush, so open blocks give their latest snapshot
    const rows = (
      await this.liveBlockRepo.findByPageIds([page.id], {
        includeSnapshot: true,
      })
    ).filter((row) => wanted.has(row.id));
    const snapshots = new Map<string, LiveBlockSnapshot>();
    for (const row of rows) {
      try {
        snapshots.set(row.id, await this.currentSnapshot(row));
      } catch (err) {
        // an export must not fail because one block could not be rebuilt
        this.logger.warn(
          `Exporting the stored snapshot of live block ${row.id}: ${err?.['message']}`,
        );
        if (row.snapshot)
          snapshots.set(row.id, row.snapshot as LiveBlockSnapshot);
      }
    }

    return inlineLiveBlocks(content, snapshots, (blockId, attrs) => ({
      title: attrs.title || 'Untitled',
      previewSrc: attrs.src || undefined,
      openUrl: `${baseUrl}/p/${page.slugId}?block=${blockId}`,
    }));
  }

  async applyOps(
    blockId: string,
    ops: LiveBlockOp[],
    user: User,
  ): Promise<void> {
    const row = await this.liveBlockRepo.findById(blockId);
    if (!row || row.workspaceId !== user.workspaceId) {
      throw new NotFoundException(BLOCK_NOT_FOUND);
    }
    await this.editablePage(row.pageId, user);
    await this.liveBlockSyncBridge.apply(
      row.id,
      row.kind as LiveBlockKind,
      ops,
      user,
    );
  }

  /**
   * The page, if this user may edit it. Each refusal carries a stable code a
   * client can tell apart from a proxy's bare 403/404: PAGE_NOT_FOUND and
   * PAGE_NOT_EDITABLE are final for this user, PAGE_IN_TRASH is not (a
   * restore undoes it).
   */
  private async editablePage(pageId: string, user: User): Promise<Page> {
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.workspaceId !== user.workspaceId) {
      throw new NotFoundException({
        code: 'PAGE_NOT_FOUND',
        message: 'Page not found',
      });
    }
    try {
      await this.pageAccessService.validateCanEdit(page, user);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw new ForbiddenException({
          code: 'PAGE_NOT_EDITABLE',
          message: 'You cannot edit this page',
        });
      }
      throw err;
    }
    if (page.deletedAt) {
      throw new ForbiddenException({
        code: 'PAGE_IN_TRASH',
        message: 'The page is in the trash',
      });
    }
    return page;
  }
}
