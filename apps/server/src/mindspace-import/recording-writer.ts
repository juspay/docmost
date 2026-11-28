import * as Y from 'yjs';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { seedYdoc, type LiveBlockSnapshot } from '@docmost/live-blocks';
import type { Page } from '@docmost/db/types/entity.types';
import { createYdocFromJson } from '../common/helpers/prosemirror/utils';
import { jsonToText } from '../collaboration/collaboration.util';
import type { ImportMap } from './import-map';
import type { DocmostReader } from './docmost-reader';
import {
  commentContent,
  spaceSlug,
  type CreateCommentInput,
  type CreateLiveBlockInput,
  type CreatePageInput,
  type CreateShareInput,
  type CreateSpaceInput,
  type ImportWriterPort,
  type MapEntry,
  type SpaceRoleName,
  type GrantableRole,
  type GrantOutcome,
  assertGrantable,
  roleRank,
} from './import-writer';

export type RecordedComment = {
  id: string;
  pageId: string;
  parentCommentId: string | null;
  selection: string | null;
  resolvedAt: Date | null;
  resolvedById: string | null;
  creatorId: string;
  createdAt: Date;
};

/**
 * The dry run's writer: performs the same conversions as ImportWriter (text
 * content, page ydoc, block ydoc, comment body) so a conversion that would fail
 * fails here too, then keeps the result in memory instead of writing it.
 */
export class RecordingWriter implements ImportWriterPort {
  readonly spaces = new Map<
    string,
    { id: string; slug: string; name: string; creatorId: string }
  >();
  readonly members = new Map<string, Map<string, SpaceRoleName>>();
  readonly pages = new Map<string, Page>();
  readonly blocks = new Map<
    string,
    { pageId: string; snapshot: LiveBlockSnapshot }
  >();
  /** each block's seeded document, as the database would hold it */
  readonly blockDocs = new Map<string, Y.Doc>();
  readonly comments = new Map<string, RecordedComment>();
  /** The plain-text body each comment was given. */
  readonly commentTexts = new Map<string, string>();
  readonly shares = new Map<
    string,
    {
      pageId: string;
      key: string;
      includeSubPages: boolean;
      expiresAt: Date | null;
    }
  >();
  readonly operations: string[] = [];

  constructor(
    private readonly map: ImportMap,
    private readonly workspaceId: string,
    /** docmost as it is, for what a dry run must not count as new */
    private readonly base?: Pick<DocmostReader, 'spaceMembers'>,
  ) {}

  private pendingMap: [MapEntry, string, string][] | null = null;

  /** Like a database transaction: on an error nothing it recorded remains. */
  async inTransaction<T>(
    fn: (writer: ImportWriterPort) => Promise<T>,
  ): Promise<T> {
    if (this.pendingMap) return fn(this);
    // every in-memory table, with one level of nesting (members per space)
    const tables = Object.values(this).filter(
      (v): v is Map<unknown, unknown> => v instanceof Map,
    );
    const saved = tables.map(
      (t) =>
        new Map([...t].map(([k, v]) => [k, v instanceof Map ? new Map(v) : v])),
    );
    const savedOps = this.operations.length;
    this.pendingMap = [];
    try {
      const result = await fn(this);
      const pending = this.pendingMap;
      this.pendingMap = null;
      for (const [entry, type, id] of pending) {
        await this.map.set(
          entry.type,
          entry.sourceId,
          type,
          id,
          undefined,
          entry.rewritten,
        );
      }
      return result;
    } catch (err) {
      this.pendingMap = null;
      tables.forEach((t, i) => {
        t.clear();
        for (const [k, v] of saved[i]) t.set(k, v);
      });
      this.operations.length = savedOps;
      throw err;
    }
  }

  private async mapRow(
    entry: MapEntry | undefined,
    targetType: string,
    id: string,
  ) {
    if (!entry) return;
    if (this.pendingMap) this.pendingMap.push([entry, targetType, id]);
    else
      await this.map.set(
        entry.type,
        entry.sourceId,
        targetType,
        id,
        undefined,
        entry.rewritten,
      );
  }

  async createSpace(input: CreateSpaceInput) {
    const space = {
      id: input.id,
      slug: spaceSlug(input.name, input.id),
      name: input.name,
      creatorId: input.adminId,
    };
    if (!this.spaces.has(space.id)) {
      this.spaces.set(space.id, space);
      this.members.set(space.id, new Map([[input.adminId, 'admin']]));
      this.operations.push(`space ${space.id}`);
    }
    await this.mapRow(input.map, 'space', space.id);
    return { id: space.id, slug: space.slug };
  }

  async addSpaceMember(
    spaceId: string,
    userId: string,
    role: SpaceRoleName,
    map?: MapEntry,
  ) {
    const added = await this.addMember(spaceId, userId, role);
    await this.mapRow(
      map && { ...map, rewritten: map.rewritten || added },
      'user',
      userId,
    );
    return added;
  }

