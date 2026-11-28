import {
  CamelCasePlugin,
  CompiledQuery,
  DatabaseConnection,
  Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  QueryResult,
} from 'kysely';
import type { KyselyDB } from '@docmost/db/types/kysely.types';

export type Statement = {
  sql: string;
  parameters: readonly unknown[];
  tx: number | null;
};

export type Responder = (q: Statement) => unknown[] | Error | undefined;

/**
 * A Kysely database that runs nothing. It records every statement with the
 * transaction it ran in, answers selects through `respond`, and records
 * begin, commit and rollback.
 */
export class RecordingDb {
  readonly statements: Statement[] = [];
  readonly events: string[] = [];
  respond: Responder = () => undefined;
  private nextTx = 0;
  readonly db: KyselyDB;

  constructor() {
    const self = this;
    class Connection implements DatabaseConnection {
      tx: number | null = null;
      async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
        const statement = {
          sql: compiled.sql,
          parameters: compiled.parameters,
          tx: this.tx,
        };
        self.statements.push(statement);
        const answer = self.respond(statement);
        if (answer instanceof Error) throw answer;
        const rows = (answer ?? []) as R[];
        return { rows, numAffectedRows: BigInt(rows.length || 1) };
      }
      // eslint-disable-next-line require-yield
      async *streamQuery(): AsyncIterableIterator<QueryResult<never>> {
        throw new Error('not supported');
      }
    }
    class RecordingDriver implements Driver {
      async init() {}
      async acquireConnection() {
        return new Connection();
      }
      async beginTransaction(conn: Connection) {
        conn.tx = ++self.nextTx;
        self.events.push(`begin ${conn.tx}`);
      }
      async commitTransaction(conn: Connection) {
        self.events.push(`commit ${conn.tx}`);
        conn.tx = null;
      }
      async rollbackTransaction(conn: Connection) {
        self.events.push(`rollback ${conn.tx}`);
        conn.tx = null;
      }
      async releaseConnection() {}
      async destroy() {}
    }
    this.db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new RecordingDriver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      plugins: [new CamelCasePlugin()],
    }) as unknown as KyselyDB;
  }

  writes(): Statement[] {
    return this.statements.filter((s) =>
      /^\s*(insert|update|delete)/i.test(s.sql),
    );
  }

  writesTo(table: string): Statement[] {
    return this.writes().filter((s) => s.sql.includes(`"${table}"`));
  }
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/**
 * A RecordingDb that answers like a docmost database holding one workspace
 * and its people, and remembers rows inserted by id and map entries.
 */
export function docmostLike(
  users: { email: string }[],
  workspace: { id: string; name: string },
): RecordingDb {
  const rec = new RecordingDb();
  const mapRows = new Map<string, string>();
  const rows = new Map<string, Record<string, unknown>>();
  rec.respond = (q) => {
    if (/to_regclass/.test(q.sql)) return [{ exists: true, column: true }];
    if (/current_database\(\)/.test(q.sql)) {
      return [{ database: 'docmost', address: '10.0.0.1', port: 5432 }];
    }
    if (/pg_control_system/.test(q.sql)) return [{ id: '7001' }];
    if (/^insert into "mindspace_import_map"/.test(q.sql)) {
      const [type, sourceId, , target] = q.parameters as string[];
      mapRows.set(`${type}:${sourceId}`, target);
      return [];
    }
    if (/select "target_id" from "mindspace_import_map"/.test(q.sql)) {
      const [type, sourceId] = q.parameters as string[];
      const target = mapRows.get(`${type}:${sourceId}`);
      return target ? [{ targetId: target }] : [];
    }
    if (/from "workspaces"/.test(q.sql))
      return [{ ...workspace, hostname: null, customDomain: null }];
    if (/from "users"/.test(q.sql)) {
      const wanted = q.parameters
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.toLowerCase());
      return users.filter((u) => wanted.includes(u.email.toLowerCase()));
    }
    const insert = /^insert into "([a-z_]+)" \(([^)]*)\) values/.exec(q.sql);
    if (insert) {
      const cols = insert[2].split(', ').map((c) => camel(c.replace(/"/g, '')));
      const row = Object.fromEntries(cols.map((c, i) => [c, q.parameters[i]]));
      if (row.id) rows.set(`${insert[1]}:${row.id}`, row);
      return /returning/.test(q.sql) ? [row] : [];
    }
    const byId =
      /^select .* from "([a-z_]+)" where "(?:[a-z_]+"\.")?id" = \$1/.exec(
        q.sql,
      );
    if (byId) {
      const row = rows.get(`${byId[1]}:${q.parameters[0]}`);
      return row ? [row] : [];
    }
    return [];
  };
  return rec;
}
