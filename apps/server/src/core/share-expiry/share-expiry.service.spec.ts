import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ShareExpiredException,
  ShareExpiryService,
} from './share-expiry.service';
import { ShareExpiryController } from './share-expiry.controller';
import { AuditEvent } from '../../common/events/audit-events';

const WORKSPACE_ID = '019a1f00-0000-7000-8000-000000000a01';
const OTHER_WORKSPACE_ID = '019a1f00-0000-7000-8000-000000000a02';
const SHARE_ID = '019a1f00-0000-7000-8000-000000000a03';
const PAGE_ID = '019a1f00-0000-7000-8000-000000000a04';
const SPACE_ID = '019a1f00-0000-7000-8000-000000000a05';
const USER = { id: 'user-1', workspaceId: WORKSPACE_ID } as any;
const DAY = 86_400_000;
const NOW = new Date('2026-11-26T10:00:00.000Z');

type Row = {
  shareId: string;
  workspaceId: string;
  expiresAt: Date;
  periodDays: number;
  updatedById: string;
};

// The repo's behaviour in memory: one row per share, upsert replaces it.
function fakeRepo(initial: Row[] = []) {
  const rows = new Map(initial.map((r) => [r.shareId, r]));
  return {
    rows,
    findByShareIds: jest.fn(async (ids: string[]) =>
      ids.flatMap((id) => (rows.has(id) ? [rows.get(id)] : [])),
    ),
    upsert: jest.fn(async (row: Row) => {
      rows.set(row.shareId, row);
      return row;
    }),
    delete: jest.fn(async (id: string) => rows.delete(id)),
  };
}

function row(expiresAt: Date, periodDays = 7): Row {
  return {
    shareId: SHARE_ID,
    workspaceId: WORKSPACE_ID,
    expiresAt,
    periodDays,
    updatedById: USER.id,
  };
}

afterEach(() => jest.useRealTimers());

describe('ShareExpiryService', () => {
  it('a share with no expiry row is usable', async () => {
    const service = new ShareExpiryService(fakeRepo() as any);

    expect(await service.isUsable(SHARE_ID)).toBe(true);
    expect(await service.get(SHARE_ID)).toBeNull();
    expect(await service.attachmentTokenLifetime(SHARE_ID)).toBeUndefined();
  });

  it('with a fake clock: usable one second before expires_at, not usable at expires_at', async () => {
    const expiresAt = new Date(NOW.getTime() + DAY);
    const service = new ShareExpiryService(fakeRepo([row(expiresAt)]) as any);
    jest.useFakeTimers();

    jest.setSystemTime(new Date(expiresAt.getTime() - 1000));
    expect(await service.isUsable(SHARE_ID)).toBe(true);
    expect((await service.get(SHARE_ID)).expired).toBe(false);

    jest.setSystemTime(expiresAt);
    expect(await service.isUsable(SHARE_ID)).toBe(false);
    expect((await service.get(SHARE_ID)).expired).toBe(true);
  });

  it('renew sets expires_at to now plus the stored period', async () => {
    const repo = fakeRepo([row(new Date(NOW.getTime() - DAY), 7)]);
    const service = new ShareExpiryService(repo as any);
    jest.useFakeTimers().setSystemTime(NOW);

    const renewed = await service.renew(SHARE_ID, USER);

    expect(renewed.expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY));
    expect(renewed.periodDays).toBe(7);
    expect(renewed.expired).toBe(false);
    expect(repo.rows.get(SHARE_ID).expiresAt).toEqual(renewed.expiresAt);
  });

  it('renew on a share without an expiry is refused', async () => {
    const service = new ShareExpiryService(fakeRepo() as any);

    await expect(service.renew(SHARE_ID, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('set with null removes the row; set with 2 is refused', async () => {
    const repo = fakeRepo([row(new Date(NOW.getTime() + DAY), 1)]);
    const service = new ShareExpiryService(repo as any);

    await expect(service.set(SHARE_ID, 2 as any, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.rows.size).toBe(1);

    expect(await service.set(SHARE_ID, null, USER)).toBeNull();
    expect(repo.rows.size).toBe(0);
  });

  it('set stores now plus whole days of 24 hours', async () => {
    const repo = fakeRepo();
    const service = new ShareExpiryService(repo as any);
    jest.useFakeTimers().setSystemTime(NOW);

    for (const days of [1, 7, 30] as const) {
      const expiry = await service.set(SHARE_ID, days, USER);
      expect(expiry.expiresAt).toEqual(new Date(NOW.getTime() + days * DAY));
      expect(expiry.periodDays).toBe(days);
    }
  });

  it('setExact keeps the given date, and refuses to run outside a transaction', async () => {
    const repo = fakeRepo();
    const service = new ShareExpiryService(repo as any);
    const trx = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            execute: async () => [{ workspaceId: WORKSPACE_ID }],
          }),
        }),
      }),
    } as any;
    const date = new Date('2027-01-05T00:00:00.000Z');

    const expiry = await service.setExact(SHARE_ID, date, 30, USER.id, trx);

    expect(expiry.expiresAt).toEqual(date);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, periodDays: 30 }),
      trx,
    );
    await expect(
      service.setExact(SHARE_ID, date, 30, USER.id, undefined as any),
    ).rejects.toThrow('transaction');
    await expect(
      service.setExact(SHARE_ID, date, 3 as any, USER.id, trx),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a share expiring in 10 minutes gets attachment tokens that live 10 minutes', async () => {
    const service = new ShareExpiryService(
      fakeRepo([row(new Date(NOW.getTime() + 600_000))]) as any,
    );

    expect(await service.attachmentTokenLifetime(SHARE_ID, NOW)).toBe(600);
  });

  it('attachment tokens never outlive the default hour', async () => {
    const service = new ShareExpiryService(
      fakeRepo([row(new Date(NOW.getTime() + 3 * DAY))]) as any,
    );

    expect(await service.attachmentTokenLifetime(SHARE_ID, NOW)).toBe(3600);
  });

  it("the expired body is exactly code, message and the requested page's slug id", () => {
    const error = new ShareExpiredException('abc123');

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toStrictEqual({
      code: 'SHARE_EXPIRED',
      message: 'This link has expired',
      pageSlugId: 'abc123',
    });
  });
});

