import { todo } from '@docmost/live-blocks';
import type { FakeData } from './fake-source';
import type { DocmostUser } from '../docmost-reader';
import type {
  MsComment,
  MsDocument,
  MsProject,
} from '../source/mindspace.types';

// A small mindspace with every case the import handles. Used by the specs and,
// through toSql(), to load a scratch database for rehearsals.

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const U = {
  ada: id(1),
  grace: id(2),
  linus: id(3),
  eve: id(4), // never confirmed her sign-up
  olga: id(5), // no docmost account
  ivan: id(6), // docmost account never verified
};
export const W = {
  team: id(101),
  personalGrace: id(102),
  personalAda: id(103),
  olga: id(104),
};
export const P = {
  board: id(201),
  tasks: id(202),
  docs: id(203),
  broken: id(204),
  empty: id(205),
  groceries: id(206),
  sketch: id(207),
  olgaBoard: id(208),
  olgaDocs: id(209),
  budget: id(210),
};
export const D = { overview: id(301), notes: id(302), olgaNote: id(303) };
export const C = {
  quoted: id(401),
  quotedReply1: id(402),
  quotedReply2: id(403),
  repeated: id(404),
  orphan: id(405),
  resolved: id(406),
  resolvedReply: id(407),
  outsider: id(408),
  deletedAuthor: id(409),
  olga: id(410),
};

const at = (iso: string) => new Date(iso);

/** A 1x1 PNG. */
export const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

const base = (extra: Record<string, unknown>) => ({
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 3,
  versionNonce: 7,
  isDeleted: false,
  boundElements: null,
  updated: 1735689600000,
  link: null,
  locked: false,
  ...extra,
});

export const whiteboardScene = {
  type: 'excalidraw',
  version: 2,
  source: 'https://mindspace.example.com',
  elements: [
    base({
      id: 'rect-1',
      type: 'rectangle',
      x: 40,
      y: 40,
      width: 260,
      height: 140,
      index: 'a0',
      backgroundColor: '#a5d8ff',
    }),
    base({
      id: 'ellipse-1',
      type: 'ellipse',
      x: 360,
      y: 60,
      width: 160,
      height: 110,
      index: 'a1',
      backgroundColor: '#ffec99',
    }),
    base({
      id: 'text-1',
      type: 'text',
      x: 70,
      y: 90,
      width: 190,
      height: 25,
      index: 'a2',
      text: 'Q3 roadmap',
      originalText: 'Q3 roadmap',
      fontSize: 20,
      fontFamily: 5,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
    }),
    base({
      id: 'image-1',
      type: 'image',
      x: 560,
      y: 60,
      width: 120,
      height: 120,
      index: 'a3',
      fileId: 'file-png-1',
      status: 'saved',
      scale: [1, 1],
      crop: null,
    }),
    base({
      id: 'gone-1',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      index: 'a4',
      isDeleted: true,
    }),
  ],
  appState: { viewBackgroundColor: '#ffffff', gridSize: null },
  files: {
    'file-png-1': {
      mimeType: 'image/png',
      id: 'file-png-1',
      dataURL: PNG_DATA_URL,
      created: 1735689600000,
    },
  },
};

/** Built with the ported board model, as mindspace's app would have saved it. */
export function tasksBoard() {
  const board = todo.createEmptyBoard();
  const card = board.columns[0];
  todo.renameColumn(board, card.id, 'Launch');
  const write = card.nodes[0];
  todo.setText(board, write.id, 'Write the announcement');
  const review = todo.addChild(
    board,
    write.id,
    todo.newTask('Review the copy'),
  );
  const ship = todo.addSiblingAfter(board, write.id, todo.newTask('Ship it'));
  todo.toggleDone(board, review.id);
  todo.cycleEffort(board, write.id);
  todo.cyclePriority(board, ship.id);
  todo.cyclePriority(board, ship.id);
  const later = todo.addColumn(board, { x: 400, y: 40 });
  todo.renameColumn(board, later.id, 'Later');
  const ideas = later.nodes[0];
  todo.setText(board, ideas.id, 'Ideas');
  todo.setNodeKind(board, ideas.id, 'section');
  todo.appendToColumn(board, later.id, todo.newTask('Write a blog post'));
  return board;
}

