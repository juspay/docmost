import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import { LiveBlockService } from './live-block.service';
import {
  CloneLiveBlockDto,
  EnsureLiveBlockDto,
  LiveBlockSnapshotDto,
} from './dto/live-block.dto';

@UseGuards(JwtAuthGuard)
@Controller('live-blocks')
export class LiveBlockController {
  constructor(
    private readonly liveBlockService: LiveBlockService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('ensure')
  async ensure(@Body() dto: EnsureLiveBlockDto, @AuthUser() user: User) {
    return this.liveBlockService.ensure(dto, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('clone')
  async clone(@Body() dto: CloneLiveBlockDto, @AuthUser() user: User) {
    return this.liveBlockService.clone(dto, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('snapshot')
  async snapshot(@Body() dto: LiveBlockSnapshotDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId, {
      includeContent: true,
    });
    if (!page || page.workspaceId !== user.workspaceId) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanView(page, user);
    return this.liveBlockService.getSnapshot(dto.blockId, page);
  }
}
