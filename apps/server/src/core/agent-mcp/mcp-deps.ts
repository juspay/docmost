import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Page } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { CommentRepo } from '@docmost/db/repos/comment/comment.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import { PageService } from '../page/services/page.service';
import { CommentService } from '../comment/comment.service';
import { ExportService } from '../../integrations/export/export.service';
import { DomainService } from '../../integrations/environment/domain.service';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { IAuditService } from '../../integrations/audit/audit.service';
import { LiveBlockRepo } from '@docmost/db/repos/live-block/live-block.repo';
import { LiveBlockService } from '../live-block/live-block.service';
import { McpQueries } from './mcp-queries';
import { McpContext, McpToolError, NOT_FOUND } from './tool.types';

// Everything a tool may touch. Tools are plain objects built from this, so a
// spec can hand them an in-memory world instead of a database.
export type McpDeps = {
  queries: McpQueries;
  pageRepo: PageRepo;
  pagePermissionRepo: PagePermissionRepo;
  commentRepo: CommentRepo;
  pageAccess: PageAccessService;
  spaceAbility: SpaceAbilityFactory;
  pageService: PageService;
  commentService: CommentService;
  exportService: ExportService;
  domainService: DomainService;
  collaboration: CollaborationGateway;
  audit: IAuditService;
  liveBlocks: LiveBlockService;
  liveBlockRepo: LiveBlockRepo;
};

// "No access" and "does not exist" must be indistinguishable to the caller.
export async function asVisible<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ForbiddenException || e instanceof NotFoundException) {
      throw new McpToolError(NOT_FOUND);
    }
    throw e;
  }
}

async function loadPage(
  deps: McpDeps,
  ctx: McpContext,
  pageId: string,
  includeContent: boolean,
): Promise<Page> {
  const page = await deps.pageRepo.findById(pageId, { includeContent });
  if (!page || page.deletedAt || page.workspaceId !== ctx.workspace.id) {
    throw new McpToolError(NOT_FOUND);
  }
  return page;
}

export function loadViewablePage(
  deps: McpDeps,
  ctx: McpContext,
  pageId: string,
  opts: { includeContent?: boolean } = {},
): Promise<Page> {
  return asVisible(async () => {
    const page = await loadPage(deps, ctx, pageId, !!opts.includeContent);
    await deps.pageAccess.validateCanView(page, ctx.user);
    return page;
  });
}

export function loadEditablePage(
  deps: McpDeps,
  ctx: McpContext,
  pageId: string,
  opts: { includeContent?: boolean } = {},
): Promise<Page> {
  return asVisible(async () => {
    const page = await loadPage(deps, ctx, pageId, !!opts.includeContent);
    await deps.pageAccess.validateCanEdit(page, ctx.user);
    return page;
  });
}

export async function pageUrl(
  deps: McpDeps,
  ctx: McpContext,
  slugId: string,
): Promise<string> {
  const base = deps.domainService.getWorkspaceUrl(ctx.workspace);
  return `${base}/p/${slugId}`;
}

// What every MCP audit entry adds to the shape the REST path logs.
export const mcpAuditMeta = (ctx: McpContext) => ({
  source: 'mcp',
  tokenId: ctx.tokenId,
});
