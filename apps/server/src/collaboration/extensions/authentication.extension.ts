import {
  Connection,
  Extension,
  Hocuspocus,
  onAuthenticatePayload,
  onConfigurePayload,
} from '@hocuspocus/server';
import { Forbidden } from '@hocuspocus/common';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';
import { LiveBlock, Page, User } from '@docmost/db/types/entity.types';
import { SpaceRole } from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { parseDocumentName } from '@docmost/live-blocks';
import { LiveBlockCollabService } from '../live-block/live-block-collab.service';
import { pageContainsBlock } from '../../core/live-block/page-content.util';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { COLLAB_ACCESS_RECHECK_CHANNEL } from '../constants';
import { CollabAccessRecheck } from '../services/collab-access.service';
import { JwtCollabPayload, JwtType } from '../../core/auth/dto/jwt-payload';

// a block inserted less than this long ago may still be missing from the stored page
const NEW_BLOCK_GRACE_MS = 2 * 60 * 1000;

type CollabAccess = 'none' | 'read' | 'write';

@Injectable()
export class AuthenticationExtension implements Extension {
  private readonly logger = new Logger(AuthenticationExtension.name);
  private instance: Hocuspocus;
  private subscriber: Redis;

  constructor(
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly redisService: RedisService,
    private readonly liveBlockCollab: LiveBlockCollabService,
  ) {}

  async onConfigure({ instance }: onConfigurePayload) {
    this.instance = instance;
    this.subscriber = this.redisService.getOrThrow().duplicate();
    this.subscriber.on('error', () => {});
    this.subscriber.on('message', async (_channel, message) => {
      try {
        await this.recheckAccess(JSON.parse(message));
      } catch (err) {
        this.logger.error({ err }, 'Failed to recheck collab access');
      }
    });
    // resubscribe on every ready, ioredis never replays a SUBSCRIBE that failed while redis was down
    this.subscriber.on('ready', () => {
      this.subscriber
        .subscribe(COLLAB_ACCESS_RECHECK_CHANNEL)
        .catch((err) =>
          this.logger.error({ err }, 'Failed to subscribe to collab rechecks'),
        );
    });
  }

  async onDestroy() {
    this.subscriber?.disconnect();
  }

  async onAuthenticate(data: onAuthenticatePayload) {
    const { documentName, token } = data;
    const parsed = parseDocumentName(documentName);
    if (parsed.type === 'invalid') {
      throw new NotFoundException('Page not found');
    }

    let jwtPayload: JwtCollabPayload;

    try {
      jwtPayload = await this.tokenService.verifyJwt(token, JwtType.COLLAB);
    } catch (error) {
      throw new UnauthorizedException('Invalid collab token');
    }

    const userId = jwtPayload.sub;
    const workspaceId = jwtPayload.workspaceId;

    let pageId = parsed.id;
    let block: LiveBlock | null = null;
    if (parsed.type === 'block') {
      block = await this.liveBlockCollab.resolve(parsed.id, workspaceId);
      if (!block) {
        this.logger.debug(`Live block not found: ${parsed.id}`);
        throw new NotFoundException('Page not found');
      }
      pageId = block.pageId;
    }

    const [user, page] = await Promise.all([
      this.userRepo.findById(userId, workspaceId),
      // a block's page content says whether the block is still in it
      parsed.type === 'block'
        ? this.pageRepo.findById(pageId, { includeContent: true })
        : this.pageRepo.findById(pageId),
    ]);

    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    if (!page || page.workspaceId !== workspaceId) {
      this.logger.debug(`Page not found: ${pageId}`);
      throw new NotFoundException('Page not found');
    }

    // a block removed from its page cannot be opened or written live, even
    // with its id; a reader of its page can still copy it (clone, R53)
    if (block && !this.pageHoldsBlock(page, block)) {
      this.logger.debug(`Live block ${parsed.id} is not in page ${pageId}`);
      throw new NotFoundException('Page not found');
    }

    const access = await this.getAccess(user, page);

    if (access === 'none') {
      this.logger.warn(
        `User ${user.id} not authorized to access page: ${pageId}`,
      );
      throw new UnauthorizedException();
    }

    if (access === 'read') {
      data.connectionConfig.readOnly = true;
    }

    this.logger.debug(`Authenticated user ${user.id} on page ${pageId}`);

    return {
      user,
    };
  }

