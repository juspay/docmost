import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import { ShareExpiryRow } from '@docmost/db/types/entity.types';

@Injectable()
export class ShareExpiryRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByShareIds(shareIds: string[]): Promise<ShareExpiryRow[]> {
    if (shareIds.length === 0) return [];
    return this.db
      .selectFrom('shareExpiries')
      .selectAll()
      .where('shareId', 'in', shareIds)
      .execute();
  }

  async upsert(
    row: {
      shareId: string;
      workspaceId: string;
      expiresAt: Date;
      periodDays: number;
      updatedById: string;
    },
    trx?: KyselyTransaction,
  ): Promise<ShareExpiryRow> {
    return dbOrTx(this.db, trx)
      .insertInto('shareExpiries')
      .values(row)
      .onConflict((oc) =>
        oc.column('shareId').doUpdateSet({
          expiresAt: row.expiresAt,
          periodDays: row.periodDays,
          updatedById: row.updatedById,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async delete(shareId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('shareExpiries')
      .where('shareId', '=', shareId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