  private async addMember(
    spaceId: string,
    userId: string,
    role: SpaceRoleName,
  ) {
    const members =
      this.members.get(spaceId) ?? new Map<string, SpaceRoleName>();
    this.members.set(spaceId, members);
    if (members.has(userId)) return false;
    const existing = (await this.base?.spaceMembers(spaceId))?.find(
      (m) => m.userId === userId,
    );
    if (existing) {
      // already a member in docmost: as ImportWriter, nothing is added
      members.set(userId, existing.role);
      return false;
    }
    members.set(userId, role);
    this.operations.push(`member ${spaceId} ${userId} ${role}`);
    return true;
  }

  async setSpaceRole(
    spaceId: string,
    userId: string,
    role: SpaceRoleName,
    map?: MapEntry,
  ) {
    const members =
      this.members.get(spaceId) ?? new Map<string, SpaceRoleName>();
    this.members.set(spaceId, members);
    members.set(userId, role);
    this.operations.push(`role ${spaceId} ${userId} ${role}`);
    await this.mapRow(map && { ...map, rewritten: true }, 'user', userId);
  }

  async grantSpaceRole(
    spaceId: string,
    userId: string,
    role: GrantableRole,
    map?: MapEntry,
  ) {
    assertGrantable(role);
    const members =
      this.members.get(spaceId) ?? new Map<string, SpaceRoleName>();
    this.members.set(spaceId, members);
    if (!members.has(userId)) {
      const existing = (await this.base?.spaceMembers(spaceId))?.find(
        (m) => m.userId === userId,
      );
      if (existing) members.set(userId, existing.role);
    }
    const current = members.get(userId);
    let outcome: GrantOutcome = 'kept';
    if (roleRank(current) < roleRank(role)) {
      members.set(userId, role);
      this.operations.push(`member ${spaceId} ${userId} ${role}`);
      outcome = current ? 'raised' : 'added';
    }
    await this.mapRow(
      map && { ...map, rewritten: outcome !== 'kept' },
      'user',
      userId,
    );
    return outcome;
  }

  async createPage(input: CreatePageInput) {
    let page = this.pages.get(input.id);
    if (!page) {
      jsonToText(input.content as any);
      createYdocFromJson(input.content);
      const createdAt = input.createdAt ?? new Date();
      // as ImportWriter: the given position, else after the last sibling
      const siblings = [...this.pages.values()]
        .filter(
          (p) =>
            p.spaceId === input.spaceId &&
            (p.parentPageId ?? null) === (input.parentPageId ?? null) &&
            !p.deletedAt,
        )
        .map((p) => p.position)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const position =
        input.position ??
        generateJitteredKeyBetween(siblings[siblings.length - 1] ?? null, null);
      page = {
        id: input.id,
        position,
        // unique per page, like a real slug id
        slugId: `d${input.id.replace(/-/g, '').slice(0, 9)}`,
        title: input.title,
        content: input.content,
        parentPageId: input.parentPageId ?? null,
        spaceId: input.spaceId,
        workspaceId: this.workspaceId,
        creatorId: input.creatorId,
        createdAt,
        updatedAt: input.updatedAt ?? createdAt,
        deletedAt: null,
      } as unknown as Page;
      this.pages.set(page.id, page);
      this.operations.push(`page ${page.id}`);
    }
    await this.mapRow(input.map, 'page', page.id);
    return page;
  }

  async createLiveBlock(input: CreateLiveBlockInput) {
    if (!this.blocks.has(input.blockId)) {
      const doc = new Y.Doc();
      Y.applyUpdate(
        doc,
        Y.encodeStateAsUpdate(input.ydoc ?? seedYdoc(input.snapshot)),
      );
      this.blockDocs.set(input.blockId, doc);
      this.blocks.set(input.blockId, {
        pageId: input.page.id,
        snapshot: input.snapshot,
      });
      this.operations.push(`block ${input.blockId}`);
    }
    await this.mapRow(input.map, 'page', input.page.id);
  }

  async createComment(input: CreateCommentInput) {
    if (!this.comments.has(input.id)) {
      commentContent(input.text);
      this.comments.set(input.id, {
        id: input.id,
        pageId: input.page.id,
        parentCommentId: input.parentCommentId ?? null,
        // as ImportWriter and CommentService
        selection: input.selection ? input.selection.substring(0, 250) : null,
        resolvedAt: input.resolvedAt ?? null,
        resolvedById: input.resolvedById ?? null,
        creatorId: input.creatorId,
        createdAt: input.createdAt,
      });
      this.commentTexts.set(input.id, input.text);
      this.operations.push(`comment ${input.id}`);
    }
    await this.mapRow(input.map, 'comment', input.id);
  }

  async setPageContent(page: Page, content: unknown) {
    jsonToText(content as any);
    createYdocFromJson(content);
    const stored = this.pages.get(page.id) ?? page;
    const updated = { ...stored, content } as Page;
    this.pages.set(page.id, updated);
    this.operations.push(`content ${page.id}`);
    return updated;
  }

  async createShare(input: CreateShareInput) {
    let share = this.shares.get(input.id);
    if (!share) {
      share = {
        pageId: input.page.id,
        key: `dry${input.id.replace(/-/g, '').slice(0, 7)}`,
        includeSubPages: input.includeSubPages,
        expiresAt: input.expiry?.expiresAt ?? null,
      };
      this.shares.set(input.id, share);
      this.operations.push(`share ${input.id}`);
    }
    await this.mapRow(input.map, 'share', input.id);
    return { key: share.key };
  }
}
