// import-formatter pulls in an ESM-only package jest cannot load
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

import { EventEmitter2 } from '@nestjs/event-emitter';
import { DbImportMap, MemoryImportMap, targetId } from '../import-map';
import { ImportWriter } from '../import-writer';
import { KyselyDocmostReader } from '../docmost-reader';
import { docmostLike } from '../testing/recording-db';
import { RecordingWriter } from '../recording-writer';
import {
  msComment,
  msDocument,
  msProject,
  msUser,
  msWorkspace,
  type FakeData,
} from '../testing/fake-source';
import { overviewMarkdown } from '../testing/synthetic-mindspace';
import { WS, docmostUser, testContext } from '../testing/test-context';
import { createDocsStep, docsStep, markdownToDocument } from './docs.step';
import { peopleStep } from './people.step';
import { jsonToText } from '../../collaboration/collaboration.util';
import { sharesStep } from './shares.step';
import { projectsStep } from './projects.step';

const ada = docmostUser('d-ada', 'ada@acme.test', { name: 'Ada' });
const grace = docmostUser('d-grace', 'grace@acme.test', { name: 'Grace' });

const base: FakeData = {
  users: [
    msUser('m-ada', 'ada@acme.test'),
    msUser('m-grace', 'grace@acme.test'),
    msUser('m-out', 'outsider@acme.test'),
  ],
  workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
  projects: [
    msProject({
      id: 'dp',
      workspaceId: 'w1',
      kind: 'doc',
      name: 'Design docs',
    }),
  ],
};

const pageOfProject = targetId(WS, 'project', 'dp');
const pageOfDoc = (id: string) => targetId(WS, 'document', id);
const commentId = (id: string) => targetId(WS, 'comment', id);

async function run(
  data: FakeData,
  o: Parameters<typeof testContext>[1] = {},
  step = docsStep,
) {
  const world = testContext(
    { ...base, ...data },
    { users: [ada, grace], ...o },
  );
  await peopleStep.run(world.ctx);
  await step.run(world.ctx);
  return world;
}

/** Every text node of a document, with its comment mark ids. */
function marked(node: any, out: { text: string; comments: string[] }[] = []) {
  if (node.type === 'text') {
    out.push({
      text: node.text,
      comments: (node.marks ?? [])
        .filter((m: any) => m.type === 'comment')
        .map((m: any) => m.attrs.commentId),
    });
  }
  (node.content ?? []).forEach((c: any) => marked(c, out));
  return out;
}
const highlighted = (doc: unknown, id: string) =>
  marked(doc)
    .filter((t) => t.comments.includes(id))
    .map((t) => t.text)
    .join('');

