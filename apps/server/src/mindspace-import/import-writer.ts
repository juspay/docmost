import * as Y from 'yjs';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { seedYdoc, type LiveBlockSnapshot } from '@docmost/live-blocks';
import type {
  KyselyDB,
  KyselyTransaction,
} from '@docmost/db/types/kysely.types';
import type { Page } from '@docmost/db/types/entity.types';
import { executeTx } from '@docmost/db/utils';
import { generateSlugId, nanoIdGen } from '../common/helpers';
import { createYdocFromJson } from '../common/helpers/prosemirror/utils';
import { jsonToText } from '../collaboration/collaboration.util';
import { plainTextToCommentDoc } from '../core/agent-mcp/comment-text';
import type { ShareExpiryService } from '../core/share-expiry/share-expiry.service';
import type { ImportMap, SourceType } from './import-map';

/** The map row written in the same transaction as the row it points to. */
export type MapEntry = {
  type: SourceType;
  sourceId: string;
  /** the item existed and this run wrote it again: hold it to the source */
  rewritten?: boolean;
};

export type SpaceRoleName = 'admin' | 'writer' | 'reader';
export type GrantableRole = 'writer' | 'reader';
export type GrantOutcome = 'added' | 'raised' | 'kept';

const RANK = new Map<string, number>([
  ['reader', 1],
  ['writer', 2],
  ['admin', 3],
]);

/** 0 for anything that is not a docmost space role. */
export const roleRank = (role: unknown): number =>
  (typeof role === 'string' && RANK.get(role)) || 0;

export function assertGrantable(role: unknown): asserts role is GrantableRole {
  if (role !== 'writer' && role !== 'reader') {
    throw new Error(`Not a role a share can grant: ${String(role)}`);
  }
}

export type CreateSpaceInput = {
  id: string;
  name: string;
  description: string;
  adminId: string;
  map?: MapEntry;
};

export type CreatePageInput = {
  id: string;
  spaceId: string;
  parentPageId?: string;
  title: string;
  content: unknown;
  creatorId: string;
  createdAt?: Date;
  updatedAt?: Date;
  /** Fixed sibling position; without it the page goes after its last sibling. */
  position?: string;
  map?: MapEntry;
};

export type CreateLiveBlockInput = {
  blockId: string;
  page: Page;
  snapshot: LiveBlockSnapshot;
  /**
   * The block's document, already seeded; without it the snapshot seeds it.
   * A sheet passes this, seeded from the whole workbook.
   */
  ydoc?: Y.Doc;
  creatorId: string;
  map?: MapEntry;
};

export type CreateCommentInput = {
  id: string;
  page: Page;
  parentCommentId?: string;
  text: string;
  selection?: string;
  creatorId: string;
  createdAt: Date;
  resolvedAt?: Date;
  resolvedById?: string;
  map?: MapEntry;
};

export type CreateShareInput = {
  id: string;
  page: Page;
  includeSubPages: boolean;
  creatorId: string;
  expiry?: { expiresAt: Date; periodDays: 7 };
  map?: MapEntry;
};

/** What the steps write through. The dry run swaps in RecordingWriter. */
export interface ImportWriterPort {
  /** Runs `fn` with a writer whose every call shares one transaction. */
  inTransaction<T>(fn: (writer: ImportWriterPort) => Promise<T>): Promise<T>;
  createSpace(input: CreateSpaceInput): Promise<{ id: string; slug: string }>;
  /** False when the person already was a member. */
  /** `map` records the membership in the same transaction. */
  addSpaceMember(
    spaceId: string,
    userId: string,
    role: SpaceRoleName,
    map?: MapEntry,
  ): Promise<boolean>;
  /**
   * Gives a member at least `role` (never admin): adds them, raises a lower
   * role, or keeps an equal or higher one.
   */
  grantSpaceRole(
    spaceId: string,
    userId: string,
    role: GrantableRole,
    map?: MapEntry,
  ): Promise<GrantOutcome>;
  /** Sets a live member's role (the owner's admin role). */
  setSpaceRole(
    spaceId: string,
    userId: string,
    role: SpaceRoleName,
    map?: MapEntry,
  ): Promise<void>;
  createPage(input: CreatePageInput): Promise<Page>;
  createLiveBlock(input: CreateLiveBlockInput): Promise<void>;
  createComment(input: CreateCommentInput): Promise<void>;
  createShare(input: CreateShareInput): Promise<{ key: string }>;
  /** Replaces a page's content (with its text and ydoc). Dates stay as imported. */
  setPageContent(page: Page, content: unknown): Promise<Page>;
}

/** Lower-case letters, digits and hyphens; never empty. */
export function spaceSlug(name: string, id: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const suffix = id.replace(/-/g, '').slice(0, 6);
  return base ? `${base}-${suffix}` : `ms-${suffix}`;
}

type CommentContent = ReturnType<typeof plainTextToCommentDoc>;

