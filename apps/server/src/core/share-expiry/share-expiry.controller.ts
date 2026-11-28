import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import { ShareExpiryService } from './share-expiry.service';
import { SetShareExpiryDto, ShareExpiryIdDto } from './dto/share-expiry.dto';
import {
  AuditEvent,
  AuditEventType,
  AuditResource,
  AuditLogPayload,
} from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';

@UseGuards(JwtAuthGuard)
@Controller('shares/expiry')
export class ShareExpiryController {
  constructor(
    private readonly shareExpiryService: ShareExpiryService,
    private readonly shareRepo: ShareRepo,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  // Accepts a share id or key, then works with the id. Same page check as the
  // share update route: view to read, edit to change.
  private async resolve(
    shareIdOrKey: string,
    user: User,
    workspace: Workspace,
    access: 'view' | 'edit',
  ) {
    const share = await this.shareRepo.findById(shareIdOrKey);
    if (!share || share.workspaceId !== workspace.id) {
      throw new NotFoundException('Share not found');
    }

    const page = share.pageId
      ? await this.pageRepo.findById(share.pageId)
      : undefined;
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    if (access === 'edit') {
      await this.pageAccessService.validateCanEdit(page, user);
    } else {
      await this.pageAccessService.validateCanView(page, user);
    }
    return share;
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(
    @Body() dto: ShareExpiryIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const share = await this.resolve(dto.shareId, user, workspace, 'view');
    return this.shareExpiryService.get(share.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('set')
  async set(
    @Body() dto: SetShareExpiryDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const share = await this.resolve(dto.shareId, user, workspace, 'edit');
    const before = await this.shareExpiryService.get(share.id);
    const after = await this.shareExpiryService.set(
      share.id,
      dto.periodDays,
      user,
    );

    if (after) {
      this.audit(AuditEvent.SHARE_EXPIRY_SET, share, {
        before: before && { periodDays: before.periodDays },
        after: { periodDays: after.periodDays },
      });
    } else if (before) {
      this.audit(AuditEvent.SHARE_EXPIRY_REMOVED, share, {
        before: { periodDays: before.periodDays },
      });
    }
    return after;
  }

  @HttpCode(HttpStatus.OK)
  @Post('renew')
  async renew(
    @Body() dto: ShareExpiryIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const share = await this.resolve(dto.shareId, user, workspace, 'edit');
    const renewed = await this.shareExpiryService.renew(share.id, user);
    this.audit(AuditEvent.SHARE_EXPIRY_RENEWED, share, {
      after: { periodDays: renewed.periodDays },
    });
    return renewed;
  }

  private audit(
    event: AuditEventType,
    share: { id: string; pageId: string; spaceId: string },
    changes: AuditLogPayload['changes'],
  ) {
    this.auditService.log({
      event,
      resourceType: AuditResource.SHARE,
      resourceId: share.id,
      spaceId: share.spaceId,
      metadata: { pageId: share.pageId, spaceId: share.spaceId },
      changes,
    });
  }
}
