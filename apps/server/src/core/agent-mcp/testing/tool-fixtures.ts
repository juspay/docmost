import { ForbiddenException, NotFoundException } from '@nestjs/common';
import * as Y from 'yjs';
import { McpDeps } from '../mcp-deps';
import { McpContext } from '../tool.types';
import { PatScope } from '../../access-token/access-token.service';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';
import { isLiveBlockNodeType } from '../../live-block/page-content.util';
import {
  applyOps,
  blockDocumentName,
  buildSnapshot,
  LiveBlockKind,
  LiveBlockOp,
} from '@docmost/live-blocks';
import { LiveBlockService } from '../../live-block/live-block.service';
import { WhiteboardFilesService } from '../../live-block/whiteboard-files.service';

// A small in-memory world with real access rules, so specs can check what a
// tool lets through rather than which mock it called.

export const WS = 'ws-1';
export const ALICE = { id: 'user-alice', workspaceId: WS, name: 'Alice' };
export const BOB = { id: 'user-bob', workspaceId: WS, name: 'Bob' };

export const SPACE_MINE = '11111111-1111-4111-8111-111111111111';
export const SPACE_OTHER = '22222222-2222-4222-8222-222222222222';
export const MISSING_UUID = '99999999-9999-4999-8999-999999999999';

type FakePage = {
  id: string;
  slugId: string;
  title: string;
  spaceId: string;
  workspaceId: string;
  parentPageId: string | null;
  deletedAt: Date | null;
  content: any;
  // user ids allowed to see this page; undefined means unrestricted
  allowed?: string[];
};

type FakeComment = {
  id: string;
  pageId: string;
  parentCommentId: string | null;
  selection: string | null;
  content: any;
  creatorName: string;
  createdAt: Date;
  resolvedAt: Date | null;
};

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

