import { Kysely, RawBuilder, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import type { MindspaceSource, ServerIdentity } from './mindspace-source';
import type {
  MsComment,
  MsDocument,
  MsMember,
  MsProject,
  MsProjectShare,
  MsUser,
  MsWorkspace,
} from './mindspace.types';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

function databaseIdentity(url: string): string {
  const u = new URL(url);
  const host = LOCAL_HOSTS.has(u.hostname.toLowerCase())
    ? 'localhost'
    : u.hostname.toLowerCase();
  const port = u.port || '5432';
  const name = decodeURIComponent(u.pathname.replace(/^\//, '')) || u.username;
  return `${host}:${port}/${name}`;
}

/** True when both URLs name the same database on the same server. */
export function sameDatabase(a: string, b: string): boolean {
  return databaseIdentity(a) === databaseIdentity(b);
}

/** The identity of the server and database `db` is connected to. */
export async function readIdentity(db: Kysely<any>): Promise<ServerIdentity> {
  const { rows } = await sql<{
    database: string;
    address: string | null;
    port: number | null;
  }>`
    select current_database() as "database", host(inet_server_addr()) as "address",
           inet_server_port() as "port"`.execute(db);
  let systemIdentifier: string | null = null;
  try {
    const id = await sql<{
      id: string;
    }>`select system_identifier::text as "id" from pg_control_system()`.execute(
      db,
    );
    systemIdentifier = id.rows[0]?.id ?? null;
  } catch {
    // a role without pg_monitor may not read it
  }
  return {
    systemIdentifier,
    ...rows[0],
    port: rows[0].port === null ? null : Number(rows[0].port),
  };
}

/**
 * Reads a mindspace database. Every read is its own READ ONLY transaction:
 * Supabase's pooled connections do not keep a session setting, a transaction
 * mode does.
 */
export class PostgresMindspaceSource implements MindspaceSource {
  private readonly db: Kysely<any>;

  constructor(url: string) {
    this.db = new Kysely<any>({
      dialect: new PostgresJSDialect({
        postgres: postgres(url, { max: 2, onnotice: () => {} }),
      }),
    });
  }

  private async read<T>(query: RawBuilder<T>): Promise<T[]> {
    return this.db
      .transaction()
      .setAccessMode('read only')
      .execute(async (trx) => (await query.execute(trx)).rows);
  }

  identity(): Promise<ServerIdentity> {
    return readIdentity(this.db);
  }

  users(): Promise<MsUser[]> {
    return this.read<MsUser>(sql`
      select id::text as "id", email as "email",
             email_confirmed_at as "emailConfirmedAt"
      from auth.users order by id`);
  }

  workspaces(): Promise<MsWorkspace[]> {
    return this.read<MsWorkspace>(sql`
      select id::text as "id", name as "name", owner_id::text as "ownerId",
             created_at as "createdAt"
      from public.workspaces order by created_at, id`);
  }

  members(): Promise<MsMember[]> {
    return this.read<MsMember>(sql`
      select workspace_id::text as "workspaceId", user_id::text as "userId",
             role as "role"
      from public.workspace_members order by workspace_id, added_at, user_id`);
  }

  async projects(): Promise<MsProject[]> {
    const rows = await this.read<MsProject>(sql`
      select id::text as "id", workspace_id::text as "workspaceId",
             name as "name", kind as "kind", scene as "scene",
             position as "position", visibility as "visibility",
             link_expires_at as "linkExpiresAt", created_at as "createdAt",
             updated_at as "updatedAt"
      from public.projects
      order by workspace_id, position asc nulls last, created_at, id`);
    return rows.map((r) => ({
      ...r,
      position: r.position === null ? null : Number(r.position),
    }));
  }

  documents(): Promise<MsDocument[]> {
    return this.read<MsDocument>(sql`
      select id::text as "id", project_id::text as "projectId",
             name as "name", content as "content", position as "position",
             created_at as "createdAt", updated_at as "updatedAt"
      from public.documents order by project_id, position, created_at, id`);
  }

  comments(): Promise<MsComment[]> {
    return this.read<MsComment>(sql`
      select id::text as "id", document_id::text as "documentId",
             parent_id::text as "parentId", body as "body",
             anchor_quote as "anchorQuote",
             coalesce(anchor_prefix, '') as "anchorPrefix",
             coalesce(anchor_suffix, '') as "anchorSuffix",
             created_by::text as "createdBy", created_at as "createdAt",
             resolved_at as "resolvedAt", resolved_by::text as "resolvedBy"
      from public.document_comments order by created_at, id`);
  }

  projectShares(): Promise<MsProjectShare[]> {
    return this.read<MsProjectShare>(sql`
      select project_id::text as "projectId", email as "email", role as "role"
      from public.project_shares order by project_id, created_at, id`);
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}
