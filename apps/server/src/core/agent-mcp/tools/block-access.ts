import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { LiveBlockInputError, LiveBlockKind } from '@docmost/live-blocks';
import { LiveBlock, Page } from '@docmost/db/types/entity.types';
import { pageContainsBlock } from '../../live-block/page-content.util';
import {
  loadEditablePage,
  loadViewablePage,
  mcpAuditMeta,
  McpDeps,
} from '../mcp-deps';
import { McpContext, McpToolError, NOT_FOUND } from '../tool.types';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { getPageTitle } from '../../../common/helpers';
import { CreateOnPageResult } from '../../live-block/live-block.service';

/**
 * The block, its page and the caller's access to that page. A block of another
 * kind, on a page the caller cannot reach, or no longer in the page's content
 * is NOT_FOUND.
 */
export async function loadBlock(
  deps: McpDeps,
  ctx: McpContext,
  blockId: string,
  kind: LiveBlockKind,
  access: 'view' | 'edit',
): Promise<{ row: LiveBlock; page: Page }> {
  const row = await deps.liveBlockRepo.findById(blockId);
  if (!row || row.workspaceId !== ctx.workspace.id || row.kind !== kind) {
    throw new McpToolError(NOT_FOUND);
  }
  const load = access === 'edit' ? loadEditablePage : loadViewablePage;
  const page = await load(deps, ctx, row.pageId, { includeContent: true });
  if (!pageContainsBlock(page.content, blockId)) {
    throw new McpToolError(NOT_FOUND);
  }
  return { row, page };
}

/** Turns the errors of a live block call into messages the caller may see. */
export async function blockCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof McpToolError) throw e;
    if (e instanceof ForbiddenException || e instanceof NotFoundException) {
      throw new McpToolError(NOT_FOUND);
    }
    if (e instanceof LiveBlockInputError) throw new McpToolError(e.message);
    if (
      e instanceof BadRequestException ||
      e instanceof ConflictException ||
      e instanceof ServiceUnavailableException
    ) {
      throw new McpToolError(e.message);
    }
    throw e;
  }
}

// The target of a create_* tool: a new page in a space, or the end of a page.
export const blockTargetShape = {
  title: z.string().min(1).max(500),
  space_id: z.guid().optional(),
  page_id: z.string().min(1).optional(),
  parent_page_id: z.string().min(1).optional(),
};

export const TARGET_RULE =
  'Pass space_id to make a new page holding the block (parent_page_id puts it under that page), or page_id to add the block at the end of an existing page.';

export function refineTarget<
  T extends { space_id?: string; page_id?: string; parent_page_id?: string },
>(args: T, ctx: z.RefinementCtx): void {
  if (!!args.space_id === !!args.page_id) {
    ctx.addIssue({
      code: 'custom',
      message: 'Pass exactly one of space_id and page_id',
    });
  }
  if (args.page_id && args.parent_page_id) {
    ctx.addIssue({
      code: 'custom',
      message: 'parent_page_id goes with space_id, not page_id',
    });
  }
}

export function targetOf(args: {
  space_id?: string;
  page_id?: string;
  parent_page_id?: string;
}): { spaceId: string; parentPageId?: string } | { pageId: string } {
  return args.page_id
    ? { pageId: args.page_id }
    : { spaceId: args.space_id, parentPageId: args.parent_page_id };
}

/** Logs a new page the way create_page_from_markdown does; returns the output. */
export function createdBlockOutput(
  deps: McpDeps,
  ctx: McpContext,
  title: string,
  spaceId: string | undefined,
  out: CreateOnPageResult,
) {
  if (out.createdPage) {
    deps.audit.log({
      event: AuditEvent.PAGE_CREATED,
      resourceType: AuditResource.PAGE,
      resourceId: out.pageId,
      spaceId,
      changes: { after: { title: getPageTitle(title), spaceId } },
      metadata: mcpAuditMeta(ctx),
    });
  }
  return {
    page_id: out.pageId,
    block_id: out.blockId,
    url: out.url,
    created_page: out.createdPage,
  };
}
