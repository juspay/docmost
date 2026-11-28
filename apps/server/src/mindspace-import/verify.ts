import * as Y from 'yjs';
import { sheet } from '@docmost/live-blocks';
import { targetId, type SourceType } from './import-map';
import type { Fingerprint, ImportContext, ImportStep } from './runner';
import type { MsProject } from './source/mindspace.types';
import { ensurePeople, unmatchedReason } from './steps/people.step';
import { roleRank } from './import-writer';
import * as cheerio from 'cheerio';
import { markdownToHtml } from '@docmost/editor-ext';
import { keepLeadingRule } from './steps/docs.step';
import { jsonToText } from '../collaboration/collaboration.util';
import { matchByEmail } from './docmost-reader';
import {
  bookFingerprint,
  snapshotFingerprint,
  sourceFingerprint,
  type BlockKind,
} from './steps/scene.util';

const DIMENSIONS: Record<string, string[]> = {
  whiteboard: ['elements', 'images'],
  todo: ['cards', 'items'],
  sheet: ['tabs', 'cells'],
};

/** The dimensions in which docmost holds less than mindspace did. */
function shortfall(source: Fingerprint, stored: Fingerprint): string[] {
  if (source.kind === 'invalid') return [];
  if (stored.kind !== source.kind)
    return [`a ${stored.kind} block instead of a ${source.kind} block`];
  return DIMENSIONS[source.kind]
    .filter((d) => (stored as any)[d] < (source as any)[d])
    .map((d) => `${d} ${(stored as any)[d]} of ${(source as any)[d]}`);
}

const ROLE: Record<string, string> = { editor: 'writer', viewer: 'reader' };

/**
 * Each migrated space has exactly the mapped owner as admin and the mapped
 * members with their roles: nobody gained access they did not have.
 */
/**
 * Which items verify is holding to the source in this run, and the outcome.
 * An item is strict until it has passed once (recorded on its map row); only
 * after that can a difference be someone's later change (drift).
 */
class Gate {
  private readonly passedBefore = new Set<string>();
  private readonly checked = new Set<string>();
  private readonly failed = new Set<string>();

  constructor(private readonly ctx: ImportContext) {}

  async strict(key: string): Promise<boolean> {
    if (this.passedBefore.has(key)) return false;
    const [type, ...rest] = key.split(':');
    const was = await this.ctx.map.verified(type as SourceType, rest.join(':'));
    if (was) this.passedBefore.add(key);
    return !was;
  }

  /** The item exists (has a map row) and has not passed since it was last written. */
  async writtenAgain(key: string): Promise<boolean> {
    const [type, ...rest] = key.split(':');
    const sourceId = rest.join(':');
    if (!(await this.ctx.map.get(type as SourceType, sourceId))) return false;
    return this.strict(key);
  }

  check(key: string) {
    this.checked.add(key);
  }

  fail(key: string) {
    this.failed.add(key);
  }

  /** Items checked and found whole are recorded as passed. */
  async record(): Promise<void> {
    const items = [...this.checked]
      .filter((k) => !this.failed.has(k) && !this.passedBefore.has(k))
      .map((k) => {
        const [type, ...rest] = k.split(':');
        return { type: type as SourceType, sourceId: rest.join(':') };
      });
    await this.ctx.map.markVerified(items);
  }
}

const rowOf = (m: Map<string, string[]>, userId: string, row: string) =>
  m.set(userId, [...(m.get(userId) ?? []), row]);

