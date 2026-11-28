jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { ShareExpiryRepo } from '@docmost/db/repos/share/share-expiry.repo';
import { ShareExpiryService } from '../core/share-expiry/share-expiry.service';
import { KyselyDocmostReader } from './docmost-reader';
import { DbImportMap, targetId } from './import-map';
import { ImportWriter } from './import-writer';
import { ImportReport } from './report';
import { CachedSource, type ImportContext } from './runner';
import { ALL_STEPS } from './steps';
import { FakeSource } from './testing/fake-source';
import { C, D, P, syntheticData } from './testing/synthetic-mindspace';
import { options } from './testing/test-context';
import { verifyImport } from './verify';
import { DryRunFileStore } from './whiteboard-file-store';

// The whole import into a fresh workspace of a real, migrated docmost
// database, read back through KyselyDocmostReader. The workspace (and with it
// every row the import wrote) is deleted afterwards. Runs only when
// MINDSPACE_IMPORT_TEST_DATABASE_URL names a database whose name contains
// "test" or "_p7".
// a real database, and a cold compile, can take longer than the default 5 s
jest.setTimeout(30_000);

const configured = process.env.MINDSPACE_IMPORT_TEST_DATABASE_URL;
const databaseUrl =
  configured && /test|_p7/.test(new URL(configured).pathname)
    ? configured
    : undefined;