/**
 * A mindspace workbook as SheetProjectView saved it (serializeBook): two
 * tabs, formulas across tabs, a merge, formats, sizes and frozen panes.
 */
export function budgetBook() {
  const cells = (rows: string[][]) =>
    Object.fromEntries(
      rows.flatMap((r, row) =>
        r
          .map((v, col) => [`${row}:${col}`, { v }] as const)
          .filter(([, c]) => c.v !== ''),
      ),
    );
  return {
    version: 1,
    activeSheetId: 'tab-budget',
    sheets: [
      {
        id: 'tab-budget',
        name: 'Budget',
        rows: 60,
        cols: 26,
        cells: {
          ...cells([
            ['Item', 'Q1', 'Q2', 'Total'],
            ['Rent', '1200', '1250', '=SUM(B2:C2)'],
            ['Tools', '300', '450', '=SUM(B3:C3)'],
            ['Travel', '80', '640', '=SUM(B4:C4)'],
            ['Total', '=SUM(B2:B4)', '=SUM(C2:C4)', '=SUM(D2:D4)'],
          ]),
          '0:0': { v: 'Item', f: { bold: true, bg: '#e7f5ff' } },
          '5:0': { v: 'Tax' },
          '5:3': { v: '=D5*Rates!B1' },
          '6:0': { v: 'Notes span three columns' },
        },
        colWidths: { '0': 160 },
        rowHeights: { '0': 32 },
        frozenRows: 1,
        frozenCols: 1,
        merges: [{ r1: 6, c1: 0, r2: 6, c2: 2 }],
      },
      {
        id: 'tab-rates',
        name: 'Rates',
        rows: 20,
        cols: 5,
        cells: { '0:0': { v: 'Tax' }, '0:1': { v: '0.2' } },
        colWidths: {},
        rowHeights: {},
        frozenRows: 0,
        frozenCols: 0,
        merges: [],
      },
    ],
  };
}

export const overviewMarkdown = `# Design overview

The importer keeps the plan simple. Everyone can read it.

## Steps

- Read the source
- Write the pages
  - with their comments

| Kind | Becomes |
| --- | --- |
| whiteboard | a live block |
| doc | a page tree |

\`\`\`ts
const answer = 42;
\`\`\`

In short: we keep the plan simple and the history intact.
`;

const project = (
  p: Partial<MsProject> & Pick<MsProject, 'id' | 'workspaceId' | 'name'>,
): MsProject => ({
  kind: 'whiteboard',
  scene: null,
  position: 1024,
  visibility: 'private',
  linkExpiresAt: null,
  createdAt: at('2025-06-01T10:00:00Z'),
  updatedAt: at('2025-09-01T10:00:00Z'),
  ...p,
});

const doc = (d: Omit<MsDocument, 'updatedAt'>): MsDocument => ({
  ...d,
  updatedAt: at('2025-09-02T10:00:00Z'),
});
const comment = (
  c: Partial<MsComment> & Pick<MsComment, 'id' | 'documentId' | 'body'>,
): MsComment => ({
  parentId: null,
  anchorQuote: null,
  anchorPrefix: '',
  anchorSuffix: '',
  createdBy: U.ada,
  createdAt: at('2025-07-01T09:00:00Z'),
  resolvedAt: null,
  resolvedBy: null,
  ...c,
});