async function verifyMembers(
  ctx: ImportContext,
  sharesRan: boolean,
  gate: Gate,
) {
  const [workspaces, members, projects, shares] = await Promise.all([
    ctx.source.workspaces(),
    ctx.source.members(),
    ctx.source.projects(),
    ctx.source.projectShares(),
  ]);
  // Q4: people a project was shared with are members too, at least at the
  // share's role (a higher member role stays)
  const workspaceOf = new Map(projects.map((p) => [p.id, p.workspaceId]));
  const recipients = new Map(
    [
      ...(
        await matchByEmail(
          ctx.docmost,
          shares.map((x) => x.email),
        )
      ).users,
    ]
      .filter(([, u]) => !unmatchedReason(u))
      .map(([email, u]) => [email, u.id]),
  );
  for (const w of workspaces) {
    // a space of an earlier run may have been changed by its admins since
    if (ctx.state.skippedWorkspaces.has(w.id)) continue;
    const key = `workspace:${w.id}`;
    // a space that never passed is compared whole; after that, only what a
    // run wrote again (a member or grant whose own row lost verified_at)
    const spaceStrict = await gate.strict(key);
    gate.check(key);
    /** this member's own map rows: the member grant, owner grant, share grants */
    const rowsOf = new Map<string, string[]>();
    const differ = async (what: string, userId: string) => {
      const rows = rowsOf.get(userId) ?? [];
      let strict = spaceStrict;
      for (const r of rows) if (await gate.writtenAgain(r)) strict = true;
      if (!strict) return ctx.report.warn('drift', { workspaceId: w.id, what });
      gate.fail(key);
      for (const r of rows) gate.fail(r);
      ctx.report.fail(what);
    };
    const spaceId = await ctx.map.get('workspace', w.id);
    if (!spaceId) {
      ctx.report.fail(
        `workspace ${w.id} ("${w.name}") has no space in docmost`,
      );
      continue;
    }
    const adminId = ctx.state.workspaceOwners.get(w.id);
    const want = new Map<string, string>([[adminId, 'admin']]);
    if (adminId) rowOf(rowsOf, adminId, `grant:owner:${w.id}`);
    // a space made for the fallback owner (--grant-fallback-admin) keeps that
    // admin after the real owner gets an account and is added by a later run
    const space = await ctx.docmost.space(spaceId);
    if (
      space?.creatorId === ctx.fallbackOwner.id &&
      adminId !== ctx.fallbackOwner.id
    ) {
      want.set(ctx.fallbackOwner.id, 'admin');
    }
    for (const m of members.filter((x) => x.workspaceId === w.id)) {
      const userId = ctx.state.users.get(m.userId);
      // a role mindspace does not define was skipped and reported (member-role-unknown)
      if (!Object.prototype.hasOwnProperty.call(ROLE, m.role)) continue;
      if (userId) rowOf(rowsOf, userId, `grant:member:${w.id}:${m.userId}`);
      if (userId && userId !== adminId) want.set(userId, ROLE[m.role]);
    }
    // without the shares step in this run their grants may or may not be there yet
    const optional = new Set<string>();
    // a run without the shares step has not compared share grants
    if (!sharesRan) gate.fail(key);
    for (const x of shares.filter(
      (y) => workspaceOf.get(y.projectId) === w.id,
    )) {
      const userId = recipients.get(x.email.toLowerCase());
      if (!userId) continue;
      rowOf(rowsOf, userId, `grant:${x.projectId}:${x.email.toLowerCase()}`);
      if (!Object.prototype.hasOwnProperty.call(ROLE, x.role)) continue; // reported by the shares step
      const role = ROLE[x.role];
      const current = want.get(userId);
      if (!current && !sharesRan) optional.add(userId);
      if (!current || roleRank(current) < roleRank(role))
        want.set(userId, role);
    }
    // every member and grant row of the space is compared below
    for (const rows of rowsOf.values())
      for (const r of rows) {
        gate.check(r);
        // share grants were compared only if the shares step ran
        if (
          !sharesRan &&
          !r.startsWith('grant:member:') &&
          !r.startsWith('grant:owner:')
        )
          gate.fail(r);
      }
    const got = new Map(
      (await ctx.docmost.spaceMembers(spaceId)).map((m) => [
        m.userId,
        m.role as string,
      ]),
    );
    for (const [userId, role] of got) {
      if (!want.has(userId)) {
        await differ(
          `space of workspace ${w.id} ("${w.name}") has a member who was not in mindspace: ${userId} (${role})`,
          userId,
        );
      } else if (want.get(userId) !== role) {
        await differ(
          `space of workspace ${w.id} ("${w.name}") gives ${userId} the role ${role}, not ${want.get(userId)}`,
          userId,
        );
      }
    }
    for (const [userId, role] of want) {
      if (!got.has(userId) && !optional.has(userId)) {
        await differ(
          `space of workspace ${w.id} ("${w.name}") is missing member ${userId} (${role})`,
          userId,
        );
      }
    }
  }
}

const words = (text: string) =>
  (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase());

/**
 * The words a reader sees in the markdown: rendered the way the import
 * renders it, then read as text. So syntax, entities, link targets and
 * reference or footnote definitions never count; image alt text, which the
 * page does not show as text, is left out on purpose.
 */
