import {
  CamelCasePlugin,
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { AccessTokenRepo } from './access-token.repo';

describe('AccessTokenRepo.insert', () => {
  // each query takes the next queued answer; an empty queue answers with no rows
  function makeRepo(answers: any[][]) {
    const queries: string[] = [];
    const driver = new DummyDriver();
    driver.acquireConnection = async () =>
      ({
        executeQuery: async (q: CompiledQuery) => {
          queries.push(q.sql);
          return { rows: answers.shift() ?? [] };
        },
        streamQuery: async function* () {},
      }) as any;
    driver.beginTransaction = async () => {
      queries.push('begin');
    };
    driver.commitTransaction = async () => {
      queries.push('commit');
    };
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver,
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      plugins: [new CamelCasePlugin()],
    });
    return { repo: new AccessTokenRepo(db as any), queries };
  }

  const values: any = {
    userId: 'u1',
    workspaceId: 'ws1',
    name: 'n',
    tokenHash: 'h',
    tokenPrefix: 'dmp_12345678',
    scope: 'read',
  };

  it('counts and inserts inside one transaction, under a per-user lock', async () => {
    const { repo, queries } = makeRepo([
      [],
      [{ count: '3' }],
      [{ id: 'tok-1' }],
    ]);
    expect(await repo.insert(values, 20)).toEqual({ id: 'tok-1' });
    expect(queries[0]).toBe('begin');
    expect(queries[1]).toMatch(/pg_advisory_xact_lock/);
    expect(queries[2]).toMatch(/count\(\*\)/);
    expect(queries[3]).toMatch(/^insert into "personal_access_tokens"/);
    expect(queries[4]).toBe('commit');
  });

  it('inserts nothing when the user already has the maximum', async () => {
    const { repo, queries } = makeRepo([[], [{ count: '20' }]]);
    expect(await repo.insert(values, 20)).toBeNull();
    expect(queries.some((q) => /^insert/.test(q))).toBe(false);
  });
});
