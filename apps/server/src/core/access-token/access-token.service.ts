import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { AccessTokenRepo } from '@docmost/db/repos/access-token/access-token.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { User, Workspace } from '@docmost/db/types/entity.types';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { isUserDisabled } from '../../common/helpers';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AGENT_ACCESS_OFF, isAgentMcpOn } from './agent-access';

export type PatScope = 'read' | 'write';
export const TOKEN_PREFIX = 'dmp_';
export const MAX_TOKENS_PER_USER = 20;
const TOKEN_PATTERN = /^dmp_[0-9a-f]{40}$/;
const LAST_USED_INTERVAL_MS = 60_000;

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export type VerifiedToken = {
  user: User;
  workspace: Workspace;
  scope: PatScope;
  tokenId: string;
};

@Injectable()
export class AccessTokenService {
  constructor(
    private readonly repo: AccessTokenRepo,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly environmentService: EnvironmentService,
  ) {}

  async create(
    user: User,
    input: { name: string; scope: PatScope; expiresAt?: Date | null },
  ) {
    // a token is only for the agent endpoint, so none is made while that is off
    // for this server or this workspace, whoever asks
    if (!this.environmentService.isAgentMcpEnabled()) {
      throw new ForbiddenException(AGENT_ACCESS_OFF);
    }
    const workspace = await this.workspaceRepo.findById(user.workspaceId);
    if (!isAgentMcpOn(workspace)) {
      throw new ForbiddenException(AGENT_ACCESS_OFF);
    }
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Expiry must be in the future');
    }
    const token = TOKEN_PREFIX + randomBytes(20).toString('hex');
    const record = await this.repo.insert(
      {
        userId: user.id,
        workspaceId: user.workspaceId,
        name: input.name.trim(),
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, 12),
        scope: input.scope,
        expiresAt: input.expiresAt ?? null,
      },
      MAX_TOKENS_PER_USER,
    );
    if (!record) {
      throw new BadRequestException(
        `You can have at most ${MAX_TOKENS_PER_USER} active access tokens. Revoke one first.`,
      );
    }

    this.auditService.log({
      event: AuditEvent.ACCESS_TOKEN_CREATED,
      resourceType: AuditResource.ACCESS_TOKEN,
      resourceId: record.id,
      changes: { after: { name: record.name, scope: record.scope } },
    });

    return { token, record };
  }

  async list(user: User) {
    const rows = await this.repo.listByUser(user.id, user.workspaceId);
    // The repo already omits the hash; this keeps it out even if that changes.
    return rows.map(({ tokenHash: _hash, ...rest }: any) => rest);
  }

  async revoke(user: User, id: string): Promise<void> {
    const owned = await this.repo.findOwned(id, user.id, user.workspaceId);
    if (!owned) throw new NotFoundException('Access token not found');
    await this.repo.revoke(id);
    this.auditService.log({
      event: AuditEvent.ACCESS_TOKEN_REVOKED,
      resourceType: AuditResource.ACCESS_TOKEN,
      resourceId: id,
      changes: { before: { name: owned.name } },
    });
  }

  async verify(
    rawToken: string,
    resolvedWorkspaceId?: string | null,
  ): Promise<VerifiedToken | null> {
    if (typeof rawToken !== 'string' || !TOKEN_PATTERN.test(rawToken)) {
      return null;
    }
    const row = await this.repo.findByHash(hashToken(rawToken));
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
      return null;
    }
    if (resolvedWorkspaceId && resolvedWorkspaceId !== row.workspaceId) {
      return null;
    }

    const user = await this.userRepo.findById(row.userId, row.workspaceId);
    if (!user || isUserDisabled(user)) return null;
    const workspace = await this.workspaceRepo.findById(row.workspaceId);
    if (!workspace) return null;

    const last = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (Date.now() - last >= LAST_USED_INTERVAL_MS) {
      void this.repo.touchLastUsed(row.id).catch(() => undefined);
    }

    return { user, workspace, scope: row.scope as PatScope, tokenId: row.id };
  }
}
