import { NotFoundException } from '@nestjs/common';
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
import { ShareService } from '../share/share.service';
import { ShareController } from '../share/share.controller';
import { ShareSeoController } from '../share/share-seo.controller';
import { SearchController } from '../search/search.controller';
import {
  ShareExpiredException,
  ShareExpiryService,
} from './share-expiry.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('node:fs');

const WORKSPACE_ID = '019a1f00-0000-7000-8000-000000000b01';
const SPACE_ID = '019a1f00-0000-7000-8000-000000000b02';
const HOST_PAGE_ID = '019a1f00-0000-7000-8000-000000000b03';
const PAGE_ID_OWN = '019a1f00-0000-7000-8000-000000000b08';
const SOURCE_PAGE_ID = '019a1f00-0000-7000-8000-000000000b04';
const HOST_SHARE_ID = '019a1f00-0000-7000-8000-000000000b05';
const SOURCE_SHARE_ID = '019a1f00-0000-7000-8000-000000000b06';
const ATTACHMENT_ID = '019a1f00-0000-7000-8000-000000000b07';
const HOST_SLUG = 'hostslug01';
const SOURCE_SLUG = 'sourceslug1';
const TITLE = 'Quarterly plan (private title)';
const DAY = 86_400_000;
const workspace = { id: WORKSPACE_ID, licenseKey: null, plan: null } as any;

// A Kysely whose driver answers every query with rows chosen by the test.
function fakeDb(rowsFor: (query: CompiledQuery) => unknown[]) {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => ({
      rows: rowsFor(query) as R[],
    }),
    streamQuery: async function* () {},
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  return new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [new CamelCasePlugin()],
  });
}

type ShareSpec = { id: string; key: string; expiresAt: Date | null };

/**
 * One host page and one source page, each with its own share. `host` and
 * `source` say when each share expires (null: never).
 */
function world(opts: {
  host: Date | null;
  source?: Date | null;
  sharingAllowed?: boolean;
  restricted?: boolean;
}) {
  const { sharingAllowed = true, restricted = false } = opts;
  const pages = {
    [HOST_PAGE_ID]: {
      slugId: HOST_SLUG,
      share: shareSpec(HOST_SHARE_ID, 'hostkey', opts.host),
    },
    [SOURCE_PAGE_ID]: {
      slugId: SOURCE_SLUG,
      share: shareSpec(SOURCE_SHARE_ID, 'sourcekey', opts.source ?? null),
    },
  };
  const bySlug = (idOrSlug: string) =>
    Object.entries(pages).find(
      ([id, p]) => id === idOrSlug || p.slugId === idOrSlug,
    );

  const db = fakeDb((query) => {
    const hit = Object.entries(pages).find(
      ([id, p]) =>
        query.parameters.includes(id) || query.parameters.includes(p.slugId),
    );
    if (!hit) return [];
    const [id, page] = hit;
    return [
      {
        id,
        slugId: page.slugId,
        title: TITLE,
        icon: null,
        parentPageId: null,
        pageSpaceId: SPACE_ID,
        level: 0,
        shareId: page.share.id,
        shareKey: page.share.key,
        includeSubPages: false,
        searchIndexing: false,
        creatorId: null,
        spaceId: SPACE_ID,
        workspaceId: WORKSPACE_ID,
        createdAt: new Date('2026-11-01T00:00:00Z'),
        expiresAt: page.share.expiresAt,
        periodDays: page.share.expiresAt ? 7 : null,
      },
    ];
  });

  const expiryRows = Object.values(pages)
    .map((p) => p.share)
    .filter((s) => s.expiresAt)
    .map((s) => ({ shareId: s.id, expiresAt: s.expiresAt, periodDays: 7 }));
  const expiryService = new ShareExpiryService({
    findByShareIds: async (ids: string[]) =>
      expiryRows.filter((r) => ids.includes(r.shareId)),
  } as any);

  const shareRows = Object.entries(pages).map(([pageId, p]) => ({
    id: p.share.id,
    key: p.share.key,
    pageId,
    spaceId: SPACE_ID,
    workspaceId: WORKSPACE_ID,
    includeSubPages: false,
    searchIndexing: false,
  }));
  const shareRepo = {
    findById: jest.fn(async (idOrKey: string) =>
      shareRows.find((s) => s.id === idOrKey || s.key === idOrKey),
    ),
  };
  const content = {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          attachmentId: ATTACHMENT_ID,
          src: `/api/files/${ATTACHMENT_ID}/a.png`,
        },
      },
    ],
  };
  const pageRepo = {
    findById: jest.fn(
      async (idOrSlug: string, o?: { includeContent?: boolean }) => {
        const hit = bySlug(idOrSlug);
        if (!hit) return undefined;
        const [id, page] = hit;
        return {
          id,
          slugId: page.slugId,
          title: TITLE,
          spaceId: SPACE_ID,
          workspaceId: WORKSPACE_ID,
          deletedAt: null,
          coverPhoto: null,
          ...(o?.includeContent ? { content } : {}),
        };
      },
    ),
    getPageAndDescendantsExcludingRestricted: jest.fn(async () => []),
  };
  const tokenService = {
    generateAttachmentToken: jest.fn(async (_opts: any) => 'signed.token'),
  };
  const transclusionService = {
    lookupWithAccessSet: jest.fn(
      async (references: any[], accessible: Set<string>) => ({
        items: references.map((r) =>
          accessible.has(r.sourcePageId)
            ? { ...r, content: content, sourceUpdatedAt: new Date() }
            : {
                sourcePageId: r.sourcePageId,
                transclusionId: r.transclusionId,
                status: 'no_access',
              },
        ),
      }),
    ),
  };
  const shareService = new ShareService(
    shareRepo as any,
    pageRepo as any,
    { hasRestrictedAncestor: async () => restricted } as any,
    db as any,
    tokenService as any,
    transclusionService as any,
    expiryService,
  );
  jest
    .spyOn(shareService, 'isSharingAllowed')
    .mockImplementation(async () => sharingAllowed);

  return {
    shareService,
    shareRepo,
    pageRepo,
    tokenService,
    transclusionService,
  };
}

