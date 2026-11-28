import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';
import { LIVE_BLOCK_NODE_KIND } from '../live-block/page-content.util';

// Every live block node at any depth, so list_pages does not load whole pages.
// Strict mode: in lax mode `.**` can return a node twice.
const LIVE_BLOCK_NODES_PATH = `strict $.** ? (${Object.keys(
  LIVE_BLOCK_NODE_KIND,
)
  .map((type) => `@.type == "${type}"`)
  .join(' || ')})`;

export type SpaceRow = { id: string; name: string; slug: string; role: string };
export type PageRow = {
  id: string;
  slugId: string;
  title: string | null;
  parentPageId: string | null;
};
export type ThreadRow = {
  id: string;
  pageId: string;
  parentCommentId: string | null;
  selection: string | null;
  content: unknown;
  creatorName: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

// The few reads that no existing repo offers. Plain queries, no authorisation:
// callers authorise first.
@Injectable()
export class McpQueries {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  async listUserSpaces(
    userId: string,
    workspaceId: string,
  ): Promise<SpaceRow[]> {
    const ids = await this.spaceMemberRepo.getUserSpaceIds(userId);
    if (!ids.length) return [];
    const spaces = await this.db
      .selectFrom('spaces')
      .select(['id', 'name', 'slug'])
      .where('id', 'in', ids)
      .where('workspaceId', '=', workspaceId)
      .orderBy('name', 'asc')
      .execute();
    const roles = await this.spaceMemberRepo.getUserRolesForSpaces(
      userId,
      spaces.map((s) => s.id),
    );
    return spaces.map((s) => ({
      ...s,
      role:
        findHighestUserSpaceRole(
          roles.filter((r) => r.spaceId === s.id) as any,
        ) ?? 'reader',
    }));
  }

  // Pages ordered by id (time-ordered), after `afterId`. parentPageId undefined
  // means every page in the space.
  async listPageRows(opts: {
    spaceId: string;
    workspaceId: string;
    parentPageId?: string;
    afterId?: string;
    limit: number;
  }): Promise<PageRow[]> {
    return this.db
      .selectFrom('pages')
      .select(['id', 'slugId', 'title', 'parentPageId'])
      .where('spaceId', '=', opts.spaceId)
      .where('workspaceId', '=', opts.workspaceId)
      .where('deletedAt', 'is', null)
      .$if(!!opts.parentPageId, (qb) =>
        qb.where('parentPageId', '=', opts.parentPageId),
      )
      .$if(!!opts.afterId, (qb) => qb.where('id', '>', opts.afterId))
      .orderBy('id', 'asc')
      .limit(opts.limit)
      .execute();
  }

  // Ids of the pages below a page (not the page itself), ordered by id,
  // starting at `fromId` inclusive. The tree is walked in the database; only
  // `limit` ids come back.
  async listDescendantIds(
    rootId: string,
    opts: { fromId?: string; limit: number },
  ): Promise<string[]> {
    const rows = await this.db
      .withRecursive('tree', (db) =>
        db
          .selectFrom('pages')
          .select(['id', 'spaceId'])
          .where('parentPageId', '=', rootId)
          .where('deletedAt', 'is', null)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .innerJoin('tree as t', 'p.parentPageId', 't.id')
              .select(['p.id', 'p.spaceId'])
              .where('p.deletedAt', 'is', null)
              .whereRef('p.spaceId', '=', 't.spaceId'),
          ),
      )
      .selectFrom('tree')
      .select('id')
      .$if(!!opts.fromId, (qb) => qb.where('id', '>=', opts.fromId))
      .orderBy('id', 'asc')
      .limit(opts.limit)
      .execute();
    return rows.map((r) => r.id);
  }

  async listThreadRows(pageIds: string[]): Promise<ThreadRow[]> {
    if (!pageIds.length) return [];
    return this.db
      .selectFrom('comments')
      .leftJoin('users', 'users.id', 'comments.creatorId')
      .select([
        'comments.id',
        'comments.pageId',
        'comments.parentCommentId',
        'comments.selection',
        'comments.content',
        'users.name as creatorName',
        'comments.createdAt',
        'comments.resolvedAt',
      ])
      .where(sql<boolean>`comments.page_id = ANY(${pageIds}::uuid[])`)
      .where('comments.deletedAt', 'is', null)
      .orderBy('comments.createdAt', 'asc')
      .orderBy('comments.id', 'asc')
      .execute() as Promise<ThreadRow[]>;
  }

  async listLiveBlockNodes(
    pageIds: string[],
  ): Promise<{ id: string; nodes: unknown }[]> {
    if (!pageIds.length) return [];
    return this.db
      .selectFrom('pages')
      .select([
        'id',
        sql<unknown>`jsonb_path_query_array(coalesce(content, '{}'::jsonb), ${LIVE_BLOCK_NODES_PATH}::jsonpath)`.as(
          'nodes',
        ),
      ])
      .where(sql<boolean>`id = ANY(${pageIds}::uuid[])`)
      .execute();
  }

  // Sets the title back only while it is still `expected`; true when it did.
  // A direct write on purpose: one statement so a rename in between is never
  // overwritten. The page service's side effects (contributors, watchers,
  // verification) already ran for the title this undoes.
  async restoreTitleIfUnchanged(
    pageId: string,
    expected: string,
    title: string,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('pages')
      .set({ title, updatedAt: new Date() })
      .where('id', '=', pageId)
      .where('title', '=', expected)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }
}
