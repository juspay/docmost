import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { v7 as uuid7 } from 'uuid';
import { nanoIdGen } from '../../../common/helpers';
import { LiveBlockRepo } from './live-block.repo';

// Runs against real PostgreSQL. Set LIVE_BLOCK_TEST_DATABASE_URL to a migrated
// throwaway database; every row is written in a transaction that is rolled back.
const configuredUrl = process.env.LIVE_BLOCK_TEST_DATABASE_URL;
const databaseUrl =
  configuredUrl && /test|_p\d+/.test(new URL(configuredUrl).pathname)
    ? configuredUrl
    : undefined;

class Rollback extends Error {}

// a real database on a loaded machine can be slow to answer
jest.setTimeout(60_000);

(databaseUrl ? describe : describe.skip)(
  'LiveBlockRepo.saveRebuiltSnapshot against PostgreSQL',
  () => {
    let db: Kysely<any>;

    beforeAll(() => {
      db = new Kysely<any>({
        dialect: new PostgresJSDialect({
          postgres: postgres(databaseUrl, { max: 1 }),
        }),
        plugins: [new CamelCasePlugin()],
      });
    });
    afterAll(() => db.destroy());

    async function withBlock(
      body: (repo: LiveBlockRepo, blockId: string, trx: any) => Promise<void>,
    ) {
      await db
        .transaction()
        .execute(async (trx) => {
          const { id: workspaceId } = await trx
            .insertInto('workspaces')
            .values({ name: 'live-block-test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const { id: spaceId } = await trx
            .insertInto('spaces')
            .values({ slug: 'lb', workspaceId })
            .returning('id')
            .executeTakeFirstOrThrow();
          const { id: pageId } = await trx
            .insertInto('pages')
            .values({ slugId: nanoIdGen(), spaceId, workspaceId })
            .returning('id')
            .executeTakeFirstOrThrow();
          const repo = new LiveBlockRepo(trx as any);
          const blockId = uuid7();
          // like a copy: updated_at comes from the column default, now()
          await repo.insertNew({
            id: blockId,
            kind: 'sheet',
            pageId,
            workspaceId,
            snapshot: { kind: 'sheet', truncated: true } as any,
            snapshotError: 'budget exceeded',
          });
          await body(repo, blockId, trx);
          throw new Rollback();
        })
        .catch((err) => {
          if (!(err instanceof Rollback)) throw err;
        });
    }

    it('saves a rebuild of the document it read, even with a default updated_at', async () => {
      await withBlock(async (repo, blockId) => {
        const row = await repo.findById(blockId);
        const saved = await repo.saveRebuiltSnapshot(
          blockId,
          { kind: 'sheet', truncated: false },
          row.updatedAt,
        );
        expect(saved).toBe(true);
        const after = await repo.findById(blockId, { includeSnapshot: true });
        expect(after.snapshotError).toBeNull();
        expect(after.snapshot).toEqual({ kind: 'sheet', truncated: false });
      });
    });

    it('does not save over a document stored after the read', async () => {
      await withBlock(async (repo, blockId) => {
        const row = await repo.findById(blockId);
        await repo.saveYdoc(blockId, Buffer.from([0, 0]));
        const saved = await repo.saveRebuiltSnapshot(
          blockId,
          { kind: 'sheet', truncated: false },
          row.updatedAt,
        );
        expect(saved).toBe(false);
      });
    });
  },
);