function shareSpec(id: string, key: string, expiresAt: Date | null): ShareSpec {
  return { id, key, expiresAt };
}

const past = () => new Date(Date.now() - 1000);
const future = (ms = DAY) => new Date(Date.now() + ms);

function shareController(shareService: ShareService, shareRepo: any) {
  return new ShareController(
    shareService,
    shareRepo,
    {} as any,
    {} as any,
    {} as any,
    { resolveFeatures: () => ({}) } as any,
    { log: jest.fn() } as any,
    {} as any, // LiveBlockService: these routes never touch live blocks
  );
}

function searchController(shareService: ShareService, shareRepo: any) {
  const searchService = { searchPage: jest.fn(async () => ({ items: [] })) };
  const controller = new SearchController(
    searchService as any,
    {} as any,
    { getSearchDriver: () => 'postgres' } as any,
    {} as any,
    {} as any,
    shareService,
    shareRepo,
    {} as any,
  );
  return { controller, searchService };
}

const refs = [{ sourcePageId: HOST_PAGE_ID, transclusionId: 't1' }];

// Each anonymous path, by the controller call it makes.
const PATHS: Record<
  string,
  (w: ReturnType<typeof world>, shareKey: string) => Promise<unknown>
> = {
  'page-info': (w) =>
    shareController(w.shareService, w.shareRepo).getSharedPageInfo(
      { pageId: HOST_SLUG },
      workspace,
    ),
  info: (w, key) =>
    shareController(w.shareService, w.shareRepo).getShare({ shareId: key }),
  tree: (w, key) =>
    shareController(w.shareService, w.shareRepo).getSharePageTree(
      { shareId: key },
      workspace,
    ),
  'transclusion/lookup': (w, key) =>
    shareController(w.shareService, w.shareRepo).transclusionLookup(
      { shareId: key, references: refs } as any,
      workspace,
    ),
  'share-search': (w, key) =>
    searchController(w.shareService, w.shareRepo).controller.searchShare(
      { query: 'plan', shareId: key } as any,
      workspace,
    ),
};