export function syntheticData(now = new Date()): FakeData {
  const day = 86_400_000;
  return {
    users: [
      {
        id: U.ada,
        email: 'ada@acme.test',
        emailConfirmedAt: at('2025-01-01T00:00:00Z'),
      },
      {
        id: U.grace,
        email: 'grace@acme.test',
        emailConfirmedAt: at('2025-01-01T00:00:00Z'),
      },
      {
        id: U.linus,
        email: 'LINUS@Acme.test',
        emailConfirmedAt: at('2025-01-01T00:00:00Z'),
      },
      { id: U.eve, email: 'eve@acme.test', emailConfirmedAt: null },
      {
        id: U.olga,
        email: 'olga@acme.test',
        emailConfirmedAt: at('2025-01-01T00:00:00Z'),
      },
      {
        id: U.ivan,
        email: 'ivan@acme.test',
        emailConfirmedAt: at('2025-01-01T00:00:00Z'),
      },
    ],
    workspaces: [
      {
        id: W.team,
        name: 'Team',
        ownerId: U.ada,
        createdAt: at('2025-02-01T00:00:00Z'),
      },
      {
        id: W.personalGrace,
        name: 'Personal',
        ownerId: U.grace,
        createdAt: at('2025-02-02T00:00:00Z'),
      },
      {
        id: W.personalAda,
        name: 'Personal',
        ownerId: U.ada,
        createdAt: at('2025-02-03T00:00:00Z'),
      },
      {
        id: W.olga,
        name: "Olga's notes",
        ownerId: U.olga,
        createdAt: at('2025-02-04T00:00:00Z'),
      },
    ],
    members: [
      { workspaceId: W.team, userId: U.grace, role: 'editor' },
      { workspaceId: W.team, userId: U.linus, role: 'viewer' },
      { workspaceId: W.team, userId: U.ivan, role: 'viewer' },
      { workspaceId: W.team, userId: U.eve, role: 'editor' },
      { workspaceId: W.olga, userId: U.ada, role: 'viewer' },
    ],
    projects: [
      project({
        id: P.board,
        workspaceId: W.team,
        name: 'Roadmap board',
        scene: whiteboardScene,
        position: 1024,
        visibility: 'link',
        linkExpiresAt: new Date(now.getTime() + 30 * day),
      }),
      project({
        id: P.tasks,
        workspaceId: W.team,
        name: 'Launch tasks',
        kind: 'todo',
        scene: tasksBoard(),
        position: 2048,
        visibility: 'link',
        linkExpiresAt: new Date(now.getTime() - 3 * day),
      }),
      project({
        id: P.docs,
        workspaceId: W.team,
        name: 'Design docs',
        kind: 'doc',
        position: 3072,
        visibility: 'link',
      }),
      project({
        id: P.broken,
        workspaceId: W.team,
        name: 'Broken sketch',
        // the column holds a string here, as old rows do, and it is cut short
        scene:
          '{"type":"excalidraw","elements":[{"id":"a","type":"rectangle","x":1',
        position: 4096,
      }),
      project({
        id: P.empty,
        workspaceId: W.team,
        name: 'Empty board',
        scene: null,
        position: 5120,
      }),
      project({
        id: P.groceries,
        workspaceId: W.personalGrace,
        name: 'Groceries',
        kind: 'todo',
        scene: tasksBoard(),
      }),
      project({
        id: P.sketch,
        workspaceId: W.personalAda,
        name: 'Sketch',
        scene: whiteboardScene,
      }),
      project({
        id: P.budget,
        workspaceId: W.team,
        name: 'Budget 2026',
        kind: 'sheet',
        // the column holds the workbook as a JSON string, as SheetProjectView saved it
        scene: JSON.stringify(budgetBook()),
        position: 6144,
      }),
      project({
        id: P.olgaBoard,
        workspaceId: W.olga,
        name: 'Olga board',
        scene: whiteboardScene,
      }),
      project({
        id: P.olgaDocs,
        workspaceId: W.olga,
        name: 'Olga docs',
        kind: 'doc',
        position: 2048,
      }),
    ],
    documents: [
      doc({
        id: D.overview,
        projectId: P.docs,
        name: 'Overview.md',
        content: overviewMarkdown,
        position: 0,
        createdAt: at('2025-06-02T10:00:00Z'),
      }),
      doc({
        id: D.notes,
        projectId: P.docs,
        name: 'Meeting notes.md',
        content:
          'Notes from Monday.\n\n- Agreed on the import\n- Next: rehearsal\n',
        position: 1,
        createdAt: at('2025-06-03T10:00:00Z'),
      }),
      doc({
        id: D.olgaNote,
        projectId: P.olgaDocs,
        name: 'Private.md',
        content: 'Only Olga sees this.',
        position: 0,
        createdAt: at('2025-06-04T10:00:00Z'),
      }),
    ],
    comments: [
      comment({
        id: C.quoted,
        documentId: D.overview,
        body: 'Can we name the source?',
        anchorQuote: 'Read the source',
        createdAt: at('2025-07-01T09:00:00Z'),
      }),
      comment({
        id: C.quotedReply1,
        documentId: D.overview,
        parentId: C.quoted,
        body: 'It is mindspace.',
        createdBy: U.grace,
        createdAt: at('2025-07-01T09:05:00Z'),
      }),
      comment({
        id: C.quotedReply2,
        documentId: D.overview,
        parentId: C.quoted,
        body: 'Thanks!',
        createdAt: at('2025-07-01T09:10:00Z'),
      }),
      comment({
        id: C.repeated,
        documentId: D.overview,
        body: 'Which plan? The second one.',
        anchorQuote: 'the plan simple',
        anchorPrefix: 'we keep ',
        anchorSuffix: ' and the',
        createdBy: U.grace,
        createdAt: at('2025-07-02T09:00:00Z'),
      }),
      comment({
        id: C.orphan,
        documentId: D.overview,
        body: 'This sentence was removed later.',
        anchorQuote: 'a sentence nobody kept',
        createdAt: at('2025-07-03T09:00:00Z'),
      }),
      comment({
        id: C.resolved,
        documentId: D.notes,
        body: 'When is the rehearsal?',
        anchorQuote: 'rehearsal',
        createdAt: at('2025-07-04T09:00:00Z'),
        resolvedAt: at('2025-07-05T09:00:00Z'),
        resolvedBy: U.grace,
      }),
      comment({
        id: C.resolvedReply,
        documentId: D.notes,
        parentId: C.resolved,
        body: 'Friday.',
        createdBy: U.grace,
        createdAt: at('2025-07-04T10:00:00Z'),
      }),
      comment({
        id: C.outsider,
        documentId: D.notes,
        body: 'I agree with this.',
        anchorQuote: 'Agreed on the import',
        createdBy: U.ivan,
        createdAt: at('2025-07-06T09:00:00Z'),
      }),
      comment({
        id: C.deletedAuthor,
        documentId: D.notes,
        body: 'Old remark.',
        anchorQuote: 'Notes from Monday',
        createdBy: null,
        createdAt: at('2025-07-07T09:00:00Z'),
      }),
      comment({
        id: C.olga,
        documentId: D.olgaNote,
        body: 'Mine.',
        anchorQuote: 'Only Olga',
        createdBy: U.olga,
      }),
    ],
    projectShares: [
      { projectId: P.board, email: 'friend@outside.test', role: 'viewer' },
    ],
  };
}

