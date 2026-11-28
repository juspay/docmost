import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateShareDto, ShareInfoDto, UpdateShareDto } from './dto/share.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { nanoIdGen } from '../../common/helpers';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { TokenService } from '../auth/services/token.service';
import { withoutTemplatePlaceholders } from '@docmost/editor-ext';
import { jsonToNode } from '../../collaboration/collaboration.util';
import {
  getAttachmentIds,
  getProsemirrorContent,
  isAttachmentNode,
  removeMarkTypeFromDoc,
} from '../../common/helpers/prosemirror/utils';
import { Node } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { updateAttachmentAttr, updateAttachmentUrl } from './share.util';
import { Page } from '@docmost/db/types/entity.types';
import { getCoverAttachmentId } from '../page/page-cover.utils';
import { validate as isValidUUID } from 'uuid';
import { sql } from 'kysely';
import { TransclusionService } from '../page/transclusion/transclusion.service';
import { TransclusionLookup } from '../page/transclusion/transclusion.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import {
  lifetimeUntil,
  ShareExpiredException,
  ShareExpiryService,
} from '../share-expiry/share-expiry.service';

@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    private readonly shareRepo: ShareRepo,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly tokenService: TokenService,
    private readonly transclusionService: TransclusionService,
    private readonly shareExpiryService: ShareExpiryService,
  ) {}

  async getShares(userId: string, pagination: PaginationOptions) {
    const result = await this.shareRepo.getShares(userId, pagination);
    const accessiblePageIds = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: result.items.map((share) => share.pageId),
        userId,
      }),
    );
    const now = Date.now();
    result.items = result.items
      .filter((share) => accessiblePageIds.has(share.pageId))
      .map((share) => ({
        ...share,
        expiresAt: share.expiresAt ?? null,
        periodDays: share.periodDays ?? null,
        expired: share.expiresAt
          ? new Date(share.expiresAt).getTime() <= now
          : false,
      }));
    return result;
  }

  /**
   * Throws SHARE_EXPIRED unless the share is still usable. The slug id in the
   * body is the share's root page, which is where a signed-in person is sent.
   */
  async assertShareUsable(share: { id: string; pageId: string }) {
    // Today's answers for a restricted page win over the expiry answer.
    if (
      share.pageId &&
      (await this.pagePermissionRepo.hasRestrictedAncestor(share.pageId))
    ) {
      return;
    }
    if (await this.shareExpiryService.isUsable(share.id)) return;
    const root = share.pageId
      ? await this.pageRepo.findById(share.pageId)
      : undefined;
    if (!root?.slugId) {
      throw new NotFoundException('Share not found');
    }
    throw new ShareExpiredException(root.slugId);
  }

  async getShareTree(shareId: string, workspaceId: string) {
    const share = await this.shareRepo.findById(shareId);
    if (!share || share.workspaceId !== workspaceId) {
      throw new NotFoundException('Share not found');
    }

    const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
      share.pageId,
    );
    if (isRestricted) {
      throw new NotFoundException('Share not found');
    }

    // Sub-pages covered by another, still usable share are reached through
    // that share's own link, not through this tree.
    if (!(await this.isSharingAllowed(workspaceId, share.spaceId))) {
      throw new NotFoundException('Share not found');
    }
    await this.assertShareUsable(share);

    if (share.includeSubPages) {
      const pageTree =
        await this.pageRepo.getPageAndDescendantsExcludingRestricted(
          share.pageId,
          { includeContent: false },
        );

      return { share, pageTree };
    } else {
      return { share, pageTree: [] };
    }
  }

  async createShare(opts: {
    authUserId: string;
    workspaceId: string;
    page: Page;
    createShareDto: CreateShareDto;
  }) {
    const { authUserId, workspaceId, page, createShareDto } = opts;

    try {
      const shares = await this.shareRepo.findByPageId(page.id);
      if (shares) {
        return shares;
      }

      return await this.shareRepo.insertShare({
        key: nanoIdGen().toLowerCase(),
        pageId: page.id,
        includeSubPages: createShareDto.includeSubPages ?? false,
        searchIndexing: createShareDto.searchIndexing ?? false,
        creatorId: authUserId,
        spaceId: page.spaceId,
        workspaceId,
      });
    } catch (err) {
      this.logger.error(err);
      throw new BadRequestException('Failed to share page');
    }
  }

  async updateShare(shareId: string, updateShareDto: UpdateShareDto) {
    try {
      return this.shareRepo.updateShare(
        {
          includeSubPages: updateShareDto.includeSubPages,
          searchIndexing: updateShareDto.searchIndexing,
        },
        shareId,
      );
    } catch (err) {
      this.logger.error(err);
      throw new BadRequestException('Failed to update share');
    }
  }

  async getSharedPage(
    dto: ShareInfoDto,
    workspaceId: string,
    opts?: { includeContent?: boolean },
  ) {
    //TODO: we should resolve the page from the share id
    if (!dto.pageId) throw new NotFoundException('Shared page not found');

    const share = await this.getShareForPage(dto.pageId, workspaceId);

    if (!share) {
      throw new NotFoundException('Shared page not found');
    }

    const includeContent = opts?.includeContent !== false;
    // Content is read only after the expiry check, so an expired link never
    // loads it or mints a token for it.
    const page = await this.pageRepo.findById(dto.pageId);

    if (!page || page.deletedAt) {
      throw new NotFoundException('Shared page not found');
    }

    // Block access to restricted pages
    const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
      page.id,
    );
    if (isRestricted) {
      throw new NotFoundException('Shared page not found');
    }

    // Every existing refusal wins over the expiry answer.
    if (!(await this.isSharingAllowed(workspaceId, share.spaceId))) {
      throw new NotFoundException('Shared page not found');
    }
    if (share.expired) {
      throw new ShareExpiredException(page.slugId);
    }

    if (!includeContent) {
      return { page, share };
    }

    const fullPage = await this.pageRepo.findById(page.id, {
      includeContent: true,
      includeCreator: true,
    });
    if (!fullPage || fullPage.deletedAt) {
      throw new NotFoundException('Shared page not found');
    }

    const tokenLifetime = await this.shareExpiryService.attachmentTokenLifetime(
      share.id,
    );
    fullPage.content = await this.updatePublicAttachments(fullPage, {
      tokenLifetime,
    });
    fullPage.coverPhoto = await this.updatePublicCoverPhoto(fullPage, {
      tokenLifetime,
    });

    return { page: fullPage, share };
  }

  async getShareForPage(
    pageId: string,
    workspaceId: string,
    opts?: { preferOwn?: boolean },
  ) {
    // A page is reachable through its own share or through an ancestor's share
    // that includes sub-pages. The walk continues past an expired share that
    // covers the page, so a live share further up can still serve it; a share
    // that does not cover the page ends the walk, as it always has.
    const now = new Date();
    const rows = await this.db
      .withRecursive('page_hierarchy', (cte) =>
        cte
          .selectFrom('pages')
          .leftJoin('shares', 'shares.pageId', 'pages.id')
          .leftJoin('shareExpiries', 'shareExpiries.shareId', 'shares.id')
          .select([
            'pages.id',
            'pages.slugId',
            'pages.title',
            'pages.icon',
            'pages.parentPageId',
            'pages.spaceId as pageSpaceId',
            sql`0`.as('level'),
            'shares.id as shareId',
            'shares.key as shareKey',
            'shares.includeSubPages',
            'shares.searchIndexing',
            'shares.creatorId',
            'shares.spaceId',
            'shares.workspaceId',
            'shares.createdAt',
            'shareExpiries.expiresAt',
            'shareExpiries.periodDays',
          ])
          .where(isValidUUID(pageId) ? 'pages.id' : 'pages.slugId', '=', pageId)
          .where('pages.deletedAt', 'is', null)
          .unionAll(
            (union) =>
              union
                .selectFrom('pages as p')
                .innerJoin('page_hierarchy as ph', 'ph.parentPageId', 'p.id')
                .leftJoin('shares as s', 's.pageId', 'p.id')
                .leftJoin('shareExpiries as se', 'se.shareId', 's.id')
                .select([
                  'p.id',
                  'p.slugId',
                  'p.title',
                  'p.icon',
                  'p.parentPageId',
                  'p.spaceId as pageSpaceId',
                  sql`ph.level + 1`.as('level'),
                  's.id as shareId',
                  's.key as shareKey',
                  's.includeSubPages',
                  's.searchIndexing',
                  's.creatorId',
                  's.spaceId',
                  's.workspaceId',
                  's.createdAt',
                  'se.expiresAt',
                  'se.periodDays',
                ])
                .where('p.deletedAt', 'is', null)
                .whereRef('p.spaceId', '=', 'ph.pageSpaceId')
                // stop at a usable share, or at one that does not cover the page
                .where(
                  sql<boolean>`(ph.share_id is null or (ph.expires_at <= ${now}::timestamptz and (ph.level = 0 or ph.include_sub_pages)))`,
                )
                .where(sql`ph.level`, '<', sql`25`), // prevent loop
          ),
      )
      .selectFrom('page_hierarchy')
      .selectAll()
      .where('shareId', 'is not', null)
      .orderBy('level', 'asc')
      .execute();

    let share: (typeof rows)[number] | undefined;
    let nearestExpired: (typeof rows)[number] | undefined;
    for (const row of rows) {
      if ((row.level as number) > 0 && !row.includeSubPages) break;
      if (row.expiresAt && new Date(row.expiresAt) <= now) {
        nearestExpired ??= row;
        continue;
      }
      share = row;
      break;
    }
    let expired = !share;
    share ??= nearestExpired;
    // Whoever manages a page must always see its own link, expired or not.
    if (opts?.preferOwn && (rows[0]?.level as number) === 0) {
      share = rows[0];
      expired = Boolean(share.expiresAt && new Date(share.expiresAt) <= now);
    }

    if (!share || share.workspaceId !== workspaceId) {
      return undefined;
    }

    return {
      id: share.shareId,
      key: share.shareKey,
      includeSubPages: share.includeSubPages,
      searchIndexing: share.searchIndexing,
      pageId: share.id,
      creatorId: share.creatorId,
      spaceId: share.spaceId,
      workspaceId: share.workspaceId,
      createdAt: share.createdAt,
      level: share.level,
      expiresAt: share.expiresAt ? new Date(share.expiresAt) : null,
      periodDays: share.periodDays ?? null,
      expired,
      sharedPage: {
        id: share.id,
        slugId: share.slugId,
        title: share.title,
        icon: share.icon,
      },
    };
  }

  async getShareAncestorPage(
    ancestorPageId: string,
    childPageId: string,
  ): Promise<any> {
    let ancestor = null;
    try {
      ancestor = await this.db
        .withRecursive('page_ancestors', (db) =>
          db
            .selectFrom('pages')
            .select([
              'id',
              'slugId',
              'title',
              'parentPageId',
              'spaceId',
              (eb) =>
                eb
                  .case()
                  .when(eb.ref('id'), '=', ancestorPageId)
                  .then(true)
                  .else(false)
                  .end()
                  .as('found'),
            ])
            .where(isValidUUID(childPageId) ? 'id' : 'slugId', '=', childPageId)
            .unionAll((exp) =>
              exp
                .selectFrom('pages as p')
                .select([
                  'p.id',
                  'p.slugId',
                  'p.title',
                  'p.parentPageId',
                  'p.spaceId',
                  (eb) =>
                    eb
                      .case()
                      .when(eb.ref('p.id'), '=', ancestorPageId)
                      .then(true)
                      .else(false)
                      .end()
                      .as('found'),
                ])
                .innerJoin('page_ancestors as pa', 'pa.parentPageId', 'p.id')
                // Continue recursing only when the target ancestor hasn't been found on that branch.
                .where('pa.found', '=', false),
            ),
        )
        .selectFrom('page_ancestors')
        .selectAll()
        .where('found', '=', true)
        .limit(1)
        .executeTakeFirst();
    } catch (err) {
      // empty
    }

    return ancestor;
  }

  /**
   * Resolve transclusion content for a public share viewer. Each requested
   * source page must itself be reachable via the share graph (its own share
   * or a shared ancestor with `includeSubPages`), in the same workspace as
   * the requesting share, with sharing allowed and no restricted ancestors.
   * Sources that don't qualify come back as `no_access` so the editor renders
   * the existing placeholder. The viewer's personal permissions are
   * intentionally ignored — share-served content is gated only by the share
   * graph.
   */
  async lookupTransclusionForShare(
    shareId: string,
    references: Array<{ sourcePageId: string; transclusionId: string }>,
    workspaceId: string,
  ): Promise<{ items: TransclusionLookup[] }> {
    const share = await this.shareRepo.findById(shareId);
    if (!share || share.workspaceId !== workspaceId) {
      throw new NotFoundException('Share not found');
    }
    const sharingAllowed = await this.isSharingAllowed(
      workspaceId,
      share.spaceId,
    );
    if (!sharingAllowed) {
      throw new NotFoundException('Share not found');
    }
    await this.assertShareUsable(share);
    const hostLifetime = await this.shareExpiryService.attachmentTokenLifetime(
      share.id,
    );

    const candidatePageIds = Array.from(
      new Set(references.map((r) => r.sourcePageId)),
    );

    // TODO: Reduce DB round trips at scale by replacing the per-page chain
    // with bulk repo methods that take all candidate pageIds at once:
    //   - shareRepo.getSharesForPages(pageIds, workspaceId): Map<pageId, share>
    //   - pagePermissionRepo.filterRestrictedPageIds(pageIds): Set<pageId>
    //   - isSharingAllowed for the distinct spaceIds in one query
    // Brings per-request trip count from ~2N+1 (parallel) to 3 (constant)
    // for N unique candidate pages. Worth doing if profiling ever flags it.

    // Most candidates will share the host share's space, so cache by spaceId
    // and seed with the host space we just verified. Stores in-flight
    // promises so concurrent chains de-dupe at the request boundary.
    const sharingAllowedCache = new Map<string, Promise<boolean>>();
    sharingAllowedCache.set(share.spaceId, Promise.resolve(true));
    const isSharingAllowedFor = (spaceId: string) => {
      const cached = sharingAllowedCache.get(spaceId);
      if (cached) return cached;
      const p = this.isSharingAllowed(workspaceId, spaceId);
      sharingAllowedCache.set(spaceId, p);
      return p;
    };

    // Per-page chains run in parallel; wall time is the slowest chain, not
    // the sum. Each chain still does its 2–3 queries sequentially because
    // each step gates the next.
    // A file inside a source block must not outlive the host link or the
    // source's own share, whichever ends first.
    const tokenLifetimes = new Map<string, number | undefined>();
    const accessibleResults = await Promise.all(
      candidatePageIds.map(async (pageId) => {
        const sourceShare = await this.getShareForPage(pageId, workspaceId);
        if (!sourceShare || sourceShare.expired) return null;
        const sourceLifetime = sourceShare.expiresAt
          ? lifetimeUntil(sourceShare.expiresAt, new Date())
          : undefined;
        tokenLifetimes.set(
          pageId,
          [hostLifetime, sourceLifetime].reduce<number | undefined>(
            (min, v) => (v === undefined ? min : Math.min(min ?? v, v)),
            undefined,
          ),
        );
        if (!(await isSharingAllowedFor(sourceShare.spaceId))) return null;
        const restricted =
          await this.pagePermissionRepo.hasRestrictedAncestor(pageId);
        if (restricted) return null;
        return pageId;
      }),
    );
    const accessibleSet = new Set<string>(
      accessibleResults.filter((id): id is string => id !== null),
    );

    const { items } = await this.transclusionService.lookupWithAccessSet(
      references,
      accessibleSet,
      workspaceId,
    );

    return {
      items: await this.sanitizeTransclusionItemsForPublic(
        items,
        workspaceId,
        (sourcePageId) => tokenLifetimes.get(sourcePageId),
      ),
    };
  }

  async isSharingAllowed(
    workspaceId: string,
    spaceId: string,
  ): Promise<boolean> {
    const result = await this.db
      .selectFrom('workspaces')
      .innerJoin('spaces', 'spaces.workspaceId', 'workspaces.id')
      .select([
        'workspaces.settings as workspaceSettings',
        'spaces.settings as spaceSettings',
      ])
      .where('workspaces.id', '=', workspaceId)
      .where('spaces.id', '=', spaceId)
      .executeTakeFirst();

    if (!result) return false;

    const workspaceDisabled =
      (result.workspaceSettings as any)?.sharing?.disabled === true;
    const spaceDisabled =
      (result.spaceSettings as any)?.sharing?.disabled === true;

    return !workspaceDisabled && !spaceDisabled;
  }

  async updatePublicAttachments(
    page: Page,
    opts?: { tokenLifetime?: number },
  ): Promise<any> {
    const doc = await this.prepareContentForShare(
      page.content,
      page.id,
      page.workspaceId,
      opts?.tokenLifetime,
    );
    return doc.toJSON();
  }

  async updatePublicCoverPhoto(
    page: Page,
    opts?: { tokenLifetime?: number },
  ): Promise<string | null> {
    const attachmentId = getCoverAttachmentId(page.coverPhoto);
    if (!attachmentId) return page.coverPhoto;

    const token = await this.tokenService.generateAttachmentToken({
      attachmentId,
      pageId: page.id,
      workspaceId: page.workspaceId,
      ...(opts?.tokenLifetime ? { expiresInSeconds: opts.tokenLifetime } : {}),
    });
    return updateAttachmentUrl(page.coverPhoto, token);
  }

  /**
   * Sanitization tail shared by every public transclusion surface: tokenize
   * each content item against its source page, then hide lookup misses.
   */
  async sanitizeTransclusionItemsForPublic(
    items: TransclusionLookup[],
    workspaceId: string,
    tokenLifetimeFor?: (sourcePageId: string) => number | undefined,
  ): Promise<TransclusionLookup[]> {
    const tokenized = await Promise.all(
      items.map(async (item) => {
        if ('status' in item) return item;
        const doc = await this.prepareContentForShare(
          item.content,
          item.sourcePageId,
          workspaceId,
          tokenLifetimeFor?.(item.sourcePageId),
        );
        return { ...item, content: doc.toJSON() };
      }),
    );

    // Collapse not_found to no_access so hidden sources are indistinguishable from missing ids.
    return tokenized.map((item) =>
      'status' in item && item.status === 'not_found'
        ? {
            sourcePageId: item.sourcePageId,
            transclusionId: item.transclusionId,
            status: 'no_access' as const,
          }
        : item,
    );
  }

  /**
   * Prepare a ProseMirror JSON doc for delivery to a public share viewer.
   * Prepares attachments and removes private editor metadata.
   *
   * 1. Mint a per-attachment public token scoped to `attachmentOwnerPageId`
   *    and rewrite each attachment node's `src`/`url` to the public form
   *    (`/files/public/...?jwt=`). The receiver enforces
   *    `attachment.pageId === token.pageId`, which is why the owner page id
   *    has to be passed in explicitly: the host page for direct shared
   *    content, the source page for transcluded source-block content
   *    (attachments in a sync block were uploaded onto the source page).
   *
   * 2. Remove private page queries, template instructions and `comment` marks from the
   *    surrounding page content.
   *
   * Both share-content paths — the host page (`updatePublicAttachments`) and
   * the share-scoped transclusion lookup (`lookupTransclusionForShare`) —
   * call into this single helper so the two paths can never drift on
   * sanitization rules.
   */
  private async prepareContentForShare(
    content: unknown,
    attachmentOwnerPageId: string,
    workspaceId: string,
    tokenLifetime?: number,
  ): Promise<Node> {
    const pmJson = getProsemirrorContent(content);
    const attachmentIds = getAttachmentIds(pmJson);

    const tokenMap = new Map<string, string>();
    await Promise.all(
      attachmentIds.map(async (attachmentId: string) => {
        const token = await this.tokenService.generateAttachmentToken({
          attachmentId,
          pageId: attachmentOwnerPageId,
          workspaceId,
          ...(tokenLifetime ? { expiresInSeconds: tokenLifetime } : {}),
        });
        tokenMap.set(attachmentId, token);
      }),
    );

    const doc = jsonToNode(pmJson);
    const tr = new Transform(doc);
    doc.descendants((node: Node, pos: number) => {
      if (
        node.type.name === 'recentlyUpdated' ||
        node.type.name === 'itemsByLabel'
      ) {
        const from = tr.mapping.map(pos);
        tr.delete(from, from + node.nodeSize);
        return false;
      }
      if (!isAttachmentNode(node.type.name)) return;
      const token = tokenMap.get(node.attrs.attachmentId);
      if (!token) return;
      updateAttachmentAttr(node, 'src', token);
      updateAttachmentAttr(node, 'url', token);
    });

    const publicDoc = tr.doc.copy(withoutTemplatePlaceholders(tr.doc.content));
    return removeMarkTypeFromDoc(publicDoc, 'comment');
  }
}
