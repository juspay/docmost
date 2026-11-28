import { v5 as uuidv5 } from 'uuid';
import type {
  KyselyDB,
  KyselyTransaction,
} from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';

/**
 * `link` is a project's public link: a second entry for the same project id,
 * so it needs its own source type.
 */
export type SourceType =
  | 'user'
  | 'workspace'
  | 'project'
  | 'document'
  | 'comment'
  | 'link'
  /** a space membership granted from a project share */
  | 'grant';

export interface ImportMap {
  get(type: SourceType, sourceId: string): Promise<string | undefined>;
  /**
   * `trx` puts the entry in the same transaction as the row it points to.
   * An existing entry keeps its target; with `rewritten` it is held to the
   * source again (verified_at cleared), in that same transaction.
   */
  set(
    type: SourceType,
    sourceId: string,
    targetType: string,
    targetId: string,
    trx?: KyselyTransaction,
    rewritten?: boolean,
  ): Promise<void>;
  all(type: SourceType): Promise<{ sourceId: string; targetId: string }[]>;
  /** Whether the item has passed verification in some run. */
  verified(type: SourceType, sourceId: string): Promise<boolean>;
  /** A run wrote to the item again: hold it to the source until it passes again. */
  unverify(
    type: SourceType,
    sourceId: string,
    trx?: KyselyTransaction,
  ): Promise<void>;
  /** Records that these items passed verification now. */
  markVerified(items: { type: SourceType; sourceId: string }[]): Promise<void>;
}

/** Fixed for the life of the tool: changing it would make every id new. */
export const MINDSPACE_IMPORT_NAMESPACE =
  '5f0b8a4e-3c1d-4e7a-9b26-6d5c2e9f1a73';

export function targetId(
  workspaceId: string,
  type: SourceType | 'block' | 'share' | 'attachment',
  sourceId: string,
): string {
  return uuidv5(
    `${workspaceId.toLowerCase()}:${type}:${sourceId.toLowerCase()}`,
    MINDSPACE_IMPORT_NAMESPACE,
  );
}

export class MemoryImportMap implements ImportMap {
  private readonly entries = new Map<string, Map<string, string>>();
  private readonly passed = new Set<string>();

  async verified(type: SourceType, sourceId: string) {
    return this.passed.has(`${type}:${sourceId}`);
  }

  async unverify(type: SourceType, sourceId: string) {
    this.passed.delete(`${type}:${sourceId}`);
  }

  async markVerified(items: { type: SourceType; sourceId: string }[]) {
    for (const i of items)
      if (await this.get(i.type, i.sourceId))
        this.passed.add(`${i.type}:${i.sourceId}`);
  }

  async get(type: SourceType, sourceId: string) {
    return this.entries.get(type)?.get(sourceId);
  }

  async set(
    type: SourceType,
    sourceId: string,
    _targetType: string,
    id: string,
    _trx?: KyselyTransaction,
    rewritten?: boolean,
  ) {
    if (rewritten) this.passed.delete(`${type}:${sourceId}`);
    let byType = this.entries.get(type);
    if (!byType) this.entries.set(type, (byType = new Map()));
    if (!byType.has(sourceId)) byType.set(sourceId, id);
  }

  async all(type: SourceType) {
    return [...(this.entries.get(type) ?? new Map<string, string>())]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([sourceId, id]) => ({ sourceId, targetId: id }));
  }
}

/**
 * A dry run sees what earlier real runs imported, and keeps its own entries
 * in memory.
 */
export class DryRunImportMap implements ImportMap {
  private readonly memory = new MemoryImportMap();

  constructor(private readonly base: ImportMap) {}

  async verified(type: SourceType, sourceId: string) {
    if (this.touched.has(`${type}:${sourceId}`)) return false;
    return this.base.verified(type, sourceId);
  }

  /** A dry run proves nothing about what a real run will write. */
  async markVerified() {}

  /** Nothing is written in a dry run; verify still holds what this run touched. */
  async unverify(type: SourceType, sourceId: string) {
    this.touched.add(`${type}:${sourceId}`);
  }