async function markdownWords(markdown: string): Promise<string[]> {
  const html = await markdownToHtml(keepLeadingRule(markdown));
  const $ = cheerio.load(html);
  // math is an atom with no text on the page: leave it out on both sides
  $(
    'img, script, style, [data-katex], [data-type="mathInline"], [data-type="mathBlock"]',
  ).remove();
  // block boundaries are word boundaries
  $('p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, br, div').after(
    ' ',
  );
  return words($.root().text());
}

/** The markdown's words the page does not have (as a multiset). */
export async function missingWords(
  markdown: string,
  pageText: string,
): Promise<string[]> {
  const have = new Map<string, number>();
  for (const w of words(pageText)) have.set(w, (have.get(w) ?? 0) + 1);
  const lost: string[] = [];
  for (const w of await markdownWords(markdown)) {
    const n = have.get(w) ?? 0;
    if (n > 0) have.set(w, n - 1);
    else lost.push(w);
  }
  return lost;
}

/**
 * Checks what the run left in docmost against the source, and records every
 * problem with report.fail (exit code 1):
 * - members: each space has exactly the mapped owner and mapped members;
 * - counts: each kind's source rows are imported, already imported or skipped
 *   with a named reason (report.mismatches does the arithmetic);
 * - content: each block holds at least what its project held, each document
 *   page has its threads and replies;
 * - links: each share has exactly the expiry its link had;
 * - losses: each loss is named in --accept-loss.
 * A project named in --accept-loss turns its content problems into warnings.
 */