export const syntheticMindspace = {
  data: syntheticData(),
  docmostUsers: [
    {
      id: id(901),
      email: 'admin@acme.test',
      name: 'Admin',
      emailVerifiedAt: at('2025-01-01T00:00:00Z'),
      deactivatedAt: null,
      deletedAt: null,
      role: 'owner',
    },
    {
      id: id(902),
      email: 'ada@acme.test',
      name: 'Ada',
      emailVerifiedAt: at('2025-01-01T00:00:00Z'),
      deactivatedAt: null,
      deletedAt: null,
    },
    {
      id: id(903),
      email: 'grace@acme.test',
      name: 'Grace',
      emailVerifiedAt: at('2025-01-01T00:00:00Z'),
      deactivatedAt: null,
      deletedAt: null,
    },
    {
      id: id(904),
      email: 'linus@acme.test',
      name: 'Linus',
      emailVerifiedAt: at('2025-01-01T00:00:00Z'),
      deactivatedAt: null,
      deletedAt: null,
    },
    {
      id: id(905),
      email: 'eve@acme.test',
      name: 'Eve',
      emailVerifiedAt: at('2025-01-01T00:00:00Z'),
      deactivatedAt: null,
      deletedAt: null,
    },
    {
      id: id(906),
      email: 'ivan@acme.test',
      name: 'Ivan',
      emailVerifiedAt: null,
      deactivatedAt: null,
      deletedAt: null,
    },
  ] as DocmostUser[],
};

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object')
    return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