export function commentContent(text: string): CommentContent {
  const doc = plainTextToCommentDoc(text);
  // an empty body still needs one paragraph to render
  return doc.content.length > 0
    ? doc
    : { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
}

/**
 * Writes import rows straight through Kysely. Not PageService or
 * CommentService: those start the sync gateway and a queue worker, stamp the
 * current time and notify people, and an import must do none of that.
 * Every create adopts an existing row with the same (derived) id, so a run
 * that died between a row and its map entry is finished, not duplicated.
 */
export class ImportWriter implements ImportWriterPort {
  constructor(
    private readonly db: KyselyDB,
    private readonly map: ImportMap,
    private readonly workspaceId: string,
    private readonly shareExpiry: Pick<ShareExpiryService, 'setExact'>,
    private readonly trx?: KyselyTransaction,
  ) {}

  private tx<T>(fn: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    return executeTx(this.db, fn, this.trx);
  }

  inTransaction<T>(fn: (writer: ImportWriterPort) => Promise<T>): Promise<T> {
    return this.tx((trx) =>
      fn(
        new ImportWriter(
          this.db,
          this.map,
          this.workspaceId,
          this.shareExpiry,
          trx,
        ),
      ),
    );
  }

  private async mapRow(
    entry: MapEntry | undefined,
    targetType: string,
    id: string,
    trx: KyselyTransaction,
  ) {
    if (entry)
      await this.map.set(
        entry.type,
        entry.sourceId,
        targetType,
        id,
        trx,
        entry.rewritten,
      );
  }

  createSpace(input: CreateSpaceInput) {
    return this.tx(async (trx) => {
      let space = await trx
        .selectFrom('spaces')
        .select(['id', 'slug', 'workspaceId'])
        .where('id', '=', input.id)
        .executeTakeFirst();
      if (space && space.workspaceId !== this.workspaceId) {
        throw new Error(`Space ${input.id} belongs to another workspace`);
      }
      if (!space) {
        space = await trx
          .insertInto('spaces')
          .values({
            id: input.id,
            name: input.name,
            description: input.description,
            slug: spaceSlug(input.name, input.id),
            creatorId: input.adminId,
            workspaceId: this.workspaceId,
          })
          .returning(['id', 'slug', 'workspaceId'])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('spaceMembers')
          .values({ spaceId: space.id, userId: input.adminId, role: 'admin' })
          .execute();
      }
      await this.mapRow(input.map, 'space', space.id, trx);
      return { id: space.id, slug: space.slug };
    });
  }

  addSpaceMember(
    spaceId: string,
    userId: string,
    role: SpaceRoleName,
    map?: MapEntry,
  ) {
    return this.tx(async (trx) => {
      const existing = await trx
        .selectFrom('spaceMembers')
        .select('id')
        .where('spaceId', '=', spaceId)
        .where('userId', '=', userId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!existing) {
        await trx
          .insertInto('spaceMembers')
          .values({ spaceId, userId, role })
          .execute();
      }
      // a new membership is this run's write: verify holds it strictly
      await this.mapRow(
        map && { ...map, rewritten: map.rewritten || !existing },
        'user',
        userId,
        trx,
      );
      return !existing;
    });
  }

  setSpaceRole(
    spaceId: string,
    userId: string,
    role: SpaceRoleName,
    map?: MapEntry,
  ) {
    return this.tx(async (trx) => {
      await trx
        .updateTable('spaceMembers')
        .set({ role, updatedAt: new Date() })
        .where('spaceId', '=', spaceId)
        .where('userId', '=', userId)
        .where('deletedAt', 'is', null)
        .execute();
      await this.mapRow(
        map && { ...map, rewritten: true },
        'user',
        userId,
        trx,
      );
    });
  }

  async grantSpaceRole(
    spaceId: string,
    userId: string,
    role: GrantableRole,
    map?: MapEntry,
  ) {
    assertGrantable(role);
    return this.tx(async (trx): Promise<GrantOutcome> => {
      const existing = await trx
        .selectFrom('spaceMembers')
        .select(['id', 'role'])
        .where('spaceId', '=', spaceId)
        .where('userId', '=', userId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      let outcome: GrantOutcome = 'kept';
      if (!existing) {
        await trx
          .insertInto('spaceMembers')
          .values({ spaceId, userId, role })
          .execute();
        outcome = 'added';
      } else if (roleRank(existing.role) < roleRank(role)) {
        await trx
          .updateTable('spaceMembers')
          .set({ role, updatedAt: new Date() })
          .where('id', '=', existing.id)
          .execute();
        outcome = 'raised';
      }
      await this.mapRow(
        map && { ...map, rewritten: outcome !== 'kept' },
        'user',
        userId,
        trx,
      );
      return outcome;
    });
  }

  createPage(input: CreatePageInput) {
    return this.tx(async (trx) => {
      let page = (await trx
        .selectFrom('pages')
        .selectAll()
        .where('id', '=', input.id)
        .executeTakeFirst()) as Page | undefined;
      if (page && page.workspaceId !== this.workspaceId) {
        throw new Error(`Page ${input.id} belongs to another workspace`);
      }
      if (!page) {
        let last = trx
          .selectFrom('pages')
          .select('position')
          .where('spaceId', '=', input.spaceId)
          .where('deletedAt', 'is', null)
          .orderBy('position', (ob) => ob.collate('C').desc())
          .limit(1);
        last = input.parentPageId
          ? last.where('parentPageId', '=', input.parentPageId)
          : last.where('parentPageId', 'is', null);
        const lastPosition = (await last.executeTakeFirst())?.position ?? null;
        const createdAt = input.createdAt ?? new Date();
        page = (await trx
          .insertInto('pages')
          .values({
            id: input.id,
            slugId: generateSlugId(),
            title: input.title,
            position:
              input.position ?? generateJitteredKeyBetween(lastPosition, null),
            content: input.content as any,
            textContent: jsonToText(input.content as any),
            ydoc: createYdocFromJson(input.content),
            parentPageId: input.parentPageId ?? null,
            spaceId: input.spaceId,
            workspaceId: this.workspaceId,
            creatorId: input.creatorId,
            lastUpdatedById: input.creatorId,
            createdAt,
            updatedAt: input.updatedAt ?? createdAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow()) as Page;
      }
      await this.mapRow(input.map, 'page', page.id, trx);
      return page;
    });
  }

  createLiveBlock(input: CreateLiveBlockInput) {
    return this.tx(async (trx) => {
      const existing = await trx
        .selectFrom('liveBlocks')
        .select(['id', 'pageId', 'workspaceId'])
        .where('id', '=', input.blockId)
        .executeTakeFirst();
      if (existing && existing.pageId !== input.page.id) {
        // block ids are derived, so anyone can compute one and take it first;
        // say where it is, so an admin can clear it
        throw new Error(
          existing.workspaceId === this.workspaceId
            ? `Block ${input.blockId} is already used by page ${existing.pageId} of this workspace; delete that block, then run again`
            : `Block ${input.blockId} is already used outside this workspace`,
        );
      }
      if (!existing) {
        await trx
          .insertInto('liveBlocks')
          .values({
            id: input.blockId,
            kind: input.snapshot.kind,
            pageId: input.page.id,
            workspaceId: this.workspaceId,
            ydoc: Buffer.from(
              Y.encodeStateAsUpdate(input.ydoc ?? seedYdoc(input.snapshot)),
            ),
            snapshot: input.snapshot as any,
            creatorId: input.creatorId,
          })
          .execute();
      }
      await this.mapRow(input.map, 'page', input.page.id, trx);
    });
  }

  createComment(input: CreateCommentInput) {
    return this.tx(async (trx) => {
      const existing = await trx
        .selectFrom('comments')
        .select('id')
        .where('id', '=', input.id)
        .executeTakeFirst();
      if (!existing) {
        await trx
          .insertInto('comments')
          .values({
            id: input.id,
            pageId: input.page.id,
            spaceId: input.page.spaceId,
            workspaceId: this.workspaceId,
            content: commentContent(input.text) as any,
            selection: input.selection
              ? input.selection.substring(0, 250)
              : null,
            type: 'inline',
            parentCommentId: input.parentCommentId ?? null,
            creatorId: input.creatorId,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
            resolvedAt: input.resolvedAt ?? null,
            resolvedById: input.resolvedById ?? null,
          })
          .execute();
      }
      await this.mapRow(input.map, 'comment', input.id, trx);
    });
  }

  setPageContent(page: Page, content: unknown) {
    return this.tx(async (trx) => {
      const result = await trx
        .updateTable('pages')
        .set({
          content: content as any,
          textContent: jsonToText(content as any),
          ydoc: createYdocFromJson(content),
        })
        .where('id', '=', page.id)
        .where('workspaceId', '=', this.workspaceId)
        .executeTakeFirst();
      if (Number(result?.numUpdatedRows ?? 0) === 0) {
        throw new Error(`Page ${page.id} is not in this workspace`);
      }
      return { ...page, content } as Page;
    });
  }

  createShare(input: CreateShareInput) {
    return this.tx(async (trx) => {
      let share = await trx
        .selectFrom('shares')
        .select(['id', 'key'])
        .where('id', '=', input.id)
        .executeTakeFirst();
      if (!share) {
        share = await trx
          .insertInto('shares')
          .values({
            id: input.id,
            // a capability: random, never derived from the source
            key: nanoIdGen().toLowerCase(),
            pageId: input.page.id,
            includeSubPages: input.includeSubPages,
            searchIndexing: false,
            creatorId: input.creatorId,
            spaceId: input.page.spaceId,
            workspaceId: this.workspaceId,
          })
          .returning(['id', 'key'])
          .executeTakeFirstOrThrow();
      }
      if (input.expiry) {
        await this.shareExpiry.setExact(
          share.id,
          input.expiry.expiresAt,
          input.expiry.periodDays,
          input.creatorId,
          trx,
        );
      }
      await this.mapRow(input.map, 'share', share.id, trx);
      return { key: share.key };
    });
  }
}
