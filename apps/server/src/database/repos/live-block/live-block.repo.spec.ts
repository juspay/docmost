import {
  CamelCasePlugin,
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { LiveBlockRepo } from './live-block.repo';

const BLOCK_ID = '019a1f00-0000-7000-8000-000000000031';
const PAGE_ID = '019a1f00-0000-7000-8000-000000000032';
const WORKSPACE_ID = '019a1f00-0000-7000-8000-000000000033';

describe('LiveBlockRepo', () => {
  // each query takes the next queued answer; an empty queue answers with no rows
  function makeRepo(answers: any[][] = []) {
    const queries: CompiledQuery[] = [];
    const driver = new DummyDriver();
    driver.acquireConnection = async () =>
      ({
        executeQuery: async () => ({ rows: answers.shift() ?? [] }),
        streamQuery: async function* () {},
      }) as any;
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver,
        createIntrospector: (kysely) => new PostgresIntrospector(kysely),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      plugins: [new CamelCasePlugin()],
      log: (event) => {
        if (event.level === 'query') queries.push(event.query);
      },
    });
    return { repo: new LiveBlockRepo(db as any), queries };
  }

  it('findById filters deleted rows and omits ydoc and snapshot by default', async () => {
    const { repo, queries } = makeRepo();
    await repo.findById(BLOCK_ID);
    const sql = queries[0].sql;
    expect(sql).toMatch(/"deleted_at" is null/);
    expect(sql).not.toMatch(/"ydoc"/);
    expect(sql).not.toMatch(/"snapshot"[^_]/);
    expect(queries[0].parameters).toContain(BLOCK_ID);
  });

  it('findById selects ydoc and snapshot when asked', async () => {
    const { repo, queries } = makeRepo();
    await repo.findById(BLOCK_ID, { includeYdoc: true, includeSnapshot: true });
    expect(queries[0].sql).toMatch(/"ydoc"/);
    expect(queries[0].sql).toMatch(/"snapshot",|"snapshot" from/);
  });

  it('findByPageIds returns nothing without a query for an empty list', async () => {
    const { repo, queries } = makeRepo();
    expect(await repo.findByPageIds([])).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('findByPageIds filters deleted rows', async () => {
    const { repo, queries } = makeRepo();
    await repo.findByPageIds([PAGE_ID]);
    expect(queries[0].sql).toMatch(/"page_id" in \(\$1\)/);
    expect(queries[0].sql).toMatch(/"deleted_at" is null/);
  });

  it('insertIfAbsent returns the existing row on a conflict', async () => {
    const existing = { id: BLOCK_ID, kind: 'whiteboard', pageId: PAGE_ID };
    // the insert does nothing, the read-back finds the row
    const { repo, queries } = makeRepo([[], [existing]]);
    const row = await repo.insertIfAbsent({
      id: BLOCK_ID,
      kind: 'whiteboard',
      pageId: PAGE_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(row).toEqual(existing);
    expect(queries[0].sql).toMatch(/on conflict \("id"\) do nothing/);
    expect(queries[1].sql).toMatch(/^select/);
  });

  it('seedIfEmpty only writes a row whose ydoc is null', async () => {
    const { repo, queries } = makeRepo([[], []]);
    queries.length = 0;
    const wrote = await repo.seedIfEmpty(BLOCK_ID, Buffer.from([1]), {
      kind: 'whiteboard',
    });
    expect(queries[0].sql).toMatch(/where "id" = \$\d+ and "ydoc" is null/);
    expect(wrote).toBe(false);
  });

  it('softDelete sets deleted_at on a live row only', async () => {
    const { repo, queries } = makeRepo();
    await repo.softDelete(BLOCK_ID);
    expect(queries[0].sql).toMatch(/^update "live_blocks" set "deleted_at" = /);
    expect(queries[0].sql).toMatch(/"deleted_at" is null/);
    expect(queries[0].parameters).toContain(BLOCK_ID);
  });

  it('saveYdoc also sets updated_at', async () => {
    const { repo, queries } = makeRepo();
    await repo.saveYdoc(BLOCK_ID, Buffer.from([1, 2]));
    expect(queries[0].sql).toMatch(/set "ydoc" = \$1, "updated_at" = \$2/);
  });

  it('saveSnapshot with null leaves the snapshot column out of the update', async () => {
    const { repo, queries } = makeRepo();
    await repo.saveSnapshot(BLOCK_ID, null, 'broken');
    expect(queries[0].sql).not.toMatch(/"snapshot" =/);
    expect(queries[0].sql).toMatch(/"snapshot_error" = \$1/);
    expect(queries[0].parameters[0]).toBe('broken');
  });

  it('saveSnapshot with a snapshot stores it and clears the error', async () => {
    const { repo, queries } = makeRepo();
    await repo.saveSnapshot(BLOCK_ID, { kind: 'whiteboard' }, null);
    expect(queries[0].sql).toMatch(/"snapshot" = \$1, "snapshot_error" = \$2/);
    expect(queries[0].parameters[1]).toBeNull();
  });
});