export function pageId(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const PAGES = {
  open: pageId(1),
  restricted: pageId(2),
  child: pageId(3),
  restrictedChild: pageId(4),
  foreign: pageId(5),
};

export const COMMENTS = {
  rootOpen: pageId(101),
  reply: pageId(102),
  rootResolved: pageId(103),
  rootOnRestrictedChild: pageId(104),
  rootOnChild: pageId(105),
};

// Live block rows every world starts with (see buildWorld). sheetOnOpen is not
// in its page's content (only its read-token call is used, which never runs);
// sheetOnRestricted is, so the registry's probe reaches the access check.
export const BLOCKS = {
  sheetOnOpen: '0193c7a0-2222-7abc-8def-000000000001',
  sheetOnRestricted: '0193c7a0-2222-7abc-8def-000000000002',
};

export function buildWorld() {
  const mk = (
    n: number,
    title: string,
    over: Partial<FakePage> = {},
  ): FakePage => ({
    id: pageId(n),
    slugId: `slug${n}`,
    title,
    spaceId: SPACE_MINE,
    workspaceId: WS,
    parentPageId: null,
    deletedAt: null,
    content: doc(`body of ${title}`),
    ...over,
  });

  const pages: FakePage[] = [
    mk(1, 'Open page'),
    mk(2, 'Restricted page', { allowed: [BOB.id] }),
    mk(3, 'Child page', { parentPageId: pageId(1) }),
    mk(4, 'Restricted child', { parentPageId: pageId(1), allowed: [BOB.id] }),
    mk(5, 'Foreign page', { spaceId: SPACE_OTHER }),
  ];

  const comments: FakeComment[] = [
    {
      id: COMMENTS.rootOpen,
      pageId: pageId(1),
      parentCommentId: null,
      selection: 'hello world',
      content: doc('Please check'),
      creatorName: 'Bob',
      createdAt: new Date('2026-01-01'),
      resolvedAt: null,
    },
    {
      id: COMMENTS.reply,
      pageId: pageId(1),
      parentCommentId: COMMENTS.rootOpen,
      selection: null,
      content: doc('Done'),
      creatorName: 'Alice',
      createdAt: new Date('2026-01-02'),
      resolvedAt: null,
    },
    {
      id: COMMENTS.rootResolved,
      pageId: pageId(1),
      parentCommentId: null,
      selection: 'second quote',
      content: doc('Old'),
      creatorName: 'Bob',
      createdAt: new Date('2026-01-03'),
      resolvedAt: new Date('2026-01-04'),
    },
    {
      id: COMMENTS.rootOnChild,
      pageId: pageId(3),
      parentCommentId: null,
      selection: 'child text',
      content: doc('On child'),
      creatorName: 'Bob',
      createdAt: new Date('2026-01-05'),
      resolvedAt: null,
    },
    {
      id: COMMENTS.rootOnRestrictedChild,
      pageId: pageId(4),
      parentCommentId: null,
      selection: 'secret',
      content: doc('Hidden'),
      creatorName: 'Bob',
      createdAt: new Date('2026-01-06'),
      resolvedAt: null,
    },
  ];

  // Alice writes in SPACE_MINE and is not a member of SPACE_OTHER.
  // a spec can demote someone with roles[`${userId}:${spaceId}`] = 'reader'
  const roles: Record<string, string | null> = {};
  const roleIn = (userId: string, spaceId: string): string | null => {
    const key = `${userId}:${spaceId}`;
    if (key in roles) return roles[key];
    return spaceId === SPACE_MINE
      ? userId === ALICE.id
        ? 'writer'
        : 'admin'
      : null;
  };

  const visible = (page: FakePage, userId: string) =>
    !!roleIn(userId, page.spaceId) &&
    (!page.allowed || page.allowed.includes(userId));

  const clone = (p: FakePage, includeContent?: boolean) => {
    const { content, allowed, ...rest } = p;
    return includeContent ? { ...rest, content } : { ...rest };
  };

  const find = (id: string) =>
    pages.find((p) => p.id === id || p.slugId === id);

  // a page is hidden when it or any ancestor is restricted away from the user
  const canSee = (page: FakePage, userId: string): boolean => {
    let cur: FakePage | undefined = page;
    while (cur) {
      if (!visible(cur, userId)) return false;
      cur = cur.parentPageId ? find(cur.parentPageId) : undefined;
    }
    return true;
  };

  const abilityFor = (role: string) => ({
    can: (action: string, _s: string) =>
      action === SpaceCaslAction.Read ||
      (role !== 'reader' &&
        [
          SpaceCaslAction.Edit,
          SpaceCaslAction.Create,
          SpaceCaslAction.Manage,
        ].includes(action as any)),
    cannot(action: string, subject: string) {
      return !this.can(action, subject);
    },
  });

  const calls = {
    created: [] as any[],
    titles: [] as any[],
    replies: [] as any[],
    resolves: [] as any[],
    flushed: [] as string[],
    flushOnlyIfOpen: [] as boolean[],
    titleRestores: [] as any[],
    audit: [] as any[],
  };
  // flushFails: what a flush of the page document throws, if anything
  const flags: { exportDisabled: boolean; flushFails?: Error } = {
    exportDisabled: false,
  };

  // One in-memory Yjs document per page, driven by the real collaboration
  // handler, so a spec sees what an open editor would see.
  const ydocs = new Map<string, Y.Doc>();
  const ydocFor = (documentName: string) => {
    let d = ydocs.get(documentName);
    if (!d) {
      d = new Y.Doc();
      ydocs.set(documentName, d);
    }
    return d;
  };
  const collaboration = {
    handleYjsEvent: async (
      event: string,
      documentName: string,
      payload: any,
      onlyIfOpen?: boolean,
    ) => {
      if (event === 'flushDocument') {
        calls.flushed.push(documentName);
        calls.flushOnlyIfOpen.push(!!onlyIfOpen);
        if (flags.flushFails) throw flags.flushFails;
        return undefined;
      }
      // lazy: the handler pulls in the editor schema, which not every spec needs
      const {
        CollaborationHandler,
      } = require('../../../collaboration/collaboration.handler');
      const hocuspocus = {
        documents: new Map(),
        debouncer: { executeNow: async () => undefined },
        openDirectConnection: async () => ({
          transact: async (fn: any) => {
            const d = ydocFor(documentName);
            d.transact(() => fn(d));
          },
          disconnect: async () => undefined,
        }),
      };
      return new CollaborationHandler()
        .getHandlers(hocuspocus)
        [event](documentName, payload);
    },
  };

  const commentFind = (id: string) => comments.find((c) => c.id === id);

  const deps = {
    pageRepo: {
      findById: async (id: string, opts?: { includeContent?: boolean }) => {
        const p = find(id);
        return p ? clone(p, opts?.includeContent) : undefined;
      },
      getPageAndDescendants: async (id: string) => {
        const out: FakePage[] = [];
        const walk = (pid: string) => {
          const p = find(pid)!;
          out.push(p);
          pages
            .filter((c) => c.parentPageId === p.id && !c.deletedAt)
            .forEach((c) => walk(c.id));
        };
        if (find(id)) walk(find(id)!.id);
        return out.map((p) => clone(p));
      },
    },
    pagePermissionRepo: {
      filterAccessiblePageIds: async (o: {
        pageIds: string[];
        userId: string;
      }) =>
        o.pageIds.filter((id) => {
          const p = find(id);
          return p && canSee(p, o.userId);
        }),
    },
    pageAccess: {
      validateCanView: async (page: any, user: any) => {
        const p = find(page.id)!;
        if (!canSee(p, user.id)) throw new ForbiddenException();
      },
      validateCanEdit: async (page: any, user: any) => {
        const p = find(page.id)!;
        if (!canSee(p, user.id)) throw new ForbiddenException();
        if (roleIn(user.id, p.spaceId) === 'reader')
          throw new ForbiddenException();
      },
      validateCanComment: async (page: any, user: any) => {
        const p = find(page.id)!;
        if (!canSee(p, user.id)) throw new ForbiddenException();
        // readers may not comment in this world
        if (roleIn(user.id, p.spaceId) === 'reader')
          throw new ForbiddenException();
      },
      validateCanExport: async () => {
        if (flags.exportDisabled) throw new ForbiddenException();
      },
      validateCanCreate: async (spaceId: string, user: any) => {
        const role = roleIn(user.id, spaceId);
        if (!role || role === 'reader') throw new ForbiddenException();
      },
    },
    spaceAbility: {
      createForUser: async (user: any, spaceId: string) => {
        const role = roleIn(user.id, spaceId);
        if (!role) throw new NotFoundException('Space permissions not found');
        return abilityFor(role);
      },
    },
    queries: {
      listUserSpaces: async (userId: string) =>
        [SPACE_MINE, SPACE_OTHER]
          .filter((s) => roleIn(userId, s))
          .map((s) => ({
            id: s,
            name: 'Mine',
            slug: 'mine',
            role: roleIn(userId, s)!,
          })),
      listPageRows: async (o: {
        spaceId: string;
        parentPageId?: string;
        afterId?: string;
        limit: number;
      }) =>
        pages
          .filter((p) => p.spaceId === o.spaceId && !p.deletedAt)
          .filter((p) => !o.parentPageId || p.parentPageId === o.parentPageId)
          .filter((p) => !o.afterId || p.id > o.afterId)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, o.limit)
          .map((p) => ({
            id: p.id,
            slugId: p.slugId,
            title: p.title,
            parentPageId: p.parentPageId,
          })),
      // what the SQL version selects: every live block node, at any depth
      listLiveBlockNodes: async (pageIds: string[]) =>
        pageIds.map((id) => {
          const nodes: unknown[] = [];
          const walk = (n: any) => {
            if (!n || typeof n !== 'object') return;
            if (isLiveBlockNodeType(n.type)) nodes.push(n);
            if (Array.isArray(n.content)) n.content.forEach(walk);
          };
          walk(find(id)?.content);
          return { id, nodes };
        }),
      // as the SQL one: a single conditional update
      restoreTitleIfUnchanged: async (
        id: string,
        expected: string,
        title: string,
      ) => {
        calls.titleRestores.push({ pageId: id, expected, title });
        const page = find(id);
        if (!page || page.title !== expected) return false;
        page.title = title;
        return true;
      },
      listDescendantIds: async (
        rootId: string,
        o: { fromId?: string; limit: number },
      ) => {
        const out: string[] = [];
        const walk = (pid: string) =>
          pages
            .filter((c) => c.parentPageId === pid && !c.deletedAt)
            .forEach((c) => {
              out.push(c.id);
              walk(c.id);
            });
        walk(rootId);
        return out
          .filter((id) => !o.fromId || id >= o.fromId)
          .sort()
          .slice(0, o.limit);
      },
      listThreadRows: async (pageIds: string[]) =>
        comments.filter((c) => pageIds.includes(c.pageId)),
    },
    commentRepo: {
      findById: async (id: string) => {
        const c = commentFind(id);
        return c
          ? {
              ...c,
              workspaceId: WS,
              deletedAt: null,
              creatorId: BOB.id,
              spaceId: find(c.pageId)!.spaceId,
            }
          : undefined;
      },
    },
    pageService: {
      create: async (_userId: string, _workspaceId: string, dto: any) => {
        calls.created.push(dto);
        const n = 1000 + calls.created.length;
        pages.push({
          id: pageId(n),
          slugId: `slug${n}`,
          title: dto.title,
          spaceId: dto.spaceId,
          workspaceId: WS,
          parentPageId: dto.parentPageId ?? null,
          deletedAt: null,
          content: dto.format === 'json' ? dto.content : null,
        });
        hooks.afterPageCreate?.(find(pageId(n))!);
        return {
          id: pageId(n),
          slugId: `slug${n}`,
          spaceId: dto.spaceId,
          workspaceId: WS,
        };
      },
      // as the real one: through the sync server's updatePageContent handler.
      // The stored content follows, as it does when that connection closes.
      updatePageContent: async (
        id: string,
        content: any,
        operation: string,
        _format: string,
        user: any,
      ) => {
        await hooks.beforeAppend?.(id, content);
        await collaboration.handleYjsEvent('updatePageContent', `page.${id}`, {
          operation,
          prosemirrorJson: content,
          user,
        });
        const page = find(id)!;
        const body = page.content?.content ?? [];
        page.content = {
          type: 'doc',
          content:
            operation === 'append'
              ? [...body, ...content.content]
              : [...content.content, ...body],
        };
      },
      update: async (page: any, dto: any) => {
        calls.titles.push({ pageId: page.id, title: dto.title });
        find(page.id)!.title = dto.title;
        return find(page.id);
      },
      parseProsemirrorContent: async (content: string, format: string) => {
        const { PageService } = require('../../page/services/page.service');
        return PageService.prototype.parseProsemirrorContent.call(
          {},
          content,
          format,
        );
      },
    },
    commentService: {
      create: async (opts: any, dto: any) => {
        const row = {
          id: pageId(200 + calls.replies.length),
          pageId: opts.page.id,
          parentCommentId: dto.parentCommentId ?? null,
          selection: null,
          content: JSON.parse(dto.content),
          creatorName: 'Alice',
          createdAt: new Date(),
          resolvedAt: null,
        };
        calls.replies.push({ ...row, userId: opts.user.id });
        comments.push(row);
        return row;
      },
      resolve: async (
        comment: any,
        resolved: boolean,
        _user: any,
        opts: any,
      ) => {
        calls.resolves.push({ id: comment.id, resolved, opts });
        const c = commentFind(comment.id)!;
        c.resolvedAt = resolved ? new Date() : null;
        return c;
      },
    },
    collaboration,
    audit: { log: (p: any) => calls.audit.push(p) },
    // the real export, so a spec sees what it does to live blocks
    exportService: {
      exportPage: async (format: string, page: any) => {
        const {
          ExportService,
        } = require('../../../integrations/export/export.service');
        return ExportService.prototype.exportPage.call(
          {
            liveBlockService: (deps as any).liveBlocks,
            getWorkspaceBaseUrl: async () => 'http://docs.test',
          },
          format,
          page,
        );
      },
    },
    domainService: { getWorkspaceUrl: () => 'http://docs.test' },
  };

  // Live blocks: rows in memory, and a sync server that holds some documents
  // open with edits it has not stored yet.
  const blockRows = new Map<string, any>();
  const openBlocks = new Map<string, Y.Doc>();
  const attachments: any[] = [];
  const uploads = new Map<string, Buffer>();
  // points where a spec can act as a browser or make a step fail
  const hooks: {
    afterPageCreate?: (page: FakePage) => void;
    beforeAppend?: (pageId: string, content: any) => Promise<void> | void;
    beforeInsertBlock?: (row: any) => void;
  } = {};
  const liveBlockRepo = {
    findById: async (
      id: string,
      opts?: { includeYdoc?: boolean; includeSnapshot?: boolean },
    ) => {
      const row = blockRows.get(id);
      if (!row || row.deletedAt) return undefined;
      const { ydoc, snapshot, ...rest } = row;
      return {
        ...rest,
        ...(opts?.includeYdoc ? { ydoc } : {}),
        ...(opts?.includeSnapshot ? { snapshot } : {}),
      };
    },
    findByPageIds: async (ids: string[]) =>
      [...blockRows.values()].filter(
        (r) => ids.includes(r.pageId) && !r.deletedAt,
      ),
    insertIfAbsent: async (row: any) => {
      hooks.beforeInsertBlock?.(row);
      if (!blockRows.has(row.id)) {
        blockRows.set(row.id, {
          ydoc: null,
          snapshot: null,
          deletedAt: null,
          updatedAt: new Date(),
          ...row,
        });
      }
      const { ydoc, snapshot, ...rest } = blockRows.get(row.id);
      return rest;
    },
    // as the real one: only while the document is the one the rebuild read
    saveRebuiltSnapshot: async (
      id: string,
      snapshot: unknown,
      ydocUpdatedAt: Date,
    ) => {
      const row = blockRows.get(id);
      if (!row || row.updatedAt?.getTime() !== ydocUpdatedAt?.getTime()) {
        return false;
      }
      row.snapshot = snapshot;
      row.snapshotError = null;
      return true;
    },
    softDelete: async (id: string) => {
      const row = blockRows.get(id);
      if (row && !row.deletedAt) row.deletedAt = new Date();
    },
    seedIfEmpty: async (id: string, ydoc: Buffer, snapshot: unknown) => {
      const row = blockRows.get(id);
      if (!row || row.ydoc) return false;
      row.ydoc = ydoc;
      row.snapshot = snapshot;
      row.updatedAt = new Date();
      return true;
    },
  };
  const loadBlockDoc = (id: string) => {
    let d = openBlocks.get(id);
    if (!d) {
      d = new Y.Doc();
      const row = blockRows.get(id);
      if (row?.ydoc) Y.applyUpdate(d, new Uint8Array(row.ydoc));
      openBlocks.set(id, d);
    }
    return d;
  };
  const storeBlock = (id: string) => {
    const d = openBlocks.get(id)!;
    const row = blockRows.get(id);
    row.ydoc = Buffer.from(Y.encodeStateAsUpdate(d));
    row.snapshot = buildSnapshot(row.kind as LiveBlockKind, d);
    row.updatedAt = new Date();
  };
  const bridge = {
    flushed: [] as string[],
    flushOnlyIfOpen: [] as boolean[],
    titleRestores: [] as any[],
    applied: [] as { blockId: string; ops: LiveBlockOp[] }[],
    liveDocumentsReachable: () => true,
    apply: async (blockId: string, kind: LiveBlockKind, ops: LiveBlockOp[]) => {
      bridge.applied.push({ blockId, ops });
      applyOps(kind, loadBlockDoc(blockId), ops);
    },
    flush: async (ids: string[]) => {
      const flushed = ids.filter((id) => openBlocks.has(id));
      flushed.forEach(storeBlock);
      bridge.flushed.push(...ids);
      return { flushed, unreachable: [] as string[] };
    },
  };
  const liveBlocks = new LiveBlockService(
    liveBlockRepo as any,
    deps.pageRepo as any,
    {} as any,
    deps.pageAccess as any,
    bridge as any,
    {} as any,
    {} as any,
    new WhiteboardFilesService(
      {
        insertAttachment: async (row: any) => {
          attachments.push(row);
          return row;
        },
      } as any,
      {
        upload: async (path: string, body: Buffer) => {
          uploads.set(path, body);
        },
      } as any,
      { getFileUploadSizeLimit: () => '50mb' } as any,
    ),
    { get: () => deps.pageService } as any,
  );
  Object.assign(deps, { liveBlocks, liveBlockRepo });

  /** A block row on a page, optionally also in the page's content. */
  const addBlock = (o: {
    id: string;
    kind: LiveBlockKind;
    pageId: string;
    inContent?: boolean;
    title?: string;
  }) => {
    blockRows.set(o.id, {
      id: o.id,
      kind: o.kind,
      pageId: o.pageId,
      workspaceId: WS,
      creatorId: ALICE.id,
      ydoc: null,
      snapshot: null,
      deletedAt: null,
      updatedAt: new Date(),
    });
    if (o.inContent !== false) {
      const page = find(o.pageId)!;
      const type = {
        whiteboard: 'whiteboard',
        todo: 'todoBoard',
        sheet: 'sheet',
      }[o.kind];
      page.content = {
        type: 'doc',
        content: [
          ...(page.content?.content ?? []),
          { type, attrs: { blockId: o.id, title: o.title ?? null } },
        ],
      };
    }
  };

  addBlock({
    id: BLOCKS.sheetOnOpen,
    kind: 'sheet',
    pageId: PAGES.open,
    inContent: false,
  });
  // in the content, so only the access check can refuse it
  addBlock({
    id: BLOCKS.sheetOnRestricted,
    kind: 'sheet',
    pageId: PAGES.restricted,
  });

  const ctx = (scope: PatScope = 'write', user: any = ALICE): McpContext => ({
    user: user as any,
    workspace: { id: WS } as any,
    scope,
    tokenId: `tok-${user.id}-${scope}`,
  });

  return {
    deps: deps as unknown as McpDeps,
    raw: deps,
    pages,
    comments,
    calls,
    roles,
    flags,
    ydocFor,
    ctx,
    blocks: {
      rows: blockRows,
      open: openBlocks,
      openDoc: loadBlockDoc,
      bridge,
      attachments,
      uploads,
      hooks,
      add: addBlock,
      documentName: blockDocumentName,
    },
  };
}

