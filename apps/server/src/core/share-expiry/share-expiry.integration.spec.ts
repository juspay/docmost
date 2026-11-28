import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { nanoIdGen } from '../../common/helpers';
import { ShareService } from '../share/share.service';
import { ShareExpiryService } from './share-expiry.service';
import { ShareExpiryRepo } from '@docmost/db/repos/share/share-expiry.repo';

// Runs the real hierarchy query. Set SHARE_EXPIRY_TEST_DATABASE_URL to a
// migrated database; every row is written in a transaction that is rolled back.
const configuredUrl = process.env.SHARE_EXPIRY_TEST_DATABASE_URL;
// Only ever a throwaway database: its name must say so.
const databaseUrl =
  configuredUrl && /test|_p8/.test(new URL(configuredUrl).pathname)
    ? configuredUrl
    : undefined;

class Rollback extends Error {}

const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 86_400_000);

(databaseUrl ? describe : describe.skip)(
  'link expiry against PostgreSQL',
  () => {
    let db: Kysely<any>;

    beforeAll(() => {
      db = new Kysely<any>({
        dialect: new PostgresJSDialect({
          postgres: postgres(databaseUrl, { max: 1 }),
        }),
        plugins: [new CamelCasePlugin()],
      });
    });
    afterAll(() => db.destroy());

    // Runs `body` with a fresh workspace, space and a root page, then rolls back.
    async function scenario(
      body: (ctx: {
        trx: any;
        service: ShareService;
        workspaceId: string;
        page: (parent?: string) => Promise<string>;
        share: (
          pageId: string,
          o: { includeSubPages?: boolean; expiresAt?: Date },
        ) => Promise<string>;
      }) => Promise<void>,
    ) {
      await db
        .transaction()
        .execute(async (trx) => {
          const { id: workspaceId } = await trx
            .insertInto('workspaces')
            .values({ name: 'expiry-test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const { id: spaceId } = await trx
            .insertInto('spaces')
            .values({ slug: 'exp', workspaceId })
            .returning('id')
            .executeTakeFirstOrThrow();
          const expiryRepo = new ShareExpiryRepo(trx as any);
          const service = new ShareService(
            {} as any,
            {} as any,
            {} as any,
            trx as any,
            {} as any,
            {} as any,
            new ShareExpiryService(expiryRepo),
          );
          await body({
            trx,
            service,
            workspaceId,
            page: async (parent) =>
              (
                await trx
                  .insertInto('pages')
                  .values({
                    slugId: nanoIdGen(),
                    spaceId,
                    workspaceId,
                    parentPageId: parent ?? null,
                  })
                  .returning('id')
                  .executeTakeFirstOrThrow()
              ).id,
            share: async (pageId, o) => {
              const { id } = await trx
                .insertInto('shares')
                .values({
                  key: nanoIdGen().toLowerCase(),
                  pageId,
                  spaceId,
                  workspaceId,
                  includeSubPages: o.includeSubPages ?? false,
                })
                .returning('id')
                .executeTakeFirstOrThrow();
              if (o.expiresAt) {
                await expiryRepo.upsert(
                  {
                    shareId: id,
                    workspaceId,
                    expiresAt: o.expiresAt,
                    periodDays: 7,
                    updatedById: null as any,
                  },
                  trx,
                );
              }
              return id;
            },
          });
          throw new Rollback();
        })
        .catch((e) => {
          if (!(e instanceof Rollback)) throw e;
        });
    }

    it('getShareForPage: a page under an expired ancestor share with its own live share is served through the live one', async () => {
      await scenario(async ({ service, workspaceId, page, share }) => {
        const ancestor = await page();
        const child = await page(ancestor);
        await share(ancestor, { includeSubPages: true, expiresAt: past() });
        const own = await share(child, { expiresAt: future() });

        const found = await service.getShareForPage(child, workspaceId);

        expect(found).toMatchObject({ id: own, level: 0, expired: false });
      });
    });

    it('getShareForPage: a page with an expired own share under a live ancestor share is served through the ancestor', async () => {
      await scenario(async ({ service, workspaceId, page, share }) => {
        const ancestor = await page();
        const child = await page(ancestor);
        const live = await share(ancestor, { includeSubPages: true });
        await share(child, { expiresAt: past() });

        const found = await service.getShareForPage(child, workspaceId);

        expect(found).toMatchObject({ id: live, level: 1, expired: false });
      });
    });

    it('getShareForPage: reaches a live share two levels up past an expired one', async () => {
      await scenario(async ({ service, workspaceId, page, share }) => {
        const top = await page();
        const middle = await page(top);
        const leaf = await page(middle);
        const live = await share(top, { includeSubPages: true });
        await share(middle, { includeSubPages: true, expiresAt: past() });

        const found = await service.getShareForPage(leaf, workspaceId);

        expect(found).toMatchObject({ id: live, level: 2, expired: false });
      });
    });

    it('getShareForPage: when every covering share has expired, returns the nearest with expired: true', async () => {
      await scenario(async ({ service, workspaceId, page, share }) => {
        const ancestor = await page();
        const child = await page(ancestor);
        await share(ancestor, { includeSubPages: true, expiresAt: past() });
        const own = await share(child, { expiresAt: past() });

        const found = await service.getShareForPage(child, workspaceId);

        expect(found).toMatchObject({ id: own, level: 0, expired: true });
        expect(found.expiresAt).toBeInstanceOf(Date);
      });
    });

    it('getShareForPage: an ancestor share that does not include sub-pages still ends the walk', async () => {
      await scenario(async ({ service, workspaceId, page, share }) => {
        const top = await page();
        const middle = await page(top);
        const leaf = await page(middle);
        await share(top, { includeSubPages: true });
        await share(middle, { includeSubPages: false });

        expect(
          await service.getShareForPage(leaf, workspaceId),
        ).toBeUndefined();
      });
    });

    it('getShareForPage: a share with no expiry row is returned as usable', async () => {
      await scenario(async ({ service, workspaceId, page, share }) => {
        const only = await page();
        const id = await share(only, {});

        const found = await service.getShareForPage(only, workspaceId);

        expect(found).toMatchObject({
          id,
          expired: false,
          expiresAt: null,
          periodDays: null,
        });
      });
    });

    it('deleting a share deletes its expiry row', async () => {
      await scenario(async ({ trx, page, share }) => {
        const id = await share(await page(), { expiresAt: future() });
        const count = async () =>
          Number(
            (
              await trx
                .selectFrom('shareExpiries')
                .select(sql`count(*)`.as('n'))
                .where('shareId', '=', id)
                .executeTakeFirstOrThrow()
            ).n,
          );
        expect(await count()).toBe(1);

        await trx.deleteFrom('shares').where('id', '=', id).execute();

        expect(await count()).toBe(0);
      });
    });

    it('the database refuses an expiry period other than 1, 7 or 30', async () => {
      await scenario(async ({ trx, workspaceId, page, share }) => {
        const id = await share(await page(), {});
        await sql`savepoint check_period`.execute(trx);
        await expect(
          trx
            .insertInto('shareExpiries')
            .values({
              shareId: id,
              workspaceId,
              expiresAt: future(),
              periodDays: 2,
            })
            .execute(),
        ).rejects.toThrow(/period_days/);
      });
    });
  },
);
