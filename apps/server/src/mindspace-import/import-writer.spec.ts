import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { jsonToNode } from '../collaboration/collaboration.util';
import { DbImportMap } from './import-map';
import { ImportWriter, spaceSlug } from './import-writer';
import {
  RecordingDb,
  docmostLike,
  type Statement,
} from './testing/recording-db';
import { KyselyDocmostReader } from './docmost-reader';
import { msUser, msWorkspace } from './testing/fake-source';
import { peopleStep } from './steps/people.step';
import { WS, testContext } from './testing/test-context';

/** The column → value pairs of a single-row insert. */
export function insertValues(s: Statement): Record<string, unknown> {
  const columns = /insert into "[a-z_]+" \(([^)]*)\)/
    .exec(s.sql)![1]
    .split(', ')
    .map((c) => c.replace(/"/g, ''));
  return Object.fromEntries(columns.map((c, i) => [c, s.parameters[i]]));
}

const PAGE_ID = '7d3c5a9e-0000-5000-8000-000000000001';

const content = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Plan' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Ship the ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'import' },
      ],
    },
    {
      type: 'whiteboard',
      attrs: {
        blockId: '0193a1b2-0000-7000-8000-000000000001',
        title: 'Board',
      },
    },
  ],
};

function world() {
  const rec = new RecordingDb();
  const setExact = jest.fn();
  const writer = new ImportWriter(rec.db, new DbImportMap(rec.db, WS), WS, {
    setExact,
  });
  return { rec, writer, setExact };
}

