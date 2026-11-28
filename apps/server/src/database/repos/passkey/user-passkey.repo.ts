import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import {
  InsertableUserPasskey,
  UserPasskey,
} from '@docmost/db/types/entity.types';

@Injectable()
export class UserPasskeyRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async insert(
    passkey: InsertableUserPasskey,
    trx?: KyselyTransaction,
  ): Promise<UserPasskey> {
    return dbOrTx(this.db, trx)
      .insertInto('userPasskeys')
      .values(passkey)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findByCredentialId(
    credentialId: string,
    workspaceId: string,
  ): Promise<UserPasskey | undefined> {
    return this.db
      .selectFrom('userPasskeys')
      .selectAll()
      .where('credentialId', '=', credentialId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async findById(
    id: string,
    userId: string,
    workspaceId: string,
  ): Promise<UserPasskey | undefined> {
    return this.db
      .selectFrom('userPasskeys')
      .selectAll()
      .where('id', '=', id)
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async findByUser(
    userId: string,
    workspaceId: string,
  ): Promise<UserPasskey[]> {
    return this.db
      .selectFrom('userPasskeys')
      .selectAll()
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  async recordUse(id: string, counter: number): Promise<void> {
    await this.db
      .updateTable('userPasskeys')
      .set({ counter, lastUsedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async rename(
    id: string,
    userId: string,
    workspaceId: string,
    name: string,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('userPasskeys')
      .set({ name })
      .where('id', '=', id)
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async delete(
    id: string,
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const result = await this.db
      .deleteFrom('userPasskeys')
      .where('id', '=', id)
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async deleteAllForUser(
    userId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<number> {
    const result = await dbOrTx(this.db, trx)
      .deleteFrom('userPasskeys')
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
