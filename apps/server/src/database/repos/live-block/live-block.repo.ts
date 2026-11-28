import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import { InsertableLiveBlock, LiveBlock } from '@docmost/db/types/entity.types';
import { Json } from '@docmost/db/types/db';

type FindOpts = {
  /** Only a row of this workspace is found. */
  workspaceId?: string;
  includeYdoc?: boolean;
  includeSnapshot?: boolean;
  trx?: KyselyTransaction;
};

@Injectable()
export class LiveBlockRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  private baseFields: Array<keyof LiveBlock> = [
    'id',
    'kind',
    'pageId',
    'workspaceId',
    'snapshotError',
    'creatorId',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ];

  private fields(opts?: FindOpts): Array<keyof LiveBlock> {
    const fields = [...this.baseFields];
    if (opts?.includeYdoc) fields.push('ydoc');
    if (opts?.includeSnapshot) fields.push('snapshot');
    return fields;
  }

  async findById(id: string, opts?: FindOpts): Promise<LiveBlock | undefined> {
    let query = dbOrTx(this.db, opts?.trx)
      .selectFrom('liveBlocks')
      .select(this.fields(opts))
      .where('id', '=', id)
      .where('deletedAt', 'is', null);
    if (opts?.workspaceId)
      query = query.where('workspaceId', '=', opts.workspaceId);
    return query.executeTakeFirst() as Promise<LiveBlock | undefined>;
  }

  async findByPageIds(
    pageIds: string[],
    opts?: FindOpts,
  ): Promise<LiveBlock[]> {
    if (pageIds.length === 0) return [];
    return dbOrTx(this.db, opts?.trx)
      .selectFrom('liveBlocks')
      .select(this.fields(opts))
      .where('pageId', 'in', pageIds)
      .where('deletedAt', 'is', null)
      .execute() as Promise<LiveBlock[]>;
  }

  /**
   * Two callers racing on one id both get the row back, neither gets an error.
   * Only a row of the block's own workspace is returned: an id taken in
   * another workspace answers undefined, which callers treat like any clash.
   */
  async insertIfAbsent(
    block: InsertableLiveBlock,
    trx?: KyselyTransaction,
  ): Promise<LiveBlock | undefined> {
    const db = dbOrTx(this.db, trx);
    await db
      .insertInto('liveBlocks')
      .values(block)
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    return db
      .selectFrom('liveBlocks')
      .select(this.baseFields)
      .where('id', '=', block.id)
      .where('workspaceId', '=', block.workspaceId)
      .executeTakeFirst() as Promise<LiveBlock | undefined>;
  }

  /** Inserts a row with a new id; false when the id already exists (anywhere). */
  async insertNew(
    block: InsertableLiveBlock,
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    const row = await dbOrTx(this.db, trx)
      .insertInto('liveBlocks')
      .values(block)
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  /** Writes only when the row has no document yet; true when it wrote. */
  async seedIfEmpty(
    id: string,
    ydoc: Buffer,
    snapshot: unknown,
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    const result = await dbOrTx(this.db, trx)
      .updateTable('liveBlocks')
      .set({
        ydoc,
        snapshot: snapshot as Json,
        snapshotError: null,
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .where('ydoc', 'is', null)
      .executeTakeFirst();
    return Number(result?.numUpdatedRows ?? 0) > 0;
  }

  async saveYdoc(
    id: string,
    ydoc: Buffer,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('liveBlocks')
      .set({ ydoc, updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async softDelete(id: string, trx?: KyselyTransaction): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('liveBlocks')
      .set({ deletedAt: new Date() })
      .where('id', '=', id)
      .where('deletedAt', 'is', null)
      .execute();
  }

  /** A null snapshot keeps the stored one and records only the error. */
  async saveSnapshot(
    id: string,
    snapshot: unknown | null,
    error: string | null,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const set =
      snapshot === null
        ? { snapshotError: error }
        : { snapshot: snapshot as Json, snapshotError: error };
    await dbOrTx(this.db, trx)
      .updateTable('liveBlocks')
      .set(set)
      .where('id', '=', id)
      .execute();
  }

  /**
   * Writes a snapshot rebuilt from the stored document, only while that
   * document is still the stored one, and clears the build error.
   */
  async saveRebuiltSnapshot(
    id: string,
    snapshot: unknown,
    ydocUpdatedAt: Date,
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    const result = await dbOrTx(this.db, trx)
      .updateTable('liveBlocks')
      .set({ snapshot: snapshot as Json, snapshotError: null })
      .where('id', '=', id)
      // updated_at keeps microseconds (now()); the Date read back keeps
      // milliseconds, so an exact compare would never match a default value
      .where(
        sql`date_trunc('milliseconds', ${sql.ref('updatedAt')})`,
        '=',
        ydocUpdatedAt,
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }
}
