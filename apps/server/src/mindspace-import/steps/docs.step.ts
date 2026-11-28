import { markdownToHtml } from '@docmost/editor-ext';
import type { Page } from '@docmost/db/types/entity.types';
import { htmlToJson } from '../../collaboration/collaboration.util';
import { loadImportHtml } from '../../integrations/import/utils/import-dates';
import { normalizeImportHtml } from '../../integrations/import/utils/import-formatter';
import {
  reanchorComments,
  type AnchorHint,
} from '../../core/agent-mcp/comment-reanchor.util';
import { targetId } from '../import-map';
import type { ImportWriterPort } from '../import-writer';
import {
  alreadyImported,
  eachItem,
  pageMissing,
  type ImportContext,
  type ImportStep,
} from '../runner';
import type {
  MsComment,
  MsDocument,
  MsProject,
} from '../source/mindspace.types';
import { ensurePeople } from './people.step';
import {
  oldProjectUrl,
  pageLink,
  projectPosition,
  sidebarOrder,
  spaceFor,
} from './projects.step';

/** The same steps as ImportService.processMarkdown, without the service. */
/** A leading rule is text to keep, not YAML front matter (see below). */
export function keepLeadingRule(markdown: string): string {
  return /^\s*---/.test(markdown) ? `<!-- -->\n${markdown}` : markdown;
}

export async function markdownToDocument(markdown: string): Promise<unknown> {
  // markdownToHtml drops everything between a leading --- and the next one
  // as YAML front matter; mindspace has none, so a leading rule (or real
  // front matter) is text to keep. An HTML comment line in front stops the
  // strip and renders as nothing.
  const html = await markdownToHtml(keepLeadingRule(markdown));
  const $ = loadImportHtml(html);
  normalizeImportHtml($, $.root());
  return htmlToJson($.html() || '');
}

export const SUBPAGES_CONTENT = {
  type: 'doc',
  content: [{ type: 'subpages' }],
};

export const documentTitle = (name: string) =>
  name.replace(/\.md$/i, '') || name;

/** Keeps every character when the markdown cannot be converted. */
const markdownAsCode = (markdown: string) => ({
  type: 'doc',
  content: [
    {
      type: 'codeBlock',
      attrs: { language: 'markdown' },
      content: markdown ? [{ type: 'text', text: markdown }] : [],
    },
  ],
});

const byCreated = (a: MsComment, b: MsComment) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
  (a.id < b.id ? -1 : 1);

type Thread = { root: MsComment; replies: MsComment[] };

/** Roots in time order, each with its replies in time order (a reply to a reply joins its root). */
function threadsOf(comments: MsComment[]): Thread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c: MsComment): MsComment => {
    const seen = new Set<string>();
    let at = c;
    while (at.parentId && byId.has(at.parentId) && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.parentId);
    }
    return at;
  };
  const threads = new Map<string, Thread>();
  for (const c of [...comments].sort(byCreated)) {
    const root = rootOf(c);
    if (!threads.has(root.id)) threads.set(root.id, { root, replies: [] });
    if (root.id !== c.id) threads.get(root.id).replies.push(c);
  }
  return [...threads.values()];
}

function author(ctx: ImportContext, createdBy: string | null) {
  if (!createdBy)
    return {
      creatorId: ctx.fallbackOwner.id,
      note: '(from a deleted mindspace user) ',
    };
  const mapped = ctx.state.users.get(createdBy);
  if (mapped) return { creatorId: mapped, note: '' };
  const email = ctx.state.emails.get(createdBy) ?? 'an unknown mindspace user';
  return {
    creatorId: ctx.fallbackOwner.id,
    note: `(from ${email.toLowerCase()}) `,
  };
}

async function writeComment(
  ctx: ImportContext,
  w: ImportWriterPort,
  page: Page,
  c: MsComment,
  rootTarget?: string,
) {
  const { creatorId, note } = author(ctx, c.createdBy);
  const isRoot = !rootTarget;
  const resolvedAt =
    isRoot && c.resolvedAt ? new Date(c.resolvedAt) : undefined;
  await w.createComment({
    id: targetId(ctx.workspaceId, 'comment', c.id),
    page,
    parentCommentId: rootTarget,
    text: note + c.body,
    selection: isRoot ? (c.anchorQuote ?? undefined) : undefined,
    creatorId,
    createdAt: new Date(c.createdAt),
    resolvedAt,
    resolvedById: resolvedAt
      ? ((c.resolvedBy && ctx.state.users.get(c.resolvedBy)) ??
        ctx.fallbackOwner.id)
      : undefined,
    map: { type: 'comment', sourceId: c.id },
  });
}