/** INSERT statements for a database that has the stub and mindspace's migrations. */
export function toSql(data: FakeData): string {
  const rows: string[] = ['begin;'];
  for (const u of data.users ?? []) {
    rows.push(
      `insert into auth.users (id, email, email_confirmed_at) values (${lit(u.id)}, ${lit(u.email)}, ${lit(u.emailConfirmedAt)});`,
    );
  }
  for (const w of data.workspaces ?? []) {
    rows.push(
      `insert into public.workspaces (id, name, owner_id, created_at) values (${lit(w.id)}, ${lit(w.name)}, ${lit(w.ownerId)}, ${lit(w.createdAt)});`,
    );
  }
  for (const m of data.members ?? []) {
    rows.push(
      `insert into public.workspace_members (workspace_id, user_id, role) values (${lit(m.workspaceId)}, ${lit(m.userId)}, ${lit(m.role)});`,
    );
  }
  for (const p of data.projects ?? []) {
    // a string scene is stored as a jsonb string, as old rows were
    const scene =
      typeof p.scene === 'string'
        ? `to_jsonb(${lit(p.scene)}::text)`
        : lit(p.scene);
    rows.push(
      `insert into public.projects (id, workspace_id, name, kind, scene, position, visibility, link_expires_at, created_at, updated_at) values (${lit(p.id)}, ${lit(p.workspaceId)}, ${lit(p.name)}, ${lit(p.kind)}, ${scene}, ${lit(p.position)}, ${lit(p.visibility)}, ${lit(p.linkExpiresAt)}, ${lit(p.createdAt)}, ${lit(p.updatedAt)});`,
    );
  }
  for (const d of data.documents ?? []) {
    rows.push(
      `insert into public.documents (id, project_id, name, content, position, created_at, updated_at) values (${lit(d.id)}, ${lit(d.projectId)}, ${lit(d.name)}, ${lit(d.content)}, ${lit(d.position)}, ${lit(d.createdAt)}, ${lit(d.updatedAt)});`,
    );
  }
  for (const c of data.comments ?? []) {
    const anchored = c.parentId === null;
    rows.push(
      `insert into public.document_comments (id, document_id, parent_id, body, anchor_quote, anchor_prefix, anchor_suffix, anchor_start, anchor_end, created_by, created_at, resolved_at, resolved_by) values (${lit(c.id)}, ${lit(c.documentId)}, ${lit(c.parentId)}, ${lit(c.body)}, ${lit(c.anchorQuote)}, ${lit(c.anchorPrefix)}, ${lit(c.anchorSuffix)}, ${anchored ? 0 : 'null'}, ${anchored ? (c.anchorQuote ?? '').length : 'null'}, ${lit(c.createdBy)}, ${lit(c.createdAt)}, ${lit(c.resolvedAt)}, ${lit(c.resolvedBy)});`,
    );
  }
  for (const s of data.projectShares ?? []) {
    rows.push(
      `insert into public.project_shares (project_id, email, role) values (${lit(s.projectId)}, ${lit(s.email)}, ${lit(s.role)});`,
    );
  }
  rows.push('commit;');
  return rows.join('\n') + '\n';
}
