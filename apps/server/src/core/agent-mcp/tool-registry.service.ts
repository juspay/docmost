import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
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
import { LiveBlockRepo } from '@docmost/db/repos/live-block/live-block.repo';
import { LiveBlockService } from '../live-block/live-block.service';
import { McpQueries } from './mcp-queries';
import { McpDeps } from './mcp-deps';
import { McpTool } from './tool.types';
import { buildTools } from './tool-registry';

@Injectable()
export class ToolRegistryService {
  readonly tools: McpTool[];

  constructor(
    queries: McpQueries,
    pageRepo: PageRepo,
    pagePermissionRepo: PagePermissionRepo,
    commentRepo: CommentRepo,
    pageAccess: PageAccessService,
    spaceAbility: SpaceAbilityFactory,
    pageService: PageService,
    commentService: CommentService,
    exportService: ExportService,
    domainService: DomainService,
    collaboration: CollaborationGateway,
    @Inject(AUDIT_SERVICE) audit: IAuditService,
    liveBlocks: LiveBlockService,
    liveBlockRepo: LiveBlockRepo,
  ) {
    this.tools = buildTools({
      queries,
      pageRepo,
      pagePermissionRepo,
      commentRepo,
      pageAccess,
      spaceAbility,
      pageService,
      commentService,
      exportService,
      domainService,
      collaboration,
      audit,
      liveBlocks,
      liveBlockRepo,
    });
  }
}
