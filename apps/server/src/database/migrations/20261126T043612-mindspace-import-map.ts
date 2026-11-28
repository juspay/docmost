import { Kysely, sql } from 'kysely';

// One-off: maps mindspace rows to the docmost rows the import created from
// them. Dropped together with apps/server/src/mindspace-import after cut-over.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('mindspace_import_map')
    .addColumn('source_type', 'text', (col) => col.notNull())
    .addColumn('source_id', 'text', (col) => col.notNull())
    .addColumn('target_type', 'text', (col) => col.notNull())
    .addColumn('target_id', 'uuid', (col) => col.notNull())
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('mindspace_import_map_pkey', [
      'source_type',
      'source_id',
      'workspace_id',
    ])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('mindspace_import_map').execute();
}