describe('ShareExpiryController', () => {
  const share = {
    id: SHARE_ID,
    key: 'abcdef12',
    pageId: PAGE_ID,
    spaceId: SPACE_ID,
    workspaceId: WORKSPACE_ID,
  };

  function setup(opts: { canView?: boolean; canEdit?: boolean } = {}) {
    const { canView = true, canEdit = true } = opts;
    const repo = fakeRepo();
    const service = new ShareExpiryService(repo as any);
    const shareRepo = {
      findById: jest.fn(async (idOrKey: string) =>
        idOrKey === share.id || idOrKey === share.key ? share : undefined,
      ),
    };
    const pageRepo = {
      findById: jest.fn(async () => ({ id: PAGE_ID, spaceId: SPACE_ID })),
    };
    const pageAccess = {
      validateCanView: jest.fn(async () => {
        if (!canView) throw new ForbiddenException();
      }),
      validateCanEdit: jest.fn(async () => {
        if (!canEdit) throw new ForbiddenException();
      }),
    };
    const audit = { log: jest.fn() };
    const controller = new ShareExpiryController(
      service,
      shareRepo as any,
      pageRepo as any,
      pageAccess as any,
      audit as any,
    );
    return { controller, repo, audit, pageAccess };
  }
  const workspace = { id: WORKSPACE_ID } as any;

  it('set and renew are refused for someone who cannot edit the page; info for someone who cannot view it', async () => {
    const reader = setup({ canEdit: false });
    await expect(
      reader.controller.set(
        { shareId: SHARE_ID, periodDays: 7 },
        USER,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      reader.controller.renew({ shareId: SHARE_ID }, USER, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(reader.repo.rows.size).toBe(0);
    // a reader may still read the date
    await expect(
      reader.controller.info({ shareId: SHARE_ID }, USER, workspace),
    ).resolves.toBeNull();

    const outsider = setup({ canView: false });
    await expect(
      outsider.controller.info({ shareId: SHARE_ID }, USER, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('set accepts a share key as well as an id, and refuses a share of another workspace', async () => {
    const { controller, repo } = setup();

    const viaKey = await controller.set(
      { shareId: share.key, periodDays: 1 },
      USER,
      workspace,
    );
    expect(viaKey.periodDays).toBe(1);
    expect([...repo.rows.keys()]).toEqual([SHARE_ID]);

    await expect(
      controller.set({ shareId: SHARE_ID, periodDays: 7 }, USER, {
        id: OTHER_WORKSPACE_ID,
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.set({ shareId: 'missing', periodDays: 7 }, USER, workspace),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes an audit event for set, renew and remove, and none for a no-op remove', async () => {
    const { controller, audit } = setup();
    const events = () => audit.log.mock.calls.map(([p]) => p.event);

    await controller.set({ shareId: SHARE_ID, periodDays: 7 }, USER, workspace);
    await controller.renew({ shareId: SHARE_ID }, USER, workspace);
    await controller.set(
      { shareId: SHARE_ID, periodDays: null },
      USER,
      workspace,
    );
    await controller.set(
      { shareId: SHARE_ID, periodDays: null },
      USER,
      workspace,
    );

    expect(events()).toEqual([
      AuditEvent.SHARE_EXPIRY_SET,
      AuditEvent.SHARE_EXPIRY_RENEWED,
      AuditEvent.SHARE_EXPIRY_REMOVED,
    ]);
  });
});
