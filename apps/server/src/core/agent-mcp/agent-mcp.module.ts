import { Module } from '@nestjs/common';
import { AccessTokenModule } from '../access-token/access-token.module';
import { PageModule } from '../page/page.module';
import { CommentModule } from '../comment/comment.module';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { ExportService } from '../../integrations/export/export.service';
import {
  AgentMcpController,
  AgentMcpEnabledGuard,
} from './agent-mcp.controller';
import { ToolRegistryService } from './tool-registry.service';
import { McpQueries } from './mcp-queries';

@Module({
  imports: [
    AccessTokenModule,
    PageModule,
    CommentModule,
    CollaborationModule,
    StorageModule,
  ],
  controllers: [AgentMcpController],
  // ExportModule does not export its service; providing it here keeps that
  // upstream file unchanged.
  providers: [
    ToolRegistryService,
    McpQueries,
    ExportService,
    AgentMcpEnabledGuard,
  ],
})
export class AgentMcpModule {}
