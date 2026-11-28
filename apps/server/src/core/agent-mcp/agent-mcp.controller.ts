import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { FastifyReply } from 'fastify';
import {
  AGENT_MCP_THROTTLER,
  ALL_NAMED_THROTTLERS_SKIPPED,
} from '../../integrations/throttle/throttler-names';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { PatAuthGuard } from '../access-token/pat-auth.guard';
import { AGENT_ACCESS_OFF, isAgentMcpOn } from '../access-token/agent-access';
import { handleRpc } from './json-rpc';
import { takeToolCall } from './rate-limit';
import { ToolRegistryService } from './tool-registry.service';
import { McpContext } from './tool.types';

// First in the chain, so a disabled endpoint answers before any other work:
// 404 when the server has it off, 403 when the workspace has.
@Injectable()
export class AgentMcpEnabledGuard implements CanActivate {
  constructor(
    private readonly env: EnvironmentService,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.env.isAgentMcpEnabled()) throw new NotFoundException();
    const raw = context.switchToHttp().getRequest()?.raw;
    const workspace =
      raw?.workspace ??
      (raw?.workspaceId
        ? await this.workspaceRepo.findById(raw.workspaceId)
        : undefined);
    if (!workspace) throw new NotFoundException();
    if (!isAgentMcpOn(workspace))
      throw new ForbiddenException(AGENT_ACCESS_OFF);
    return true;
  }
}

@SkipThrottle({
  ...ALL_NAMED_THROTTLERS_SKIPPED,
  [AGENT_MCP_THROTTLER]: false,
})
@UseGuards(AgentMcpEnabledGuard, ThrottlerGuard, PatAuthGuard)
@Controller('agent-mcp')
export class AgentMcpController {
  constructor(
    private readonly registry: ToolRegistryService,
    private readonly redisService: RedisService,
  ) {}

  // JSON-RPC and the status body must reach the client unwrapped
  @SkipTransform()
  @Get()
  status() {
    return { ok: true, server: 'docmost' };
  }

  @SkipTransform()
  @HttpCode(HttpStatus.OK)
  @Post()
  async rpc(
    @Body() body: unknown,
    @Req() req: any,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { user, workspace, pat } = req.user;
    const ctx: McpContext = {
      user,
      workspace,
      scope: pat.scope,
      tokenId: pat.id,
    };
    const result = await handleRpc(body, this.registry.tools, ctx, {
      takeToolCall: (tokenId) =>
        takeToolCall(this.redisService.getOrThrow(), tokenId),
    });
    if (result === null) {
      reply.status(HttpStatus.NO_CONTENT);
      return;
    }
    return result;
  }
}