describe('ImportWriter', () => {
  it('ImportWriter inserts a page with slug id, position, text content and a ydoc that converts back to the same JSON', async () => {
    const { rec, writer } = world();
    rec.respond = (q) => {
      if (/select "position" from "pages"/.test(q.sql))
        return [{ position: 'a0' }];
      if (/^insert into "pages"/.test(q.sql))
        return [{ id: PAGE_ID, workspaceId: WS }];
      return [];
    };
    const createdAt = new Date('2025-03-04T05:06:07Z');
    await writer.createPage({
      id: PAGE_ID,
      spaceId: 'space-1',
      title: 'Plan',
      content,
      creatorId: 'user-1',
      createdAt,
      map: { type: 'project', sourceId: 'p1' },
    });

    const [insert] = rec.writesTo('pages');
    const row = insertValues(insert);
    expect(row.id).toBe(PAGE_ID);
    expect(row.slug_id).toMatch(/^[a-zA-Z0-9]{10}$/);
    expect(typeof row.position).toBe('string');
    expect(row.position > 'a0').toBe(true); // after its last sibling
    expect(row.text_content).toContain('Ship the import');
    expect(row.created_at).toEqual(createdAt);
    expect(row.updated_at).toEqual(createdAt);
    expect(row.creator_id).toBe('user-1');
    expect(row.last_updated_by_id).toBe('user-1');

    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.ydoc as Buffer));
    const back = TiptapTransformer.fromYdoc(doc, 'default');
    // the same document once both are read through the editor schema
    expect(jsonToNode(back).toJSON()).toEqual(jsonToNode(content).toJSON());
    expect(back.content[2]).toMatchObject({
      type: 'whiteboard',
      attrs: { blockId: content.content[2].attrs.blockId },
    });
  });

  it('the page row and its map row are written in one transaction', async () => {
    const { rec, writer } = world();
    rec.respond = (q) =>
      /^insert into "pages"/.test(q.sql)
        ? [{ id: PAGE_ID, workspaceId: WS }]
        : [];
    await writer.createPage({
      id: PAGE_ID,
      spaceId: 's',
      title: 't',
      content,
      creatorId: 'u',
      map: { type: 'project', sourceId: 'p1' },
    });
    const [page] = rec.writesTo('pages');
    const [mapRow] = rec.writesTo('mindspace_import_map');
    expect(page.tx).not.toBeNull();
    expect(mapRow.tx).toBe(page.tx);
    expect(insertValues(mapRow)).toMatchObject({
      source_type: 'project',
      source_id: 'p1',
      target_type: 'page',
      target_id: PAGE_ID,
      workspace_id: WS,
    });
    expect(rec.events).toEqual([`begin ${page.tx}`, `commit ${page.tx}`]);

    // the insert fails → no map row
    const failing = world();
    failing.rec.respond = (q) =>
      /^insert into "pages"/.test(q.sql) ? new Error('disk full') : [];
    await expect(
      failing.writer.createPage({
        id: PAGE_ID,
        spaceId: 's',
        title: 't',
        content,
        creatorId: 'u',
        map: { type: 'project', sourceId: 'p1' },
      }),
    ).rejects.toThrow('disk full');
    expect(failing.rec.writesTo('mindspace_import_map')).toEqual([]);
    expect(failing.rec.events).toEqual(['begin 1', 'rollback 1']);
  });

  it('a target row left by a crashed run is adopted, not duplicated', async () => {
    const { rec, writer } = world();
    // the page exists (an older run died before its map row was written)
    rec.respond = (q) =>
      /select \* from "pages" where "id" = \$1/.test(q.sql)
        ? [{ id: PAGE_ID, workspaceId: WS, title: 'old' }]
        : [];
    const page = await writer.createPage({
      id: PAGE_ID,
      spaceId: 's',
      title: 't',
      content,
      creatorId: 'u',
      map: { type: 'project', sourceId: 'p1' },
    });
    expect(page.title).toBe('old');
    expect(rec.writesTo('pages')).toEqual([]);
    expect(rec.writesTo('mindspace_import_map')).toHaveLength(1);
  });

  it('the seeded block row and the block node in the page are written in one transaction, row first', async () => {
    const { rec, writer } = world();
    const blockId = '0193a1b2-0000-7000-8000-000000000001';
    const page = { id: PAGE_ID, spaceId: 's', workspaceId: WS } as any;
    rec.respond = (q) =>
      /^update "pages"/.test(q.sql) ? [{ id: PAGE_ID }] : [];
    await writer.inTransaction(async (w) => {
      await w.createLiveBlock({
        blockId,
        page,
        snapshot: { kind: 'whiteboard', elements: [], files: {} },
        creatorId: 'u',
        map: { type: 'project', sourceId: 'p1' },
      });
      await w.setPageContent(page, content);
    });
    const writes = rec.writes();
    const block = writes.findIndex((s) =>
      /^insert into "live_blocks"/.test(s.sql),
    );
    const node = writes.findIndex((s) => /^update "pages"/.test(s.sql));
    expect(block).toBeGreaterThanOrEqual(0);
    expect(node).toBeGreaterThan(block);
    expect(insertValues(writes[block]).ydoc).toBeInstanceOf(Buffer);
    expect(JSON.stringify(writes[node].parameters)).toContain(blockId);
    expect(new Set(writes.map((s) => s.tx)).size).toBe(1);
    expect(rec.events).toEqual([
      `begin ${writes[0].tx}`,
      `commit ${writes[0].tx}`,
    ]);
  });

  it('createSpace inserts the space and exactly one member, the admin', async () => {
    const { rec, writer } = world();
    rec.respond = (q) =>
      /^insert into "spaces"/.test(q.sql)
        ? [{ id: 'sp-1', slug: 'personal-sp1', workspaceId: WS }]
        : [];
    const space = await writer.createSpace({
      id: 'sp-1',
      name: 'Personal',
      description: 'Imported from mindspace',
      adminId: 'owner',
      map: { type: 'workspace', sourceId: 'w1' },
    });
    expect(space).toEqual({ id: 'sp-1', slug: 'personal-sp1' });
    const members = rec.writesTo('space_members').map(insertValues);
    expect(members).toEqual([
      { space_id: 'sp-1', user_id: 'owner', role: 'admin' },
    ]);
    expect(insertValues(rec.writesTo('spaces')[0])).toMatchObject({
      name: 'Personal',
      description: 'Imported from mindspace',
      creator_id: 'owner',
    });
  });

  it('a comment keeps its timestamps, resolution and plain-text body', async () => {
    const { rec, writer } = world();
    const createdAt = new Date('2025-01-02T03:04:05Z');
    const resolvedAt = new Date('2025-01-03T00:00:00Z');
    await writer.createComment({
      id: 'c1',
      page: { id: PAGE_ID, spaceId: 's' } as any,
      text: 'first line\nsecond line\n\nnew paragraph',
      selection: 'quoted',
      creatorId: 'u',
      createdAt,
      resolvedAt,
      resolvedById: 'r',
      map: { type: 'comment', sourceId: 'mc1' },
    });
    const row = insertValues(rec.writesTo('comments')[0]);
    expect(row).toMatchObject({
      id: 'c1',
      page_id: PAGE_ID,
      selection: 'quoted',
      type: 'inline',
      created_at: createdAt,
      updated_at: createdAt,
      resolved_at: resolvedAt,
      resolved_by_id: 'r',
    });
    expect(
      typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'first line' },
            { type: 'hardBreak' },
            { type: 'text', text: 'second line' },
          ],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'new paragraph' }],
        },
      ],
    });
  });

  it('spaceSlug is a valid docmost slug', () => {
    expect(spaceSlug('Personal', 'abcdef12-3456')).toBe('personal-abcdef');
    expect(spaceSlug('Équipe — Q3 plans!', '0123456789')).toBe(
      'equipe-q3-plans-012345',
    );
    expect(spaceSlug('日本', 'ffffff00')).toBe('ms-ffffff');
    expect(spaceSlug('x'.repeat(80), 'aaaaaa')).toMatch(
      /^[a-z0-9][a-z0-9_-]{1,99}$/,
    );
  });

  describe('a row left by a crashed run (target present, map row absent) is adopted', () => {
    const map = (rec: RecordingDb) =>
      rec.writesTo('mindspace_import_map').map(insertValues);

    it('a space: no second space and no second admin', async () => {
      const { rec, writer } = world();
      rec.respond = (q) =>
        /from "spaces" where "id"/.test(q.sql)
          ? [{ id: 'sp-1', slug: 'team-sp1', workspaceId: WS }]
          : [];
      const space = await writer.createSpace({
        id: 'sp-1',
        name: 'Team',
        description: 'Imported from mindspace',
        adminId: 'owner',
        map: { type: 'workspace', sourceId: 'w1' },
      });
      expect(space).toEqual({ id: 'sp-1', slug: 'team-sp1' });
      expect(rec.writesTo('spaces')).toEqual([]);
      expect(rec.writesTo('space_members')).toEqual([]);
      expect(map(rec)).toMatchObject([
        { source_type: 'workspace', source_id: 'w1', target_id: 'sp-1' },
      ]);
    });

    it('a comment: no second comment', async () => {
      const { rec, writer } = world();
      rec.respond = (q) =>
        /from "comments" where "id"/.test(q.sql) ? [{ id: 'c1' }] : [];
      await writer.createComment({
        id: 'c1',
        page: { id: PAGE_ID, spaceId: 's' } as any,
        text: 'hi',
        creatorId: 'u',
        createdAt: new Date(),
        map: { type: 'comment', sourceId: 'mc1' },
      });
      expect(rec.writesTo('comments')).toEqual([]);
      expect(map(rec)).toMatchObject([
        { source_type: 'comment', source_id: 'mc1', target_id: 'c1' },
      ]);
    });

    it('a share: no second share, its key kept, and its expiry still set from the source', async () => {
      const { rec, writer, setExact } = world();
      rec.respond = (q) =>
        /from "shares" where "id"/.test(q.sql)
          ? [{ id: 'sh-1', key: 'oldkey' }]
          : [];
      const expiresAt = new Date('2026-01-01T00:00:00Z');
      const { key } = await writer.createShare({
        id: 'sh-1',
        page: { id: PAGE_ID, spaceId: 's' } as any,
        includeSubPages: false,
        creatorId: 'u',
        expiry: { expiresAt, periodDays: 7 },
        map: { type: 'link', sourceId: 'p1' },
      });
      expect(key).toBe('oldkey');
      expect(rec.writesTo('shares')).toEqual([]);
      expect(setExact).toHaveBeenCalledWith(
        'sh-1',
        expiresAt,
        7,
        'u',
        expect.anything(),
      );
      expect(map(rec)).toMatchObject([
        { source_type: 'link', source_id: 'p1', target_id: 'sh-1' },
      ]);
    });
  });

  it('a block id taken by another page names that page in the failure', async () => {
    const { rec, writer } = world();
    rec.respond = (q) =>
      /from "live_blocks"/.test(q.sql)
        ? [{ id: 'b1', pageId: 'squatter-page', workspaceId: WS }]
        : [];
    await expect(
      writer.createLiveBlock({
        blockId: 'b1',
        page: { id: PAGE_ID, spaceId: 's' } as any,
        snapshot: { kind: 'whiteboard', elements: [], files: {} },
        creatorId: 'u',
      }),
    ).rejects.toThrow(
      'Block b1 is already used by page squatter-page of this workspace; delete that block, then run again',
    );
    expect(rec.writesTo('live_blocks')).toEqual([]);
  });

  describe('addSpaceMember', () => {
    it('inserts the member with the role it is given', async () => {
      const { rec, writer } = world();
      expect(await writer.addSpaceMember('sp-1', 'u-2', 'reader')).toBe(true);
      expect(rec.writesTo('space_members').map(insertValues)).toEqual([
        { space_id: 'sp-1', user_id: 'u-2', role: 'reader' },
      ]);
    });

    it('does nothing for a person who is already a member, and ignores a removed membership', async () => {
      const { rec, writer } = world();
      rec.respond = (q) =>
        /from "space_members"/.test(q.sql) ? [{ id: 'm-1' }] : [];
      expect(await writer.addSpaceMember('sp-1', 'u-2', 'writer')).toBe(false);
      expect(rec.writesTo('space_members')).toEqual([]);
      // the lookup only counts memberships that are not soft-deleted
      const lookup = rec.statements.find((q) =>
        /from "space_members"/.test(q.sql),
      );
      expect(lookup.sql).toMatch(/"deleted_at" is null/);
    });

    it('a member write and its map row are one transaction: a failing map write rolls the member back', async () => {
      const { rec, writer } = world();
      rec.respond = (q) =>
        /insert into "mindspace_import_map"/.test(q.sql)
          ? new Error('map write failed')
          : [];
      await expect(
        writer.addSpaceMember('sp-1', 'u-1', 'writer', {
          type: 'grant',
          sourceId: 'member:w1:m1',
        }),
      ).rejects.toThrow('map write failed');
      const member = rec.writesTo('space_members')[0];
      const mapRow = rec.statements.find((q) =>
        /insert into "mindspace_import_map"/.test(q.sql),
      );
      expect(member.tx).not.toBeNull();
      expect(mapRow.tx).toBe(member.tx);
      // a rewritten row is held again: its verified_at is cleared by the same statement
      expect(mapRow.sql).toMatch(
        /on conflict .* do update set "verified_at" = \$\d+/,
      );
      expect(rec.events).toContain(`rollback ${member.tx}`);
    });

    it('grantSpaceRole adds, raises a lower role, and keeps an equal or higher one', async () => {
      const { rec, writer } = world();
      expect(await writer.grantSpaceRole('sp-1', 'u-new', 'reader')).toBe(
        'added',
      );
      expect(rec.writesTo('space_members').map(insertValues)).toEqual([
        { space_id: 'sp-1', user_id: 'u-new', role: 'reader' },
      ]);

      for (const [current, wanted, outcome] of [
        ['reader', 'writer', 'raised'],
        ['writer', 'reader', 'kept'],
        ['admin', 'writer', 'kept'],
        ['writer', 'writer', 'kept'],
      ] as const) {
        const w = world();
        w.rec.respond = (q) =>
          /from "space_members"/.test(q.sql)
            ? [{ id: 'm-1', role: current }]
            : [];
        expect(await w.writer.grantSpaceRole('sp-1', 'u-1', wanted)).toBe(
          outcome,
        );
        const updates = w.rec.writesTo('space_members');
        if (outcome === 'raised') {
          expect(updates).toHaveLength(1);
          expect(updates[0].sql).toMatch(
            /^update "space_members" set "role" = \$1/,
          );
          expect(updates[0].parameters[0]).toBe(wanted);
        } else {
          expect(updates).toEqual([]);
        }
        // only live memberships count
        expect(
          w.rec.statements.find((q) => /from "space_members"/.test(q.sql)).sql,
        ).toMatch(/"deleted_at" is null/);
      }
    });

    it('grantSpaceRole refuses any role but writer and reader, before touching the database', async () => {
      for (const role of ['admin', 'owner', 'constructor', '', undefined]) {
        const { rec, writer } = world();
        await expect(
          writer.grantSpaceRole('sp-1', 'u-1', role as any),
        ).rejects.toThrow(/Not a role a share can grant/);
        expect(rec.statements).toEqual([]);
      }
    });

    it('through the people step: owner admin, editor writer, viewer reader', async () => {
      const users = [
        {
          id: 'd-ada',
          email: 'ada@acme.test',
          name: 'Ada',
          emailVerifiedAt: new Date(),
          deactivatedAt: null,
          deletedAt: null,
        },
        {
          id: 'd-grace',
          email: 'grace@acme.test',
          name: 'Grace',
          emailVerifiedAt: new Date(),
          deactivatedAt: null,
          deletedAt: null,
        },
        {
          id: 'd-linus',
          email: 'linus@acme.test',
          name: 'Linus',
          emailVerifiedAt: new Date(),
          deactivatedAt: null,
          deletedAt: null,
        },
      ];
      const rec = docmostLike(users, { id: WS, name: 'Acme' });
      const map = new DbImportMap(rec.db, WS);
      const { ctx } = testContext(
        {
          users: [
            msUser('m-ada', 'ada@acme.test'),
            msUser('m-grace', 'grace@acme.test'),
            msUser('m-linus', 'linus@acme.test'),
          ],
          workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
          members: [
            { workspaceId: 'w1', userId: 'm-grace', role: 'editor' },
            { workspaceId: 'w1', userId: 'm-linus', role: 'viewer' },
          ],
        },
        { map },
      );
      ctx.writer = new ImportWriter(rec.db, map, WS, { setExact: jest.fn() });
      ctx.docmost = new KyselyDocmostReader(rec.db, WS);
      await peopleStep.run(ctx);
      expect(
        rec.writesTo('space_members').map((w) => {
          const v = insertValues(w);
          return [v.user_id, v.role];
        }),
      ).toEqual([
        ['d-ada', 'admin'],
        ['d-grace', 'writer'],
        ['d-linus', 'reader'],
      ]);
    });
  });
});
