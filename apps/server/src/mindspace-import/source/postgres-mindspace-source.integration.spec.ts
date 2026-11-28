import postgres = require('postgres');
import { sql as ksql } from 'kysely';
import { PostgresMindspaceSource } from './postgres-mindspace-source';
import {
  C,
  D,
  P,
  U,
  W,
  syntheticData,
  toSql,
  whiteboardScene,
} from '../testing/synthetic-mindspace';

// Needs a scratch database holding testing/supabase-stub.sql and mindspace's
// sixteen migrations. Its name must contain "test": the spec empties it.
// a real database, and a cold compile, can take longer than the default 5 s
jest.setTimeout(30_000);

const configured = process.env.MINDSPACE_TEST_DATABASE_URL;
const databaseUrl =
  configured && /test/.test(new URL(configured).pathname)
    ? configured
    : undefined;

const TABLES =
  'public.document_comments, public.documents, public.project_shares, public.projects, public.workspace_members, public.workspaces, auth.users';

(databaseUrl ? describe : describe.skip)(
  'PostgresMindspaceSource against the mindspace schema',
  () => {
    let sql: postgres.Sql;
    let source: PostgresMindspaceSource;
    const data = syntheticData(new Date('2026-01-01T00:00:00Z'));

    beforeAll(async () => {
      sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      await sql.unsafe(`truncate ${TABLES} cascade`);
      await sql.unsafe(toSql(data));
      source = new PostgresMindspaceSource(databaseUrl);
    });
    afterAll(async () => {
      await source?.close();
      await sql.unsafe(`truncate ${TABLES} cascade`);
      await sql.end();
    });

    it('each reader returns the fields in mindspace.types.ts from rows inserted into the real schema', async () => {
      const users = await source.users();
      expect(users).toHaveLength(6);
      expect(users.find((u) => u.id === U.linus)).toEqual({
        id: U.linus,
        email: 'LINUS@Acme.test',
        emailConfirmedAt: new Date('2025-01-01T00:00:00Z'),
      });
      expect(users.find((u) => u.id === U.eve).emailConfirmedAt).toBeNull();

      const workspaces = await source.workspaces();
      expect(workspaces.map((w) => w.id)).toEqual([
        W.team,
        W.personalGrace,
        W.personalAda,
        W.olga,
      ]);
      expect(workspaces[0]).toEqual({
        id: W.team,
        name: 'Team',
        ownerId: U.ada,
        createdAt: new Date('2025-02-01T00:00:00Z'),
      });

      const members = await source.members();
      expect(members).toContainEqual({
        workspaceId: W.team,
        userId: U.linus,
        role: 'viewer',
      });
      expect(members).toHaveLength(5);

      const projects = await source.projects();
      expect(projects).toHaveLength(10);
      const board = projects.find((p) => p.id === P.board);
      expect(board).toEqual({
        id: P.board,
        workspaceId: W.team,
        name: 'Roadmap board',
        kind: 'whiteboard',
        scene: whiteboardScene,
        position: 1024,
        visibility: 'link',
        linkExpiresAt: data.projects.find((p) => p.id === P.board)
          .linkExpiresAt,
        createdAt: new Date('2025-06-01T10:00:00Z'),
        updatedAt: new Date('2025-09-01T10:00:00Z'),
      });
      // a jsonb string comes back as a string, a null scene as null
      expect(typeof projects.find((p) => p.id === P.broken).scene).toBe(
        'string',
      );
      expect(projects.find((p) => p.id === P.empty).scene).toBeNull();
      expect(projects.find((p) => p.id === P.docs).linkExpiresAt).toBeNull();
      // sidebar order within a workspace
      expect(
        projects.filter((p) => p.workspaceId === W.team).map((p) => p.id),
      ).toEqual([P.board, P.tasks, P.docs, P.broken, P.empty, P.budget]);

      const documents = await source.documents();
      expect(
        documents.filter((d) => d.projectId === P.docs).map((d) => d.id),
      ).toEqual([D.overview, D.notes]);
      expect(documents.find((d) => d.id === D.notes)).toEqual({
        id: D.notes,
        projectId: P.docs,
        name: 'Meeting notes.md',
        content: data.documents.find((d) => d.id === D.notes).content,
        position: 1,
        createdAt: new Date('2025-06-03T10:00:00Z'),
        updatedAt: new Date('2025-09-02T10:00:00Z'),
      });

      const comments = await source.comments();
      expect(comments).toHaveLength(10);
      expect(comments.find((c) => c.id === C.repeated)).toEqual({
        id: C.repeated,
        documentId: D.overview,
        parentId: null,
        body: 'Which plan? The second one.',
        anchorQuote: 'the plan simple',
        anchorPrefix: 'we keep ',
        anchorSuffix: ' and the',
        createdBy: U.grace,
        createdAt: new Date('2025-07-02T09:00:00Z'),
        resolvedAt: null,
        resolvedBy: null,
      });
      expect(comments.find((c) => c.id === C.quotedReply1)).toMatchObject({
        parentId: C.quoted,
        anchorQuote: null,
      });
      expect(comments.find((c) => c.id === C.resolved)).toMatchObject({
        resolvedAt: new Date('2025-07-05T09:00:00Z'),
        resolvedBy: U.grace,
      });
      expect(
        comments.find((c) => c.id === C.deletedAuthor).createdBy,
      ).toBeNull();

      expect(await source.projectShares()).toEqual([
        { projectId: P.board, email: 'friend@outside.test', role: 'viewer' },
      ]);
    });

    it('identity names the server and database the connection reached', async () => {
      const id = await source.identity();
      expect(id.database).toBe(new URL(databaseUrl).pathname.slice(1));
      expect(id.systemIdentifier).toMatch(/^\d+$/);
    });

    it('every read runs inside a READ ONLY transaction', async () => {
      // the private helper each reader goes through refuses a write
      const err = await (source as any)
        .read(ksql`insert into auth.users (email) values ('x@y') returning id`)
        .catch((e: Error) => e);
      expect(String(err.message)).toMatch(/read-only transaction/);
      expect((await sql`select count(*)::int as n from auth.users`)[0].n).toBe(
        6,
      );
    });
  },
);