(databaseUrl ? describe : describe.skip)(
  'the import read back through KyselyDocmostReader',
  () => {
    let db: Kysely<any>;
    let workspaceId: string;
    let ctx: ImportContext;
    const data = syntheticData();

    const newContext = (): ImportContext => {
      const map = new DbImportMap(db as any, workspaceId);
      return {
        workspaceId,
        dryRun: false,
        source: new CachedSource(new FakeSource(data)),
        map,
        report: new ImportReport(),
        fallbackOwner: {
          id: fallbackId,
          email: 'admin@acme.test',
          name: 'Admin',
        } as any,
        options: options({
          docmostWorkspace: workspaceId,
          acceptLoss: [P.broken],
        }),
        writer: new ImportWriter(
          db as any,
          map,
          workspaceId,
          new ShareExpiryService(new ShareExpiryRepo(db as any)),
        ),
        docmost: new KyselyDocmostReader(db as any, workspaceId),
        files: new DryRunFileStore('50mb'),
        urls: {
          page: (space, slugId) => `https://docs.test/s/${space}/p/${slugId}`,
          share: (key, slugId) => `https://docs.test/share/${key}/p/${slugId}`,
        },
        state: {},
      };
    };
    let fallbackId: string;

    beforeAll(async () => {
      db = new Kysely<any>({
        dialect: new PostgresJSDialect({
          postgres: postgres(databaseUrl, {
            max: 2,
            onnotice: () => undefined,
          }),
        }),
        plugins: [new CamelCasePlugin()],
      });
      ({ id: workspaceId } = await db
        .insertInto('workspaces')
        .values({ name: 'reader-integration-test' })
        .returning('id')
        .executeTakeFirstOrThrow());
      const people = ['admin', 'ada', 'grace', 'linus', 'eve'].map((n) => ({
        email: `${n}@acme.test`,
        name: n,
        workspaceId,
        role: 'member',
        emailVerifiedAt: new Date(),
      }));
      people.push({
        email: 'ivan@acme.test',
        name: 'ivan',
        workspaceId,
        role: 'member',
        emailVerifiedAt: null,
      });
      const inserted = await db
        .insertInto('users')
        .values(people)
        .returning(['id', 'email'])
        .execute();
      fallbackId = inserted.find((u) => u.email === 'admin@acme.test').id;

      ctx = newContext();
      for (const step of ALL_STEPS) await step.run(ctx);
    }, 60_000);

    afterAll(async () => {
      if (workspaceId) {
        // the spaces first (pages, comments, shares and blocks go with them)
        await db
          .deleteFrom('spaces')
          .where('workspaceId', '=', workspaceId)
          .execute();
        await db
          .deleteFrom('workspaces')
          .where('id', '=', workspaceId)
          .execute();
      }
      await db?.destroy();
    });

    it('verify passes against the real tables', async () => {
      await verifyImport(ctx, ALL_STEPS);
      // every item that passed is recorded on its map row
      const unverified = await db
        .selectFrom('mindspaceImportMap')
        .select(['sourceType', 'sourceId'])
        .where('workspaceId', '=', workspaceId)
        .where('sourceType', 'in', ['project', 'document', 'link', 'workspace'])
        .where('verifiedAt', 'is', null)
        .execute();
      expect(unverified.filter((r) => r.sourceId !== P.broken)).toEqual([]);
      expect(ctx.report.mismatches()).toEqual([]);
      expect(ctx.report.get('project.imported')).toBe(7);
      expect(ctx.report.get('comment.imported')).toBe(9);
    });

    it('share() joins the expiry row: the original date, or none for a legacy link', async () => {
      const reader = new KyselyDocmostReader(db as any, workspaceId);
      const live = await reader.share(targetId(workspaceId, 'share', P.board));
      expect(live.expiresAt).toEqual(
        data.projects.find((p) => p.id === P.board).linkExpiresAt,
      );
      expect(live.key).toMatch(/^[a-z0-9]{10}$/);
      const legacy = await reader.share(targetId(workspaceId, 'share', P.docs));
      expect(legacy).toMatchObject({ includeSubPages: true, expiresAt: null });
      // another workspace's id finds nothing
      expect(
        await new KyselyDocmostReader(
          db as any,
          '00000000-0000-4000-8000-000000000000',
        ).share(live.id),
      ).toBeUndefined();
    });

    it('block() and pageComments() read what the import wrote', async () => {
      const reader = new KyselyDocmostReader(db as any, workspaceId);
      const block = await reader.block(targetId(workspaceId, 'block', P.board));
      expect(block.pageId).toBe(targetId(workspaceId, 'project', P.board));
      expect((block.snapshot as any).elements).toHaveLength(4);
      const comments = await reader.pageComments(
        targetId(workspaceId, 'document', D.overview),
      );
      expect(comments.map((c) => c.id)).toEqual(
        expect.arrayContaining(
          [C.quoted, C.quotedReply1, C.quotedReply2].map((id) =>
            targetId(workspaceId, 'comment', id),
          ),
        ),
      );
      expect(
        comments.find(
          (c) => c.id === targetId(workspaceId, 'comment', C.quoted),
        ).selection,
      ).toBe('Read the source');
    });

    it('a page trashed after the import is reported as drift by a re-run; members match exactly', async () => {
      const reader = new KyselyDocmostReader(db as any, workspaceId);
      const team = await reader.spaceMembers(
        await ctx.map.get('workspace', data.workspaces[0].id),
      );
      expect(team.map((m) => m.role).sort()).toEqual([
        'admin',
        'reader',
        'writer',
      ]);

      const pageId = targetId(workspaceId, 'document', D.notes);
      await db
        .updateTable('pages')
        .set({ deletedAt: new Date() })
        .where('id', '=', pageId)
        .execute();
      try {
        expect((await reader.page(pageId)).deletedAt).not.toBeNull();
        const again = newContext();
        for (const step of ALL_STEPS) await step.run(again);
        await verifyImport(again, ALL_STEPS);
        // an earlier run's page, trashed since: drift on a re-run, not a failure
        expect(again.report.mismatches()).toEqual([]);
        expect(again.report.warningsOf('drift')).toContainEqual(
          expect.objectContaining({
            what: `document ${D.notes} ("Meeting notes.md") has no page in docmost`,
          }),
        );
        expect(again.report.warningsOf('target-page-missing')).toContainEqual(
          expect.objectContaining({ kind: 'document', documentId: D.notes }),
        );
        expect(again.report.get('document.already-imported')).toBe(2);
      } finally {
        await db
          .updateTable('pages')
          .set({ deletedAt: null })
          .where('id', '=', pageId)
          .execute();
      }
    });
  },
);