  readonly touched = new Set<string>();

  async get(type: SourceType, sourceId: string) {
    return (
      (await this.base.get(type, sourceId)) ??
      (await this.memory.get(type, sourceId))
    );
  }

  async set(
    type: SourceType,
    sourceId: string,
    targetType: string,
    id: string,
    _trx?: KyselyTransaction,
    rewritten?: boolean,
  ) {
    if (rewritten) this.touched.add(`${type}:${sourceId}`);
    await this.memory.set(type, sourceId, targetType, id);
  }

  async all(type: SourceType) {
    const out = new Map(
      (await this.base.all(type)).map((e) => [e.sourceId, e.targetId]),
    );
    for (const e of await this.memory.all(type))
      if (!out.has(e.sourceId)) out.set(e.sourceId, e.targetId);
    return [...out]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([sourceId, id]) => ({ sourceId, targetId: id }));
  }
}

/** The mindspace_import_map table, scoped to one docmost workspace. */
export class DbImportMap implements ImportMap {
  constructor(
    private readonly db: KyselyDB,
    private readonly workspaceId: string,
  ) {}

  async get(type: SourceType, sourceId: string) {
    const row = await this.db
      .selectFrom('mindspaceImportMap')
      .select('targetId')
      .where('sourceType', '=', type)
      .where('sourceId', '=', sourceId)
      .where('workspaceId', '=', this.workspaceId)
      .executeTakeFirst();
    return row?.targetId;
  }

  async set(
    type: SourceType,
    sourceId: string,
    targetType: string,
    id: string,
    trx?: KyselyTransaction,
    rewritten?: boolean,
  ) {
    await dbOrTx(this.db, trx)
      .insertInto('mindspaceImportMap')
      .values({
        sourceType: type,
        sourceId,
        targetType,
        targetId: id,
        workspaceId: this.workspaceId,
      })
      // first writer wins, as in MemoryImportMap; a rewrite re-holds the item
      .onConflict((oc) =>
        rewritten
          ? oc
              .columns(['sourceType', 'sourceId', 'workspaceId'])
              .doUpdateSet({ verifiedAt: null })
          : oc.columns(['sourceType', 'sourceId', 'workspaceId']).doNothing(),
      )
      .execute();
  }

  async verified(type: SourceType, sourceId: string) {
    const row = await this.db
      .selectFrom('mindspaceImportMap')
      .select('verifiedAt')
      .where('sourceType', '=', type)
      .where('sourceId', '=', sourceId)
      .where('workspaceId', '=', this.workspaceId)
      .executeTakeFirst();
    return !!row?.verifiedAt;
  }

  async unverify(type: SourceType, sourceId: string, trx?: KyselyTransaction) {
    await dbOrTx(this.db, trx)
      .updateTable('mindspaceImportMap')
      .set({ verifiedAt: null })
      .where('sourceType', '=', type)
      .where('sourceId', '=', sourceId)
      .where('workspaceId', '=', this.workspaceId)
      .where('verifiedAt', 'is not', null)
      .execute();
  }

  async markVerified(items: { type: SourceType; sourceId: string }[]) {
    const now = new Date();
    for (const type of new Set(items.map((i) => i.type))) {
      const ids = items.filter((i) => i.type === type).map((i) => i.sourceId);
      for (let i = 0; i < ids.length; i += 1000) {
        await this.db
          .updateTable('mindspaceImportMap')
          .set({ verifiedAt: now })
          .where('sourceType', '=', type)
          .where('sourceId', 'in', ids.slice(i, i + 1000))
          .where('workspaceId', '=', this.workspaceId)
          .execute();
      }
    }
  }

  async all(type: SourceType) {
    return this.db
      .selectFrom('mindspaceImportMap')
      .select(['sourceId', 'targetId'])
      .where('sourceType', '=', type)
      .where('workspaceId', '=', this.workspaceId)
      .orderBy('sourceId')
      .execute();
  }
}