export type ToolFixture = {
  // arguments that succeed for Alice
  valid: Record<string, unknown>;
  // the same call aimed at something Alice cannot reach, and at an id that
  // does not exist; both must answer NOT_FOUND. null only for tools that take
  // no id at all.
  probes: {
    noAccess: Record<string, unknown>;
    missing: Record<string, unknown>;
  } | null;
};

// One entry per tool. A tool registered without an entry fails the registry spec.
export const toolFixtures: Record<string, ToolFixture> = {
  list_spaces: { valid: {}, probes: null },
  list_pages: {
    valid: { space_id: SPACE_MINE },
    probes: {
      noAccess: { space_id: SPACE_OTHER },
      missing: { space_id: MISSING_UUID },
    },
  },
  get_page_markdown: {
    valid: { page_id: PAGES.open },
    probes: {
      noAccess: { page_id: PAGES.restricted },
      missing: { page_id: MISSING_UUID },
    },
  },
  get_page_comments: {
    valid: { page_id: PAGES.open },
    probes: {
      noAccess: { page_id: PAGES.restricted },
      missing: { page_id: MISSING_UUID },
    },
  },
  create_page_from_markdown: {
    valid: { space_id: SPACE_MINE, title: 'New', content: '# Hi' },
    probes: {
      noAccess: { space_id: SPACE_OTHER, title: 'New', content: '# Hi' },
      missing: { space_id: MISSING_UUID, title: 'New', content: '# Hi' },
    },
  },
  update_page_markdown: {
    valid: { page_id: PAGES.open, content: 'changed' },
    probes: {
      noAccess: { page_id: PAGES.restricted, content: 'changed' },
      missing: { page_id: MISSING_UUID, content: 'changed' },
    },
  },
  reply_to_comment: {
    valid: { comment_id: COMMENTS.rootOpen, body: 'thanks' },
    probes: {
      noAccess: { comment_id: COMMENTS.rootOnRestrictedChild, body: 'thanks' },
      missing: { comment_id: MISSING_UUID, body: 'thanks' },
    },
  },
  resolve_comment: {
    valid: { comment_id: COMMENTS.rootOpen },
    probes: {
      noAccess: { comment_id: COMMENTS.rootOnRestrictedChild },
      missing: { comment_id: MISSING_UUID },
    },
  },
  create_whiteboard: {
    valid: { space_id: SPACE_MINE, title: 'Board' },
    probes: {
      noAccess: { space_id: SPACE_OTHER, title: 'Board' },
      missing: { page_id: MISSING_UUID, title: 'Board' },
    },
  },
  create_todo_board: {
    valid: { page_id: PAGES.open, title: 'Tasks' },
    probes: {
      noAccess: { page_id: PAGES.restricted, title: 'Tasks' },
      missing: { space_id: MISSING_UUID, title: 'Tasks' },
    },
  },
  create_sheet: {
    valid: { space_id: SPACE_MINE, title: 'Budget' },
    probes: {
      noAccess: { page_id: PAGES.restricted, title: 'Budget' },
      missing: { page_id: MISSING_UUID, title: 'Budget' },
    },
  },
  get_sheet: {
    valid: { block_id: BLOCKS.sheetOnOpen },
    probes: {
      noAccess: { block_id: BLOCKS.sheetOnRestricted },
      missing: { block_id: MISSING_UUID },
    },
  },
  set_sheet_cells: {
    valid: {
      block_id: BLOCKS.sheetOnOpen,
      cells: [{ a1: 'A1', value: '1' }],
    },
    probes: {
      noAccess: {
        block_id: BLOCKS.sheetOnRestricted,
        cells: [{ a1: 'A1', value: '1' }],
      },
      missing: { block_id: MISSING_UUID, cells: [{ a1: 'A1', value: '1' }] },
    },
  },
};
