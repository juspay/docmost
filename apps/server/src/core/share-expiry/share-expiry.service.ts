import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ShareExpiryRepo } from '@docmost/db/repos/share/share-expiry.repo';
import { KyselyTransaction } from '@docmost/db/types/kysely.types';
import { ShareExpiryRow, User } from '@docmost/db/types/entity.types';

export const SHARE_PERIOD_DAYS = [1, 7, 30] as const;
export type SharePeriodDays = (typeof SHARE_PERIOD_DAYS)[number];

export type ShareExpiry = {
  expiresAt: Date;
  periodDays: SharePeriodDays;
  expired: boolean;
};

const DAY_MS = 86_400_000;
const DEFAULT_ATTACHMENT_TOKEN_SECONDS = 3600;

/**
 * The body is exactly code, message and the requested page's slug id: it
 * carries no title, date or share key, so an anonymous visitor learns nothing
 * beyond "this page once had a link".
 */
export class ShareExpiredException extends NotFoundException {
  constructor(pageSlugId: string) {
    super({
      code: 'SHARE_EXPIRED',
      message: 'This link has expired',
      pageSlugId,
    });
  }
}

function isPeriod(value: unknown): value is SharePeriodDays {
  return (SHARE_PERIOD_DAYS as readonly unknown[]).includes(value);
}

@Injectable()
export class ShareExpiryService {
  constructor(private readonly shareExpiryRepo: ShareExpiryRepo) {}

  private toExpiry(row: ShareExpiryRow, now: Date): ShareExpiry {
    const expiresAt = new Date(row.expiresAt);
    return {
      expiresAt,
      periodDays: row.periodDays as SharePeriodDays,
      expired: expiresAt.getTime() <= now.getTime(),
    };
  }

  async get(shareId: string, now = new Date()): Promise<ShareExpiry | null> {
    const [row] = await this.shareExpiryRepo.findByShareIds([shareId]);
    return row ? this.toExpiry(row, now) : null;
  }

  async getMany(
    shareIds: string[],
    now = new Date(),
  ): Promise<Map<string, ShareExpiry>> {
    const rows = await this.shareExpiryRepo.findByShareIds(shareIds);
    return new Map(rows.map((row) => [row.shareId, this.toExpiry(row, now)]));
  }

  // A share with no row never expires.
  async isUsable(shareId: string, now = new Date()): Promise<boolean> {
    const expiry = await this.get(shareId, now);
    return !expiry || !expiry.expired;
  }

  async set(
    shareId: string,
    periodDays: SharePeriodDays | null,
    user: User,
  ): Promise<ShareExpiry | null> {
    if (periodDays === null) {
      await this.shareExpiryRepo.delete(shareId);
      return null;
    }
    if (!isPeriod(periodDays)) {
      throw new BadRequestException('Invalid expiry period');
    }

    const now = new Date();
    const row = await this.shareExpiryRepo.upsert({
      shareId,
      workspaceId: user.workspaceId,
      expiresAt: new Date(now.getTime() + periodDays * DAY_MS),
      periodDays,
      updatedById: user.id,
    });
    return this.toExpiry(row, now);
  }

  // Used by the mindspace import, which keeps each link's original date.
  async setExact(
    shareId: string,
    expiresAt: Date,
    periodDays: SharePeriodDays,
    userId: string,
    trx: KyselyTransaction,
  ): Promise<ShareExpiry> {
    if (!trx) {
      throw new Error('setExact needs a transaction');
    }
    if (!isPeriod(periodDays)) {
      throw new BadRequestException('Invalid expiry period');
    }
    const [existing] = await trx
      .selectFrom('shares')
      .select('workspaceId')
      .where('id', '=', shareId)
      .execute();
    if (!existing) {
      throw new NotFoundException('Share not found');
    }

    const row = await this.shareExpiryRepo.upsert(
      {
        shareId,
        workspaceId: existing.workspaceId,
        expiresAt,
        periodDays,
        updatedById: userId,
      },
      trx,
    );
    return this.toExpiry(row, new Date());
  }

  async renew(shareId: string, user: User): Promise<ShareExpiry> {
    const current = await this.get(shareId);
    if (!current) {
      throw new BadRequestException('This link has no expiry to renew');
    }
    const now = new Date();
    const row = await this.shareExpiryRepo.upsert({
      shareId,
      workspaceId: user.workspaceId,
      expiresAt: new Date(now.getTime() + current.periodDays * DAY_MS),
      periodDays: current.periodDays,
      updatedById: user.id,
    });
    return this.toExpiry(row, now);
  }

  /**
   * Seconds an attachment token for this share may live: the default hour, cut
   * short so a file link never outlives the page link. undefined when the share
   * has no expiry, so those tokens stay exactly as before.
   */
  async attachmentTokenLifetime(
    shareId: string,
    now = new Date(),
  ): Promise<number | undefined> {
    const expiry = await this.get(shareId, now);
    return expiry ? lifetimeUntil(expiry.expiresAt, now) : undefined;
  }
}

export function lifetimeUntil(expiresAt: Date, now: Date): number {
  const seconds = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
  return Math.max(1, Math.min(DEFAULT_ATTACHMENT_TOKEN_SECONDS, seconds));
}
