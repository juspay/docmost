import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import {
  DbImportMap,
  DryRunImportMap,
  ImportMap,
  MemoryImportMap,
  targetId,
} from './import-map';

// DbImportMap runs against a real, migrated docmost database when
// MINDSPACE_IMPORT_TEST_DATABASE_URL is set; every row is rolled back.
const databaseUrl = process.env.MINDSPACE_IMPORT_TEST_DATABASE_URL;

class Rollback extends Error {}

function contract(
  name: string,
  withMap: (body: (map: ImportMap) => Promise<void>) => Promise<void>,
) {
  describe(name, () => {
    it('MemoryImportMap and DbImportMap behave the same for get, set and all', () =>
      withMap(async (map) => {
        expect(await map.get('project', 'p1')).toBeUndefined();
        expect(await map.all('project')).toEqual([]);

        const a = targetId(
          '00000000-0000-4000-8000-000000000001',
          'project',
          'p1',
        );
        const b = targetId(
          '00000000-0000-4000-8000-000000000001',
          'project',
          'p2',
        );
        await map.set('project', 'p1', 'page', a);
        await map.set('project', 'p2', 'page', b);
        await map.set('document', 'p1', 'page', b); // same source id, other type

        expect(await map.get('project', 'p1')).toBe(a);
        expect(await map.get('document', 'p1')).toBe(b);
        // the first writer wins; a second set does not move an entry
        await map.set('project', 'p1', 'page', b);
        expect(await map.get('project', 'p1')).toBe(a);

        expect(await map.all('project')).toEqual([
          { sourceId: 'p1', targetId: a },
          { sourceId: 'p2', targetId: b },
        ]);
        expect(await map.all('comment')).toEqual([]);
      }));
  });
}

contract('MemoryImportMap', async (body) => body(new MemoryImportMap()));

const dbContract: typeof contract = databaseUrl
  ? contract
  : (name) =>
      describe.skip(name, () =>
        it('needs MINDSPACE_IMPORT_TEST_DATABASE_URL', () => undefined),
      );

dbContract('DbImportMap against PostgreSQL', async (body) => {
  const db = new Kysely<any>({
    dialect: new PostgresJSDialect({
      postgres: postgres(databaseUrl, { max: 1 }),
    }),
    plugins: [new CamelCasePlugin()],
  });
  try {
    await db
      .transaction()
      .execute(async (trx) => {
        const { id } = await trx
          .insertInto('workspaces')
          .values({ name: 'import-map-test' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await body(new DbImportMap(trx as any, id));
        throw new Rollback();
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });
  } finally {
    await db.destroy();
  }
});

describe('targetId', () => {
  const ws1 = '11111111-1111-4111-8111-111111111111';
  const ws2 = '22222222-2222-4222-8222-222222222222';

  it('targetId is the same for the same inputs and differs across workspaces', () => {
    const id = targetId(ws1, 'project', 'abc');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(targetId(ws1, 'project', 'abc')).toBe(id);
    expect(targetId(ws1.toUpperCase(), 'project', 'ABC')).toBe(id);
    expect(targetId(ws2, 'project', 'abc')).not.toBe(id);
    expect(targetId(ws1, 'block', 'abc')).not.toBe(id);
    expect(targetId(ws1, 'project', 'abd')).not.toBe(id);
  });
});

describe('DryRunImportMap', () => {
  it('sees the entries of earlier runs and keeps its own in memory', async () => {
    const base = new MemoryImportMap();
    await base.set('project', 'old', 'page', 'id-old');
    const dry = new DryRunImportMap(base);
    await dry.set('project', 'new', 'page', 'id-new');
    expect(await dry.get('project', 'old')).toBe('id-old');
    expect(await dry.get('project', 'new')).toBe('id-new');
    expect(await base.get('project', 'new')).toBeUndefined();
    expect(await dry.all('project')).toEqual([
      { sourceId: 'new', targetId: 'id-new' },
      { sourceId: 'old', targetId: 'id-old' },
    ]);
  });
});
