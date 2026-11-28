import * as Y from 'yjs';
import {
  emptySnapshot,
  sheet,
  validateSnapshotInput,
  type LiveBlockSnapshot,
  type WhiteboardSnapshot,
} from '@docmost/live-blocks';
import { generateNKeysBetween } from 'fractional-indexing-jittered';
import type { Page } from '@docmost/db/types/entity.types';
import { targetId } from '../import-map';
import { STORE_FAILED_REASON } from '../../core/live-block/whiteboard-files.service';
import {
  MissingStepError,
  alreadyImported,
  eachItem,
  pageMissing,
  type ImportContext,
  type ImportStep,
} from '../runner';
import type { MsProject, MsWorkspace } from '../source/mindspace.types';
import { ensurePeople } from './people.step';
import {
  EMPTY_PAGE_CONTENT,
  SceneInvalidError,
  blockPageContent,
  sceneToSnapshot,
  sourceFingerprint,
  type BlockKind,
} from './scene.util';

/** A sheet block's document, seeded from the whole workbook. */
export function seedBookDoc(book: sheet.SheetBook): Y.Doc {
  const doc = new Y.Doc();
  sheet.seedSheet(doc, book);
  return doc;
}

/** Sidebar order: workspace by workspace, then position, then creation. */
export function sidebarOrder(
  projects: MsProject[],
  workspaces: MsWorkspace[],
): MsProject[] {
  const wsIndex = new Map(workspaces.map((w, i) => [w.id, i]));
  return [...projects].sort(
    (a, b) =>
      (wsIndex.get(a.workspaceId) ?? Infinity) -
        (wsIndex.get(b.workspaceId) ?? Infinity) ||
      (a.position ?? Infinity) - (b.position ?? Infinity) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Each project's page position, from mindspace's order across every kind, so
 * doc projects (made by a later step) sit between boards as they did. The keys
 * are the same on every run.
 */
export async function projectPosition(
  ctx: ImportContext,
  project: MsProject,
): Promise<string> {
  if (!ctx.state.positions) {
    const [projects, workspaces] = await Promise.all([
      ctx.source.projects(),
      ctx.source.workspaces(),
    ]);
    const ordered = sidebarOrder(projects, workspaces);
    ctx.state.positions = new Map();
    for (const w of new Set(ordered.map((p) => p.workspaceId))) {
      const own = ordered.filter((p) => p.workspaceId === w);
      const keys = generateNKeysBetween(null, null, own.length);
      own.forEach((p, i) => ctx.state.positions.set(p.id, keys[i]));
    }
  }
  return ctx.state.positions.get(project.id);
}

/** The space a project's workspace became, or why it has none. */
export async function spaceFor(
  ctx: ImportContext,
  project: MsProject,
): Promise<{ spaceId: string; ownerId: string } | { skipped: string }> {
  const skipped = ctx.state.skippedWorkspaces.get(project.workspaceId);
  if (skipped) return { skipped };
  const spaceId = await ctx.map.get('workspace', project.workspaceId);
  if (!spaceId) {
    throw new MissingStepError(
      'people',
      `Workspace ${project.workspaceId} has no space`,
    );
  }
  return {
    spaceId,
    ownerId:
      ctx.state.workspaceOwners.get(project.workspaceId) ??
      ctx.fallbackOwner.id,
  };
}

/** Where a page lives in docmost, for the old-link to new-link list. */
export async function pageLink(
  ctx: ImportContext,
  page: Page,
): Promise<string> {
  const space = await ctx.docmost.space(page.spaceId);
  if (!space)
    throw new Error(
      `Page ${page.id} is in space ${page.spaceId}, which is not in docmost`,
    );
  return ctx.urls.page(space.slug, page.slugId);
}

export const oldProjectUrl = (ctx: ImportContext, projectId: string) =>
  `${ctx.options.oldBaseUrl}/p/${projectId}`;

async function importProject(
  ctx: ImportContext,
  p: MsProject & { kind: BlockKind },
  spaceId: string,
  ownerId: string,
): Promise<Page> {
  const blockId = targetId(ctx.workspaceId, 'block', p.id);
  let snapshot: LiveBlockSnapshot;
  let files: Record<string, { dataURL: string; mimeType: string }> = {};
  let book: sheet.SheetBook | undefined;
  try {
    const result = sceneToSnapshot(p.kind, p.scene);
    snapshot = result.snapshot;
    files = result.files ?? {};
    // a loss --accept-loss covers, listed by the dry run too
    for (const fileId of result.overCap ?? [])
      ctx.report.loss('whiteboard-file-skipped', p.id, {
        fileId,
        reason: 'the board already holds as many images as a whiteboard can',
      });
    book = result.book;
    for (const w of result.warnings)
      ctx.report.warn('scene-note', { projectId: p.id, note: w });
    // unsafe elements cleaned out: an explained difference, listed by the dry run too
    const removed = result.removed ?? {};
    const altered = result.altered ?? {};
    if (Object.keys(removed).length || Object.keys(altered).length) {
      const summary = [...Object.entries(removed), ...Object.entries(altered)]
        .map(([why, n]) => `${n} ${why}`)
        .join(', ');
      ctx.report.warn('whiteboard-element-removed', {
        projectId: p.id,
        name: p.name,
        removed,
        altered,
        summary,
      });
    }
  } catch (err) {
    if (!(err instanceof SceneInvalidError)) throw err;
    // the page is still made, with an empty block, so links keep working
    ctx.report.loss('scene-invalid', p.id, {
      name: p.name,
      kind: p.kind,
      reason: err.message,
    });
    snapshot = emptySnapshot(p.kind);
  }

  // the page first: an attachment belongs to a page. No map row yet, so a run
  // that dies before the block is written finishes the project next time.
  const page = await ctx.writer.createPage({
    id: targetId(ctx.workspaceId, 'project', p.id),
    spaceId,
    title: p.name,
    // no block node yet: a client that opened the page now would load an empty
    // block document, and its next store would overwrite the seed
    content: EMPTY_PAGE_CONTENT,
    creatorId: ownerId,
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt ?? p.createdAt),
    position: await projectPosition(ctx, p),
  });

  if (snapshot.kind === 'whiteboard' && Object.keys(files).length > 0) {
    const stored = await ctx.files.store(
      files,
      { id: page.id, spaceId: page.spaceId, workspaceId: page.workspaceId },
      ownerId,
      // derived ids: a later attempt reuses these attachments, no orphans
      {
        attachmentId: (fileId) =>
          targetId(ctx.workspaceId, 'attachment', `${p.id}:${fileId}`),
      },
    );
    // storage or the database failing is not the file's fault: fail the
    // project before its block and map row are written, so a re-run retries
    const failed = stored.skipped.filter(
      (s) => s.reason === STORE_FAILED_REASON,
    );
    if (failed.length > 0) {
      throw new Error(
        `Whiteboard images could not be stored (${failed.map((f) => f.fileId).join(', ')}); a re-run tries again`,
      );
    }
    // validated again with the real refs: the file cap and key checks apply
    snapshot = validateSnapshotInput('whiteboard', {
      elements: (snapshot as WhiteboardSnapshot).elements,
      files: { ...(snapshot as WhiteboardSnapshot).files, ...stored.refs },
    });
    for (const skip of stored.skipped) {
      ctx.report.loss('whiteboard-file-skipped', p.id, {
        fileId: skip.fileId,
        reason: skip.reason,
      });
    }
    ctx.report.count(
      'whiteboard.images-stored',
      Object.keys(stored.refs).length,
    );
  }

  // the seeded row first, then the node that points at it, in one transaction
  return ctx.writer.inTransaction(async (w) => {
    await w.createLiveBlock({
      blockId,
      page,
      snapshot,
      // a sheet's block holds the whole book; its snapshot may stop early
      ydoc: book ? seedBookDoc(book) : undefined,
      creatorId: ownerId,
      map: { type: 'project', sourceId: p.id },
    });
    return w.setPageContent(page, blockPageContent(p.kind, blockId, p.name));
  });
}

/**
 * For a project an earlier run imported: the losses that run recorded, found
 * again from the source and the stored block (an invalid scene, an image that
 * is not among the block's files).
 */
async function reportEarlierLosses(
  ctx: ImportContext,
  p: MsProject & { kind: BlockKind },
) {
  let files: Record<string, unknown> = {};
  try {
    files = sceneToSnapshot(p.kind, p.scene).files ?? {};
  } catch (err) {
    if (!(err instanceof SceneInvalidError)) throw err;
    ctx.report.loss('scene-invalid', p.id, {
      name: p.name,
      kind: p.kind,
      reason: err.message,
    });
    return;
  }
  if (p.kind !== 'whiteboard' || Object.keys(files).length === 0) return;
  const block = await ctx.docmost.block(
    targetId(ctx.workspaceId, 'block', p.id),
  );
  const stored =
    block?.snapshot?.kind === 'whiteboard' ? (block.snapshot.files ?? {}) : {};
  for (const fileId of Object.keys(files)) {
    if (!stored[fileId]) {
      ctx.report.loss('whiteboard-file-skipped', p.id, {
        fileId,
        reason: 'not stored by an earlier run',
      });
    }
  }
}

/**
 * Whiteboard, to-do and sheet projects: one page each, holding one live block
 * seeded from the project's scene. Doc projects are left to the docs step.
 */
export const projectsStep: ImportStep = {
  name: 'projects',
  async run(ctx) {
    await ensurePeople(ctx);
    const [all, workspaces] = await Promise.all([
      ctx.source.projects(),
      ctx.source.workspaces(),
    ]);
    const projects = sidebarOrder(
      all.filter((p) => p.kind !== 'doc'),
      workspaces,
    ) as (MsProject & { kind: BlockKind })[];
    ctx.report.count('project.source', projects.length);
    ctx.state.fingerprints ??= new Map();
    ctx.state.failedProjects ??= new Set();

    for (const p of projects) {
      const target = await spaceFor(ctx, p);
      if ('skipped' in target) {
        ctx.report.count(`project.skipped.${target.skipped}`);
        continue;
      }
      const fingerprint = sourceFingerprint(p.kind, p.scene);
      ctx.state.fingerprints.set(p.id, fingerprint);
      ctx.report.fingerprint(p.id, fingerprint);

      const done = await eachItem(ctx, 'project', p.id, async () => {
        let page: Page | undefined;
        const pageId = await alreadyImported(ctx, 'project', p.id, 'project');
        if (pageId) {
          page = await ctx.docmost.page(pageId);
          if (!page || page.deletedAt) {
            // deleted in docmost since: no redirect, and a warning (as for docs)
            pageMissing(ctx, 'project', { projectId: p.id, pageId }, false);
            page = undefined;
          }
          // still a loss on every run, until fixed in mindspace or accepted
          await reportEarlierLosses(ctx, p);
        } else {
          page = await importProject(ctx, p, target.spaceId, target.ownerId);
          ctx.report.count('project.imported');
          ctx.report.count(`project.kind.${p.kind}`);
        }
        if (page) {
          const blockId = targetId(ctx.workspaceId, 'block', p.id);
          ctx.report.link(
            oldProjectUrl(ctx, p.id),
            `${await pageLink(ctx, page)}?block=${blockId}`,
          );
        }
      });
      if (!done.ok) ctx.state.failedProjects.add(p.id);
    }
  },
};