describe('docs step', () => {
  it('a doc project becomes a parent page with one child page per document, in order', async () => {
    const { writer, ctx } = await run({
      documents: [
        msDocument({
          id: 'b',
          projectId: 'dp',
          name: 'Second.md',
          position: 1,
        }),
        msDocument({ id: 'a', projectId: 'dp', name: 'First.md', position: 0 }),
        msDocument({
          id: 'c',
          projectId: 'dp',
          name: 'notes.MD.md',
          position: 1,
          createdAt: new Date('2027-01-01'),
        }),
      ],
    });
    const root = writer.pages.get(pageOfProject);
    expect(root).toMatchObject({
      title: 'Design docs',
      parentPageId: null,
      creatorId: 'd-ada',
    });
    expect(root.content).toEqual({
      type: 'doc',
      content: [{ type: 'subpages' }],
    });
    const children = writer.operations
      .filter((o) => o.startsWith('page ') && o !== `page ${pageOfProject}`)
      .map((o) => writer.pages.get(o.slice(5)));
    expect(children.map((p) => p.title)).toEqual([
      'First',
      'Second',
      'notes.MD',
    ]);
    expect(children.every((p) => p.parentPageId === pageOfProject)).toBe(true);
    expect(await ctx.map.get('document', 'a')).toBe(pageOfDoc('a'));
    expect(ctx.report.links()).toEqual([
      {
        oldUrl: 'https://mind.example.com/p/dp',
        newUrl: `https://docs.example.com/s/${writer.spaces.get(targetId(WS, 'workspace', 'w1')).slug}/p/${root.slugId}`,
      },
    ]);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('boards, to-do boards and doc projects keep one interleaved sidebar order', async () => {
    const { writer, ctx } = testContext(
      {
        ...base,
        projects: [
          msProject({
            id: 'todo',
            workspaceId: 'w1',
            kind: 'todo',
            position: 3072,
          }),
          msProject({
            id: 'docs',
            workspaceId: 'w1',
            kind: 'doc',
            position: 2048,
          }),
          msProject({ id: 'board', workspaceId: 'w1', position: 1024 }),
          msProject({
            id: 'last-doc',
            workspaceId: 'w1',
            kind: 'doc',
            position: 4096,
          }),
        ],
      },
      { users: [ada, grace] },
    );
    // boards are made by the projects step, doc projects by this later step
    for (const step of [peopleStep, projectsStep, docsStep])
      await step.run(ctx);
    const roots = [...writer.pages.values()].filter((p) => !p.parentPageId);
    // docmost sorts siblings by position with byte order (collate "C")
    const order = roots
      .sort((a, b) =>
        a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
      )
      .map((p) => p.id);
    expect(order).toEqual(
      ['board', 'docs', 'todo', 'last-doc'].map((id) =>
        targetId(WS, 'project', id),
      ),
    );
  });

  it('markdown headings, lists, tables and code blocks convert', async () => {
    const { writer } = await run({
      documents: [
        msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
      ],
    });
    const content = writer.pages.get(pageOfDoc('o')).content as any;
    const types = content.content.map((n: any) => n.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'heading',
        'paragraph',
        'bulletList',
        'table',
        'codeBlock',
      ]),
    );
    expect(content.content[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 1 },
    });
    const list = content.content.find((n: any) => n.type === 'bulletList');
    // the nested item survives
    expect(JSON.stringify(list)).toContain('with their comments');
    const code = content.content.find((n: any) => n.type === 'codeBlock');
    expect(code.attrs.language).toBe('ts');
    expect(code.content[0].text).toBe('const answer = 42;');
  });

  it('a comment is highlighted on its quoted text', async () => {
    const { writer, ctx } = await run({
      documents: [
        msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
      ],
      comments: [
        msComment({
          id: 'c1',
          documentId: 'o',
          anchorQuote: 'Read the source',
          createdBy: 'm-ada',
        }),
      ],
    });
    const doc = writer.pages.get(pageOfDoc('o')).content;
    expect(highlighted(doc, commentId('c1'))).toBe('Read the source');
    expect(writer.comments.get(commentId('c1'))).toMatchObject({
      pageId: pageOfDoc('o'),
      parentCommentId: null,
    });
    expect(ctx.report.get('comment.imported')).toBe(1);
  });

  it('a repeated quote is placed using prefix and suffix', async () => {
    const { writer } = await run({
      documents: [
        msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
      ],
      comments: [
        msComment({
          id: 'c1',
          documentId: 'o',
          anchorQuote: 'the plan simple',
          anchorPrefix: 'we keep ',
          anchorSuffix: ' and the',
        }),
      ],
    });
    const texts = marked(writer.pages.get(pageOfDoc('o')).content);
    const hit = texts.findIndex((t) => t.comments.includes(commentId('c1')));
    expect(texts[hit].text).toBe('the plan simple');
    // the second occurrence, the one after "we keep "
    expect(texts[hit - 1].text.endsWith('we keep ')).toBe(true);
  });

  it('a comment whose quote is gone is imported without a highlight and counted', async () => {
    const { writer, ctx } = await run({
      documents: [
        msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
      ],
      comments: [
        msComment({
          id: 'gone',
          documentId: 'o',
          anchorQuote: 'a sentence nobody kept',
        }),
      ],
    });
    expect(
      highlighted(writer.pages.get(pageOfDoc('o')).content, commentId('gone')),
    ).toBe('');
    expect(writer.comments.has(commentId('gone'))).toBe(true);
    expect(ctx.report.get('comment.orphaned')).toBe(1);
    expect(ctx.report.warningsOf('comment-orphaned')).toEqual([
      { documentId: 'o', commentId: 'gone', quote: 'a sentence nobody kept' },
    ]);
    expect(ctx.report.losses()).toEqual([]);
  });

  it('replies stay under their root and keep their order', async () => {
    const { writer } = await run({
      documents: [
        msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
      ],
      comments: [
        msComment({
          id: 'r2',
          documentId: 'o',
          parentId: 'root',
          createdAt: new Date('2025-01-03'),
        }),
        msComment({
          id: 'root',
          documentId: 'o',
          anchorQuote: 'Read the source',
          createdAt: new Date('2025-01-01'),
        }),
        msComment({
          id: 'r1',
          documentId: 'o',
          parentId: 'root',
          createdAt: new Date('2025-01-02'),
        }),
      ],
    });
    const order = writer.operations
      .filter((o) => o.startsWith('comment '))
      .map((o) => o.slice(8));
    expect(order).toEqual([
      commentId('root'),
      commentId('r1'),
      commentId('r2'),
    ]);
    expect(writer.comments.get(commentId('r1')).parentCommentId).toBe(
      commentId('root'),
    );
    expect(writer.comments.get(commentId('r2')).parentCommentId).toBe(
      commentId('root'),
    );
  });

  it('a resolved thread is resolved in docmost with the mapped resolver', async () => {
    const resolvedAt = new Date('2025-08-01T12:00:00Z');
    const { writer } = await run({
      documents: [
        msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
      ],
      comments: [
        msComment({
          id: 'c1',
          documentId: 'o',
          anchorQuote: 'Read the source',
          resolvedAt,
          resolvedBy: 'm-grace',
        }),
        msComment({ id: 'r', documentId: 'o', parentId: 'c1' }),
      ],
    });
    expect(writer.comments.get(commentId('c1'))).toMatchObject({
      resolvedAt,
      resolvedById: 'd-grace',
    });
    expect(writer.comments.get(commentId('r'))).toMatchObject({
      resolvedAt: null,
      resolvedById: null,
    });
    const mark = marked(writer.pages.get(pageOfDoc('o')).content).find(
      (t) => t.comments.length,
    );
    expect(mark.text).toBe('Read the source');
    const raw = JSON.stringify(writer.pages.get(pageOfDoc('o')).content);
    expect(raw).toContain(`"commentId":"${commentId('c1')}","resolved":true`);
  });

  it('an unmatched author is attributed to the fallback owner with the email noted', async () => {
    const { writer } = await run({
      documents: [
        msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
      ],
      comments: [
        msComment({
          id: 'c1',
          documentId: 'o',
          body: 'I agree.',
          createdBy: 'm-out',
          anchorQuote: 'Read the source',
        }),
      ],
    });
    expect(writer.comments.get(commentId('c1')).creatorId).toBe(
      'fallback-user',
    );
    expect(writer.commentTexts.get(commentId('c1'))).toBe(
      '(from outsider@acme.test) I agree.',
    );
  });

  it('a comment with no author is attributed to the fallback owner and says so', async () => {
    const { writer } = await run({
      documents: [
        msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
      ],
      comments: [
        msComment({
          id: 'c1',
          documentId: 'o',
          body: 'Old remark.',
          createdBy: null,
          anchorQuote: 'Read the source',
        }),
      ],
    });
    expect(writer.comments.get(commentId('c1')).creatorId).toBe(
      'fallback-user',
    );
    expect(writer.commentTexts.get(commentId('c1'))).toBe(
      '(from a deleted mindspace user) Old remark.',
    );
  });

  it('comment timestamps are preserved', async () => {
    const createdAt = new Date('2024-12-24T18:30:00Z');
    const { writer } = await run({
      documents: [
        msDocument({
          id: 'o',
          projectId: 'dp',
          content: overviewMarkdown,
          createdAt: new Date('2024-12-01'),
        }),
      ],
      comments: [
        msComment({
          id: 'c1',
          documentId: 'o',
          anchorQuote: 'Read the source',
          createdAt,
          createdBy: 'm-ada',
        }),
      ],
    });
    expect(writer.comments.get(commentId('c1')).createdAt).toEqual(createdAt);
    expect(writer.pages.get(pageOfDoc('o')).createdAt).toEqual(
      new Date('2024-12-01'),
    );
  });

  it("document and doc project pages keep mindspace's updated date", async () => {
    const updatedAt = new Date('2025-10-10T10:10:10Z');
    const { writer } = await run({
      projects: [
        msProject({
          id: 'dp',
          workspaceId: 'w1',
          kind: 'doc',
          name: 'Design docs',
          updatedAt,
        }),
      ],
      documents: [
        msDocument({
          id: 'o',
          projectId: 'dp',
          updatedAt: new Date('2025-10-11T00:00:00Z'),
        }),
      ],
    });
    expect(writer.pages.get(pageOfProject).updatedAt).toEqual(updatedAt);
    expect(writer.pages.get(pageOfDoc('o')).updatedAt).toEqual(
      new Date('2025-10-11T00:00:00Z'),
    );
  });

  it('importing comments emits no notification or audit event', async () => {
    const emit = jest.spyOn(EventEmitter2.prototype, 'emit');
    const rec = docmostLike([ada, grace], { id: WS, name: 'Acme' });
    const map = new DbImportMap(rec.db, WS);
    const world = testContext(
      {
        ...base,
        documents: [
          msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
        ],
        comments: [
          msComment({
            id: 'c1',
            documentId: 'o',
            anchorQuote: 'Read the source',
            body: '@grace look',
          }),
          msComment({
            id: 'r1',
            documentId: 'o',
            parentId: 'c1',
            createdBy: 'm-grace',
          }),
        ],
      },
      { users: [ada, grace], map },
    );
    // the real writer and reader, over a database that records every statement
    world.ctx.writer = new ImportWriter(rec.db, map, WS, {
      setExact: jest.fn(),
    });
    world.ctx.docmost = new KyselyDocmostReader(rec.db, WS);
    await peopleStep.run(world.ctx);
    await docsStep.run(world.ctx);

    expect(rec.writesTo('comments')).toHaveLength(2);
    const tables = new Set(
      rec
        .writes()
        .map(
          (w) =>
            /^(?:insert into|update|delete from) "([a-z_]+)"/.exec(w.sql)[1],
        ),
    );
    // no notifications, watchers, audit or history rows
    expect([...tables].sort()).toEqual([
      'comments',
      'mindspace_import_map',
      'pages',
      'space_members',
      'spaces',
    ]);
    expect(emit).not.toHaveBeenCalled();
    emit.mockRestore();
  });

  it('a quote is kept as the selection, cut at 250 characters as docmost does', async () => {
    const quote = 'x'.repeat(300);
    const { writer } = await run({
      documents: [
        msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
      ],
      comments: [msComment({ id: 'c1', documentId: 'o', anchorQuote: quote })],
    });
    expect(writer.comments.get(commentId('c1')).selection).toBe(
      'x'.repeat(250),
    );
  });

  it('a second run creates no second page and no second comment', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const data = {
      documents: [
        msDocument({ id: 'o', projectId: 'dp', content: overviewMarkdown }),
      ],
      comments: [
        msComment({
          id: 'c1',
          documentId: 'o',
          anchorQuote: 'Read the source',
        }),
        msComment({ id: 'r1', documentId: 'o', parentId: 'c1' }),
      ],
    };
    await run(data, { map, writer });
    const before = writer.operations.length;
    const { ctx } = await run(data, { map, writer });
    expect(writer.operations.length).toBe(before);
    expect(ctx.report.get('doc-project.already-imported')).toBe(1);
    expect(ctx.report.get('document.already-imported')).toBe(1);
    expect(ctx.report.get('comment.already-imported')).toBe(2);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('documents and comments of a workspace that was not migrated are counted as skipped', async () => {
    const { ctx, writer } = await run({
      users: [
        msUser('m-ada', 'ada@acme.test'),
        msUser('m-olga', 'olga@acme.test'),
      ],
      workspaces: [msWorkspace('w1', 'Olga', 'm-olga')],
      documents: [msDocument({ id: 'o', projectId: 'dp' })],
      comments: [msComment({ id: 'c1', documentId: 'o', anchorQuote: 'x' })],
    });
    expect(writer.pages.size).toBe(0);
    expect(ctx.report.get('doc-project.skipped.owner-unmatched')).toBe(1);
    expect(ctx.report.get('document.skipped.owner-unmatched')).toBe(1);
    expect(ctx.report.get('comment.skipped.owner-unmatched')).toBe(1);
    expect(ctx.report.mismatches()).toEqual([]);
  });

  it('a document whose markdown cannot be converted keeps its text and is recorded as a loss', async () => {
    const { writer, ctx } = await run(
      {
        documents: [
          msDocument({ id: 'o', projectId: 'dp', content: '# Title\n\nbody' }),
        ],
      },
      {},
      createDocsStep(() => Promise.reject(new Error('parser crashed'))),
    );
    const page = writer.pages.get(pageOfDoc('o'));
    expect(page.content).toEqual({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'markdown' },
          content: [{ type: 'text', text: '# Title\n\nbody' }],
        },
      ],
    });
    expect(ctx.report.losses()).toEqual([
      {
        code: 'document-convert-failed',
        projectId: 'dp',
        detail: { documentId: 'o', reason: 'parser crashed' },
      },
    ]);
  });

  it('a conversion failure is reported again on a later run', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const failing = createDocsStep(() =>
      Promise.reject(new Error('parser crashed')),
    );
    const data = {
      documents: [msDocument({ id: 'o', projectId: 'dp', content: 'x' })],
    };
    await run(data, { map, writer }, failing);
    const { ctx } = await run(data, { map, writer }, failing);
    expect(ctx.report.get('document.already-imported')).toBe(1);
    expect(ctx.report.losses().map((l) => l.code)).toEqual([
      'document-convert-failed',
    ]);
  });

  it('a doc-project page deleted in docmost is a warning; the step goes on and shares still run', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const data = {
      projects: [
        msProject({
          id: 'gone',
          workspaceId: 'w1',
          kind: 'doc',
          position: 1024,
          visibility: 'link',
        }),
        msProject({
          id: 'kept',
          workspaceId: 'w1',
          kind: 'doc',
          position: 2048,
        }),
      ],
      documents: [
        msDocument({ id: 'g1', projectId: 'gone', content: 'Gone.' }),
        msDocument({ id: 'k1', projectId: 'kept', content: 'Kept.' }),
      ],
    };
    const all = (world: ReturnType<typeof testContext>) =>
      [peopleStep, docsStep, sharesStep].reduce(
        (p, st) => p.then(() => st.run(world.ctx)),
        Promise.resolve(),
      );
    await all(
      testContext({ ...base, ...data }, { users: [ada, grace], map, writer }),
    );
    // a space admin deletes the page for good
    writer.pages.delete(targetId(WS, 'project', 'gone'));
    writer.pages.delete(targetId(WS, 'document', 'g1'));

    const again = testContext(
      { ...base, ...data },
      { users: [ada, grace], map, writer },
    );
    await expect(all(again)).resolves.toBeUndefined();
    expect(again.ctx.report.warningsOf('target-page-missing')).toEqual([
      expect.objectContaining({ projectId: 'gone', kind: 'doc-project' }),
      expect.objectContaining({ projectId: 'gone', kind: 'link' }),
    ]);
    // counted once each: the two projects as already imported
    expect(again.ctx.report.get('doc-project.already-imported')).toBe(2);
    expect(again.ctx.report.get('document.skipped.page-missing')).toBe(1);
    expect(again.ctx.report.get('link.skipped.page-missing')).toBe(1);
    expect(again.ctx.report.get('document.already-imported')).toBe(1);
    // not a failure of this run
    expect(again.ctx.report.mismatches()).toEqual([]);
  });

  it('text between two leading --- lines is kept, not taken for front matter', async () => {
    const md = '---\n# Plan\nImportant text\n\n---\n# Next\nmore';
    const text = jsonToText((await markdownToDocument(md)) as any);
    for (const word of ['Plan', 'Important', 'text', 'Next', 'more'])
      expect(text).toContain(word);
  });

  it('a real YAML front matter block is kept as text too', async () => {
    const md = '---\ntitle: Roadmap\nowner: ada\n---\n# Roadmap\nBody';
    const text = jsonToText((await markdownToDocument(md)) as any);
    expect(text).toContain('title: Roadmap');
    expect(text).toContain('Body');
  });

  it('a missing root explains only documents imported before; one never imported is a failure', async () => {
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);
    const data = {
      projects: [msProject({ id: 'gone', workspaceId: 'w1', kind: 'doc' })],
      documents: [msDocument({ id: 'g1', projectId: 'gone', content: 'One.' })],
    };
    await run(data, { map, writer });
    writer.pages.delete(targetId(WS, 'project', 'gone'));
    const later = {
      ...data,
      documents: [
        ...data.documents,
        msDocument({ id: 'g2', projectId: 'gone', content: 'Two.' }),
      ],
    };
    const again = await run(later, { map, writer });
    expect(again.ctx.report.get('document.skipped.page-missing')).toBe(1);
    expect(again.ctx.report.get('document.failed.parent-missing')).toBe(1);
    expect(again.ctx.report.mismatches()).toEqual([
      expect.stringMatching(/^document: 1 failed \(parent-missing\)/),
    ]);
  });
});
