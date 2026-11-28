import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('personal_access_tokens')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('token_prefix', 'text', (col) => col.notNull())
    .addColumn('scope', 'text', (col) =>
      col.notNull().check(sql`scope in ('read', 'write')`),
    )
    .addColumn('expires_at', 'timestamptz')
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await sql`
    CREATE INDEX idx_personal_access_tokens_user
    ON personal_access_tokens (user_id, workspace_id)
    WHERE revoked_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('personal_access_tokens').execute();
}