async function importDocument(
  ctx: ImportContext,
  convert: (markdown: string) => Promise<unknown>,
  project: MsProject,
  d: MsDocument,
  parent: Page,
  ownerId: string,
  threads: Thread[],
) {
  let content: unknown;
  try {
    content = await convert(d.content ?? '');
  } catch (err) {
    ctx.report.loss('document-convert-failed', project.id, {
      documentId: d.id,
      reason: (err as Error).message,
    });
    content = markdownAsCode(d.content ?? '');
  }

  const hints: AnchorHint[] = threads
    .filter((t) => t.root.anchorQuote)
    .map((t) => ({
      commentId: targetId(ctx.workspaceId, 'comment', t.root.id),
      quote: t.root.anchorQuote,
      prefix: t.root.anchorPrefix,
      suffix: t.root.anchorSuffix,
      resolved: !!t.root.resolvedAt,
    }));
  const placed = reanchorComments(content, hints);
  const orphaned = new Set(placed.orphaned);

  // the page carries the highlights, so it and its comments go in together
  await ctx.writer.inTransaction(async (w) => {
    const page = await w.createPage({
      id: targetId(ctx.workspaceId, 'document', d.id),
      spaceId: parent.spaceId,
      parentPageId: parent.id,
      title: documentTitle(d.name),
      content: placed.doc,
      creatorId: ownerId,
      createdAt: new Date(d.createdAt),
      updatedAt: new Date(d.updatedAt ?? d.createdAt),
      map: { type: 'document', sourceId: d.id },
    });
    for (const t of threads) {
      await writeComment(ctx, w, page, t.root);
      const rootTarget = targetId(ctx.workspaceId, 'comment', t.root.id);
      for (const r of t.replies)
        await writeComment(ctx, w, page, r, rootTarget);
    }
  });

  for (const t of threads) {
    const rootTarget = targetId(ctx.workspaceId, 'comment', t.root.id);
    if (!t.root.anchorQuote || orphaned.has(rootTarget)) {
      ctx.report.count('comment.orphaned');
      ctx.report.warn('comment-orphaned', {
        documentId: d.id,
        commentId: t.root.id,
        quote: t.root.anchorQuote,
      });
    }
    ctx.report.count('comment.imported', 1 + t.replies.length);
  }
}

/** Comments added to mindspace after their document was imported: kept, without a highlight. */
async function importLateComments(
  ctx: ImportContext,
  page: Page,
  threads: Thread[],
) {
  for (const t of threads) {
    const rootTarget = targetId(ctx.workspaceId, 'comment', t.root.id);
    const rootDone = await alreadyImported(
      ctx,
      'comment',
      t.root.id,
      'comment',
    );
    const pending = [];
    for (const r of t.replies) {
      if (!(await alreadyImported(ctx, 'comment', r.id, 'comment')))
        pending.push(r);
    }
    if (rootDone && pending.length === 0) continue;
    await ctx.writer.inTransaction(async (w) => {
      if (!rootDone) await writeComment(ctx, w, page, t.root);
      for (const r of pending) await writeComment(ctx, w, page, r, rootTarget);
    });
    if (!rootDone) {
      ctx.report.count('comment.orphaned');
      ctx.report.warn('comment-orphaned', {
        documentId: page.id,
        commentId: t.root.id,
        quote: t.root.anchorQuote,
      });
    }
    ctx.report.count('comment.imported', (rootDone ? 0 : 1) + pending.length);
  }
}