  /**
   * The page's stored content, or its live document when it is open here, or
   * a row this page created moments ago: with Redis the page may be open on
   * another server, and its store comes 10 to 45 s after the insert.
   */
  private pageHoldsBlock(page: Page, block: LiveBlock): boolean {
    const blockId = block.id;
    if (pageContainsBlock(page.content, blockId)) return true;
    if (block.createdAt) {
      // a creation time ahead of this clock gets no grace
      const age = Date.now() - new Date(block.createdAt).getTime();
      if (age >= 0 && age < NEW_BLOCK_GRACE_MS) return true;
    }
    const open = this.instance?.documents.get(`page.${page.id}`);
    if (!open) return false;
    try {
      const json = TiptapTransformer.fromYdoc(open, 'default');
      return pageContainsBlock(json, blockId);
    } catch {
      return false;
    }
  }

  async recheckAccess({
    userIds = [],
    pageIds = [],
  }: CollabAccessRecheck): Promise<void> {
    if (!this.instance?.documents.size) return;

    const recheckUserIds = new Set(userIds);
    const recheckPageIds = new Set<string>();
    for (const pageId of pageIds) {
      const pages = await this.pageRepo.getPageAndDescendants(pageId, {
        includeContent: false,
      });
      pages.forEach((page) => recheckPageIds.add(page.id));
    }

    for (const document of this.instance.documents.values()) {
      const parsed = parseDocumentName(document.name);
      if (parsed.type === 'invalid') continue;
      // a block connection is rechecked whenever its page is
      const pageId =
        parsed.type === 'block'
          ? this.liveBlockCollab.pageIdOf(document.name)
          : parsed.id;
      const connections = document.getConnections().filter((connection) => {
        const userId = connection.context?.user?.id;
        return (
          userId && (recheckPageIds.has(pageId) || recheckUserIds.has(userId))
        );
      });
      if (connections.length === 0) continue;

      for (const connection of connections) {
        try {
          await this.recheckConnection(connection, pageId);
        } catch (err) {
          this.logger.error(
            { err },
            `Failed to recheck collab access on ${document.name}`,
          );
        }
      }
    }
  }

  private async recheckConnection(
    connection: Connection,
    pageId: string,
  ): Promise<void> {
    const { id, workspaceId } = connection.context.user;
    const [user, page] = await Promise.all([
      this.userRepo.findById(id, workspaceId),
      this.pageRepo.findById(pageId),
    ]);

    let access: CollabAccess = 'none';
    if (user && !isUserDisabled(user) && page) {
      access = await this.getAccess(user, page);
    }

    if (access === 'write' || (access === 'read' && connection.readOnly)) {
      return;
    }

    connection.sendStateless(
      JSON.stringify({ type: 'page.permissions', access }),
    );
    connection.readOnly = true;
    if (access === 'none') {
      connection.close(Forbidden);
    }
  }

  // a connection outlives this check, so it must not see a stale cached allow
  private async getAccess(user: User, page: Page): Promise<CollabAccess> {
    const [spaceRoles, { hasAnyRestriction, canAccess, canEdit }] =
      await Promise.all([
        this.spaceMemberRepo.getUserSpaceRoles(user.id, page.spaceId, {
          skipCache: true,
        }),
        this.pagePermissionRepo.canUserEditPage(user.id, page.id, {
          skipCache: true,
        }),
      ]);

    const userSpaceRole = findHighestUserSpaceRole(spaceRoles);
    if (!userSpaceRole) return 'none';
    if (hasAnyRestriction && !canAccess) return 'none';

    const canWrite = hasAnyRestriction
      ? canEdit
      : userSpaceRole !== SpaceRole.READER;
    return canWrite && !page.deletedAt ? 'write' : 'read';
  }
}
