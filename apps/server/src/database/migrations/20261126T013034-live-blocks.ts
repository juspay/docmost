import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('live_blocks')
    // no default: the client supplies the id
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('ydoc', 'bytea', (col) => col)
    .addColumn('snapshot', 'jsonb', (col) => col)
    .addColumn('snapshot_error', 'text', (col) => col)
    .addColumn('creator_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz', (col) => col)
    .addCheckConstraint(
      'live_blocks_kind_check',
      sql`kind IN ('whiteboard', 'todo', 'sheet')`,
    )
    .execute();

  await db.schema
    .createIndex('idx_live_blocks_page_id')
    .on('live_blocks')
    .column('page_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('live_blocks').execute();
}