export function createDocsStep(
  convert: (markdown: string) => Promise<unknown> = markdownToDocument,
): ImportStep {
  return {
    name: 'docs',
    async run(ctx) {
      await ensurePeople(ctx);
      const [all, workspaces, documents, comments] = await Promise.all([
        ctx.source.projects(),
        ctx.source.workspaces(),
        ctx.source.documents(),
        ctx.source.comments(),
      ]);
      const projects = sidebarOrder(
        all.filter((p) => p.kind === 'doc'),
        workspaces,
      );
      const projectIds = new Set(projects.map((p) => p.id));
      const docsOf = (projectId: string) =>
        documents
          .filter((d) => d.projectId === projectId)
          .sort(
            (a, b) =>
              a.position - b.position ||
              new Date(a.createdAt).getTime() -
                new Date(b.createdAt).getTime() ||
              (a.id < b.id ? -1 : 1),
          );
      const commentsOf = (documentId: string) =>
        comments.filter((c) => c.documentId === documentId);

      ctx.report.count('doc-project.source', projects.length);
      ctx.state.failedProjects ??= new Set();
      ctx.state.missingPages ??= new Set();
      const docDocuments = documents.filter((d) => projectIds.has(d.projectId));
      const docDocumentIds = new Set(docDocuments.map((d) => d.id));
      ctx.report.count('document.source', docDocuments.length);
      ctx.report.count(
        'comment.source',
        comments.filter((c) => docDocumentIds.has(c.documentId)).length,
      );

      for (const p of projects) {
        const target = await spaceFor(ctx, p);
        const docs = docsOf(p.id);
        if ('skipped' in target) {
          ctx.report.count(`doc-project.skipped.${target.skipped}`);
          ctx.report.count(`document.skipped.${target.skipped}`, docs.length);
          ctx.report.count(
            `comment.skipped.${target.skipped}`,
            docs.reduce((n, d) => n + commentsOf(d.id).length, 0),
          );
          continue;
        }

        const commentCount = (list: MsDocument[]) =>
          list.reduce((n, d) => n + commentsOf(d.id).length, 0);
        const made = await eachItem(ctx, 'doc-project', p.id, async () => {
          const rootId = await alreadyImported(
            ctx,
            'project',
            p.id,
            'doc-project',
          );
          if (rootId) {
            const page = await ctx.docmost.page(rootId);
            if (!page || page.deletedAt) {
              pageMissing(
                ctx,
                'doc-project',
                {
                  projectId: p.id,
                  pageId: rootId,
                },
                false,
              );
              return null;
            }
            return page;
          }
          const page = await ctx.writer.createPage({
            id: targetId(ctx.workspaceId, 'project', p.id),
            spaceId: target.spaceId,
            title: p.name,
            content: SUBPAGES_CONTENT,
            creatorId: target.ownerId,
            createdAt: new Date(p.createdAt),
            updatedAt: new Date(p.updatedAt ?? p.createdAt),
            position: await projectPosition(ctx, p),
            map: { type: 'project', sourceId: p.id },
          });
          ctx.report.count('doc-project.imported');
          return page;
        });
        if (!made.ok) {
          ctx.state.failedProjects.add(p.id);
          ctx.report.count('document.failed.parent-failed', docs.length);
          ctx.report.count('comment.failed.parent-failed', commentCount(docs));
          continue;
        }
        if (made.value === null) {
          // its documents have nowhere to go: those imported before are
          // explained by the missing page; any never imported stay a failure
          for (const d of docs) {
            const mapped = !!(await ctx.map.get('document', d.id));
            const n = commentCount([d]);
            ctx.report.count(
              mapped
                ? 'document.skipped.page-missing'
                : 'document.failed.parent-missing',
            );
            ctx.report.count(
              mapped
                ? 'comment.skipped.page-missing'
                : 'comment.failed.parent-missing',
              n,
            );
          }
          ctx.state.missingPages.add(p.id);
          continue;
        }
        const root: Page = made.value;
        // mindspace has no address for a single document: one link per project
        ctx.report.link(oldProjectUrl(ctx, p.id), await pageLink(ctx, root));

        for (const d of docs) {
          const threads = threadsOf(commentsOf(d.id));
          const done = await eachItem(ctx, 'document', d.id, async () => {
            const pageId = await alreadyImported(
              ctx,
              'document',
              d.id,
              'document',
            );
            if (pageId) {
              // still a loss on every run, until fixed or accepted
              await convert(d.content ?? '').catch((err: Error) =>
                ctx.report.loss('document-convert-failed', p.id, {
                  documentId: d.id,
                  reason: err.message,
                }),
              );
              const page = await ctx.docmost.page(pageId);
              if (!page || page.deletedAt) {
                pageMissing(
                  ctx,
                  'document',
                  {
                    projectId: p.id,
                    pageId,
                    documentId: d.id,
                  },
                  false,
                );
                ctx.report.count(
                  'comment.skipped.page-missing',
                  commentsOf(d.id).length,
                );
                return;
              }
              await importLateComments(ctx, page, threads);
              return;
            }
            await importDocument(
              ctx,
              convert,
              p,
              d,
              root,
              target.ownerId,
              threads,
            );
            ctx.report.count('document.imported');
          });
          if (!done.ok)
            ctx.report.count(
              'comment.failed.document-failed',
              commentsOf(d.id).length,
            );
        }
      }
    },
  };
}

/**
 * A doc project becomes a page whose body lists its subpages, with one child
 * page per markdown document. Comment threads keep their highlight where the
 * quoted text can be found exactly once, their replies, resolution and dates.
 */
export const docsStep = createDocsStep();
