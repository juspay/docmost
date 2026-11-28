import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('user_passkeys')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('cascade').notNull(),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('credential_id', 'text', (col) => col.notNull())
    .addColumn('public_key', 'bytea', (col) => col.notNull())
    .addColumn('counter', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('transports', sql`text[]`, (col) =>
      col.notNull().defaultTo(sql`'{}'`),
    )
    .addColumn('device_type', 'text', (col) => col.notNull())
    .addColumn('backed_up', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('last_used_at', 'timestamptz')
    .addUniqueConstraint('uq_user_passkeys_workspace_credential', [
      'workspace_id',
      'credential_id',
    ])
    .execute();

  await db.schema
    .createIndex('idx_user_passkeys_user_id')
    .on('user_passkeys')
    .column('user_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('user_passkeys').execute();
}
