import {
  InsertablePersonalAccessToken,
  PersonalAccessToken,
} from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';

// Columns safe to return to a browser: never token_hash.
const PUBLIC_COLUMNS = [
  'id',
  'userId',
  'workspaceId',
  'name',
  'tokenPrefix',
  'scope',
  'expiresAt',
  'lastUsedAt',
  'revokedAt',
  'createdAt',
] as const;

@Injectable()
export class AccessTokenRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * Inserts unless the user already has `maxActive` live tokens; null then.
   * The count and the insert share one transaction under a per-user lock, so
   * concurrent creates cannot pass the cap together.
   */
  async insert(
    values: InsertablePersonalAccessToken,
    maxActive: number,
  ): Promise<Omit<PersonalAccessToken, 'tokenHash'> | null> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`pat:${values.userId}`}))`.execute(
        trx,
      );
      const row = await trx
        .selectFrom('personalAccessTokens')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('userId', '=', values.userId)
        .where('workspaceId', '=', values.workspaceId)
        .where('revokedAt', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(row.count) >= maxActive) return null;
      return trx
        .insertInto('personalAccessTokens')
        .values(values)
        .returning([...PUBLIC_COLUMNS])
        .executeTakeFirstOrThrow();
    });
  }

  async findByHash(
    tokenHash: string,
  ): Promise<PersonalAccessToken | undefined> {
    return this.db
      .selectFrom('personalAccessTokens')
      .selectAll()
      .where('tokenHash', '=', tokenHash)
      .executeTakeFirst();
  }

  async listByUser(userId: string, workspaceId: string) {
    return this.db
      .selectFrom('personalAccessTokens')
      .select([...PUBLIC_COLUMNS])
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('revokedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  async findOwned(id: string, userId: string, workspaceId: string) {
    return this.db
      .selectFrom('personalAccessTokens')
      .select([...PUBLIC_COLUMNS])
      .where('id', '=', id)
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async revoke(id: string): Promise<void> {
    await this.db
      .updateTable('personalAccessTokens')
      .set({ revokedAt: new Date() })
      .where('id', '=', id)
      .where('revokedAt', 'is', null)
      .execute();
  }

  /** Revokes every live token of the user; returns how many. */
  async revokeAllForUser(
    userId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<number> {
    const result = await dbOrTx(this.db, trx)
      .updateTable('personalAccessTokens')
      .set({ revokedAt: new Date() })
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('revokedAt', 'is', null)
      .executeTakeFirst();
    return Number(result?.numUpdatedRows ?? 0);
  }

  // The SQL condition keeps concurrent requests from writing twice in a minute.
  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .updateTable('personalAccessTokens')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', id)
      .where((eb) =>
        eb.or([
          eb('lastUsedAt', 'is', null),
          eb('lastUsedAt', '<', sql<Date>`now() - interval '1 minute'`),
        ]),
      )
      .execute();
  }
}