describe('anonymous share routes and link expiry', () => {
  it.each(Object.keys(PATHS))(
    '%s answers SHARE_EXPIRED when expired and serves a live share',
    async (name) => {
      const expired = world({ host: past() });
      const error: any = await PATHS[name](expired, 'hostkey').catch((e) => e);
      expect(error).toBeInstanceOf(ShareExpiredException);
      expect(error.getResponse()).toStrictEqual({
        code: 'SHARE_EXPIRED',
        message: 'This link has expired',
        pageSlugId: HOST_SLUG,
      });

      await expect(
        PATHS[name](world({ host: future() }), 'hostkey'),
      ).resolves.toBeDefined();
      await expect(
        PATHS[name](world({ host: null }), 'hostkey'),
      ).resolves.toBeDefined();
    },
  );

  it.each(Object.keys(PATHS))(
    '%s with sharing disabled answers the ordinary 404, not SHARE_EXPIRED',
    async (name) => {
      const w = world({ host: past(), sharingAllowed: false });
      const error = await PATHS[name](w, 'hostkey').catch((e) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error).not.toBeInstanceOf(ShareExpiredException);
    },
  );

  it('no attachment token is generated for an expired share', async () => {
    const w = world({ host: past() });

    await PATHS['page-info'](w, 'hostkey').catch(() => undefined);
    await PATHS['transclusion/lookup'](w, 'hostkey').catch(() => undefined);

    expect(w.tokenService.generateAttachmentToken).not.toHaveBeenCalled();
    // and the content was never read
    expect(
      w.pageRepo.findById.mock.calls.filter(([, o]) => o?.includeContent),
    ).toHaveLength(0);
  });

  it('a share expiring in 10 minutes gets attachment tokens that live 10 minutes', async () => {
    const w = world({ host: future(600_000) });

    await PATHS['page-info'](w, 'hostkey');

    expect(w.tokenService.generateAttachmentToken).toHaveBeenCalled();
    for (const [args] of w.tokenService.generateAttachmentToken.mock.calls) {
      expect((args as any).expiresInSeconds).toBeGreaterThan(595);
      expect((args as any).expiresInSeconds).toBeLessThanOrEqual(600);
    }
  });

  it('a share without an expiry gets tokens exactly as before', async () => {
    const w = world({ host: null });

    await PATHS['page-info'](w, 'hostkey');

    for (const [args] of w.tokenService.generateAttachmentToken.mock.calls) {
      expect(args).not.toHaveProperty('expiresInSeconds');
    }
  });

  it('transclusion lookup returns no_access for a source whose only share has expired while the host share is live', async () => {
    const w = world({ host: future(), source: past() });
    const lookup = (sourcePageId: string) =>
      shareController(w.shareService, w.shareRepo).transclusionLookup(
        {
          shareId: 'hostkey',
          references: [{ sourcePageId, transclusionId: 't1' }],
        } as any,
        workspace,
      ) as Promise<{ items: any[] }>;

    const { items } = await lookup(SOURCE_PAGE_ID);

    expect(items).toEqual([
      {
        sourcePageId: SOURCE_PAGE_ID,
        transclusionId: 't1',
        status: 'no_access',
      },
    ]);
    // the host page's own block is still served
    const own = await lookup(HOST_PAGE_ID);
    expect(own.items[0]).toHaveProperty('content');
  });

  it('a block from a live source share expiring sooner than the host limits its file tokens', async () => {
    const w = world({ host: future(), source: future(300_000) });

    await shareController(w.shareService, w.shareRepo).transclusionLookup(
      {
        shareId: 'hostkey',
        references: [{ sourcePageId: SOURCE_PAGE_ID, transclusionId: 't1' }],
      } as any,
      workspace,
    );

    const [[args]] = w.tokenService.generateAttachmentToken.mock.calls;
    expect((args as any).expiresInSeconds).toBeLessThanOrEqual(300);
  });

  it('for-page and the shares list still return an expired share, with expired: true, to someone who can edit the page', async () => {
    const w = world({ host: past() });
    const controller = new ShareController(
      w.shareService,
      w.shareRepo as any,
      w.pageRepo as any,
      {} as any,
      { validateCanView: async () => undefined } as any,
      {} as any,
      { log: jest.fn() } as any,
      {} as any, // LiveBlockService: these routes never touch live blocks
    );

    const forPage = await controller.getShareForPage(
      { pageId: HOST_PAGE_ID },
      { id: 'u1' } as any,
      workspace,
    );
    expect(forPage).toMatchObject({
      id: HOST_SHARE_ID,
      expired: true,
      periodDays: 7,
    });
    expect(forPage.expiresAt).toBeInstanceOf(Date);

    const listed = await new ShareService(
      {
        getShares: async () => ({
          items: [
            { id: 'a', pageId: 'p1', expiresAt: past(), periodDays: 7 },
            { id: 'b', pageId: 'p1', expiresAt: future(), periodDays: 1 },
            { id: 'c', pageId: 'p1', expiresAt: null, periodDays: null },
          ],
          meta: {},
        }),
      } as any,
      {} as any,
      { filterAccessiblePageIds: async ({ pageIds }: any) => pageIds } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ).getShares('u1', { limit: 20 } as any);
    expect(
      listed.items.map((s: any) => [s.id, s.expired, s.periodDays]),
    ).toEqual([
      ['a', true, 7],
      ['b', false, 1],
      ['c', false, null],
    ]);
  });

  it("for-page returns the page's own expired share even when a live ancestor share covers it", async () => {
    const own = {
      id: PAGE_ID_OWN,
      slugId: 'ownslug',
      title: 't',
      icon: null,
      parentPageId: HOST_PAGE_ID,
      pageSpaceId: SPACE_ID,
      level: 0,
      shareId: HOST_SHARE_ID,
      shareKey: 'ownkey',
      includeSubPages: false,
      searchIndexing: false,
      creatorId: null,
      spaceId: SPACE_ID,
      workspaceId: WORKSPACE_ID,
      createdAt: new Date(),
      expiresAt: past(),
      periodDays: 7,
    };
    const ancestor = {
      ...own,
      id: HOST_PAGE_ID,
      level: 1,
      shareId: SOURCE_SHARE_ID,
      shareKey: 'ancestorkey',
      includeSubPages: true,
      expiresAt: null,
      periodDays: null,
    };
    const service = new ShareService(
      {} as any,
      {} as any,
      {} as any,
      fakeDb(() => [own, ancestor]) as any,
      {} as any,
      {} as any,
      {} as any,
    );

    // anonymous callers are served through the live ancestor share
    expect(
      await service.getShareForPage(PAGE_ID_OWN, WORKSPACE_ID),
    ).toMatchObject({ id: SOURCE_SHARE_ID, level: 1, expired: false });
    // the page's editor still sees, and can renew, its own expired link
    expect(
      await service.getShareForPage(PAGE_ID_OWN, WORKSPACE_ID, {
        preferOwn: true,
      }),
    ).toMatchObject({ id: HOST_SHARE_ID, level: 0, expired: true });

    const controller = new ShareController(
      service,
      {} as any,
      { findById: async () => ({ id: PAGE_ID_OWN }) } as any,
      {} as any,
      { validateCanView: async () => undefined } as any,
      {} as any,
      { log: jest.fn() } as any,
      {} as any, // LiveBlockService: these routes never touch live blocks
    );
    expect(
      await controller.getShareForPage(
        { pageId: PAGE_ID_OWN },
        { id: 'u1' } as any,
        workspace,
      ),
    ).toMatchObject({ id: HOST_SHARE_ID, level: 0, expired: true });
  });

  it("share-search on an expired share of a restricted page keeps today's empty answer", async () => {
    const w = world({ host: past(), restricted: true });
    const { controller, searchService } = searchController(
      w.shareService,
      w.shareRepo,
    );

    await expect(
      controller.searchShare(
        { query: 'plan', shareId: 'hostkey' } as any,
        workspace,
      ),
    ).resolves.toEqual({ items: [] });
    expect(searchService.searchPage).toHaveBeenCalled();
  });

  it('an expired share whose root page is gone answers a plain 404', async () => {
    const w = world({ host: past() });
    w.pageRepo.findById.mockResolvedValue(undefined as never);

    const error: any = await PATHS.info(w, 'hostkey').catch((e) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error).not.toBeInstanceOf(ShareExpiredException);
  });

  describe('server-rendered share page', () => {
    const INDEX =
      '<html lang="en"><head><title>Docmost</title><!--meta-tags--></head></html>';
    afterEach(() => jest.restoreAllMocks());

    async function render(w: ReturnType<typeof world>) {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(INDEX);
      const plain = { plain: true };
      jest.spyOn(fs, 'createReadStream').mockReturnValue(plain);
      const sent: unknown[] = [];
      const res: any = {
        type: jest.fn().mockReturnThis(),
        send: jest.fn((body) => sent.push(body)),
      };
      const controller = new ShareSeoController(
        w.shareService,
        { findFirst: async () => workspace } as any,
        { isSelfHosted: () => true } as any,
      );
      await controller.getShare(
        res,
        { raw: { headers: {} } } as any,
        'hostkey',
        `quarterly-plan-${HOST_SLUG}`,
      );
      return { body: sent[0], plain };
    }

    it('returns the plain app page with noindex and no title when expired', async () => {
      const { body, plain } = await render(world({ host: past() }));

      expect(body).not.toBe(plain);
      expect(body).toContain('<meta name="robots" content="noindex" />');
      expect(body).toContain('<title>Docmost</title>');
      expect(body).not.toContain('Quarterly');
      expect(body).not.toContain('og:title');
    });

    it('still renders the title for a live share', async () => {
      const { body } = await render(world({ host: future() }));

      expect(body).toContain('og:title');
      expect(body).toContain('Quarterly plan');
    });

    it('returns the untouched app page, with no noindex tag, for a missing page', async () => {
      const w = world({ host: null });
      w.pageRepo.findById.mockResolvedValue(undefined as never);
      jest
        .spyOn(w.shareService, 'getShareForPage')
        .mockResolvedValue(undefined);

      const { body, plain } = await render(w);

      expect(body).toBe(plain);
    });
  });
});