export async function verifyImport(
  ctx: ImportContext,
  ran: ImportStep[],
): Promise<void> {
  const did = new Set(ran.map((s) => s.name));
  if (!['people', 'projects', 'docs', 'shares'].some((s) => did.has(s as any)))
    return;
  await ensurePeople(ctx);
  const accepted = new Set(ctx.options.acceptLoss);
  const gate = new Gate(ctx);
  /** A difference on an item; `key` names the item it is about. */
  const problem = async (projectId: string, what: string, key: string) => {
    if (!(await gate.strict(key)))
      return ctx.report.warn('drift', { projectId, what });
    gate.fail(key);
    if (accepted.has(projectId))
      ctx.report.warn('accepted-loss', { projectId, what });
    else ctx.report.fail(what);
  };
  const migrated = (p: MsProject) =>
    !ctx.state.skippedWorkspaces.has(p.workspaceId);
  const projects = (await ctx.source.projects()).filter(migrated);
  const label = (p: MsProject) => `project ${p.id} ("${p.name}")`;

  // a page in the trash is as good as missing
  const livePage = async (id: string | undefined) => {
    const page = id && (await ctx.docmost.page(id));
    return page && !page.deletedAt ? page : undefined;
  };

  if (did.has('people')) await verifyMembers(ctx, did.has('shares'), gate);

  if (did.has('projects')) {
    for (const p of projects.filter((x) => x.kind !== 'doc')) {
      gate.check(`project:${p.id}`);
      const pageId = await ctx.map.get('project', p.id);
      const page = pageId && (await ctx.docmost.page(pageId));
      if (!page || page.deletedAt) {
        await problem(
          p.id,
          `${label(p)} has no page in docmost`,
          `project:${p.id}`,
        );
        continue;
      }
      const block = await ctx.docmost.block(
        targetId(ctx.workspaceId, 'block', p.id),
      );
      if (!block || block.pageId !== page.id) {
        await problem(
          p.id,
          `${label(p)} has no block on its page`,
          `project:${p.id}`,
        );
        continue;
      }
      const source =
        ctx.state.fingerprints?.get(p.id) ??
        sourceFingerprint(p.kind as BlockKind, p.scene);
      // a sheet's snapshot may stop early; its document holds the whole book
      const stored =
        p.kind === 'sheet'
          ? bookFingerprint(
              sheet.readBook(
                (await ctx.docmost.blockDoc(
                  targetId(ctx.workspaceId, 'block', p.id),
                )) ?? new Y.Doc(),
              ),
            )
          : snapshotFingerprint(block.snapshot);
      const missing = shortfall(source, stored);
      if (missing.length > 0) {
        await problem(
          p.id,
          `${label(p)} is emptier in docmost than in mindspace: ${missing.join(', ')}`,
          `project:${p.id}`,
        );
      }
    }
  }

  if (did.has('docs')) {
    const [documents, comments] = await Promise.all([
      ctx.source.documents(),
      ctx.source.comments(),
    ]);
    for (const p of projects.filter((x) => x.kind === 'doc')) {
      gate.check(`project:${p.id}`);
      const rootId = await ctx.map.get('project', p.id);
      if (!(await livePage(rootId))) {
        await problem(
          p.id,
          `${label(p)} has no page in docmost`,
          `project:${p.id}`,
        );
        continue;
      }
      for (const d of documents.filter((x) => x.projectId === p.id)) {
        gate.check(`document:${d.id}`);
        const pageId = await ctx.map.get('document', d.id);
        if (!(await livePage(pageId))) {
          await problem(
            p.id,
            `document ${d.id} ("${d.name}") has no page in docmost`,
            `document:${d.id}`,
          );
          continue;
        }
        // every word of the markdown, minus its syntax, must be on the page
        const page = await livePage(pageId);
        const lost = await missingWords(
          d.content ?? '',
          jsonToText(page.content as any),
        );
        if (lost.length > 0 && !(await gate.strict(`document:${d.id}`))) {
          ctx.report.warn('drift', {
            projectId: p.id,
            what: `document-content-shorter: document ${d.id} misses ${lost.length} word(s)`,
          });
        } else if (lost.length > 0) {
          gate.fail(`document:${d.id}`);
          ctx.report.loss('document-content-shorter', p.id, {
            documentId: d.id,
            name: d.name,
            missing: lost.length,
            sample: lost.slice(0, 10),
          });
        }
        const own = comments.filter((c) => c.documentId === d.id);
        const sourceThreads = own.filter((c) => !c.parentId).length;
        const sourceReplies = own.length - sourceThreads;
        const stored = await ctx.docmost.pageComments(pageId);
        const threads = stored.filter((c) => !c.parentCommentId).length;
        const replies = stored.length - threads;
        // each comment has its own row: one this run wrote is held strictly,
        // and holds the count check strictly, not the document's text
        const commentKeys = own.map((c) => `comment:${c.id}`);
        let countKey = `document:${d.id}`;
        for (const k of commentKeys) {
          gate.check(k);
          if (await gate.writtenAgain(k)) countKey = k;
        }
        if (threads < sourceThreads || replies < sourceReplies) {
          if (countKey !== `document:${d.id}`)
            for (const k of commentKeys) gate.fail(k);
          await problem(
            p.id,
            `document ${d.id} ("${d.name}") has ${threads} thread(s) and ${replies} reply(ies) in docmost, ${sourceThreads} and ${sourceReplies} in mindspace`,
            countKey,
          );
        }
      }
    }
  }

  if (did.has('shares')) {
    for (const p of projects.filter((x) => x.visibility === 'link')) {
      gate.check(`link:${p.id}`);
      const shareId = await ctx.map.get('link', p.id);
      const share = shareId && (await ctx.docmost.share(shareId));
      if (!share) {
        await problem(
          p.id,
          `the link of project ${p.id} has no share in docmost`,
          `link:${p.id}`,
        );
        continue;
      }
      const want = p.linkExpiresAt ? new Date(p.linkExpiresAt).getTime() : null;
      const got = share.expiresAt ? share.expiresAt.getTime() : null;
      if (want !== null && got === null) {
        await problem(
          p.id,
          `the link of project ${p.id} had an expiry in mindspace but its share has no expiry`,
          `link:${p.id}`,
        );
      } else if (want === null && got !== null) {
        await problem(
          p.id,
          `the link of project ${p.id} had no expiry in mindspace but its share expires`,
          `link:${p.id}`,
        );
      } else if (want !== got) {
        await problem(
          p.id,
          `the link of project ${p.id} expires at ${new Date(got).toISOString()} in docmost, ${new Date(want).toISOString()} in mindspace`,
          `link:${p.id}`,
        );
      }
    }
  }

  for (const loss of ctx.report.losses()) {
    if (accepted.has(loss.projectId)) continue;
    // a project with an unaccepted loss has not passed
    gate.fail(`project:${loss.projectId}`);
    ctx.report.fail(
      `unaccepted loss in project ${loss.projectId}: ${loss.code} ${JSON.stringify(loss.detail)}`,
    );
  }
  await gate.record();
}
