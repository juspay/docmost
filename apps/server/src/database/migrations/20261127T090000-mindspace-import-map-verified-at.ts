import { Kysely, sql } from 'kysely';

// When each mapped mindspace item last passed the import's verification.
// Its own migration, so a database that already ran the map-table migration
// gets it too. Dropped with the map table after cut-over.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table mindspace_import_map add column if not exists verified_at timestamptz`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table mindspace_import_map drop column if exists verified_at`.execute(
    db,
  );
}
