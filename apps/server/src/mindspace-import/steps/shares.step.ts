import type { Page } from '@docmost/db/types/entity.types';
import { targetId } from '../import-map';
import {
  MissingStepError,
  alreadyImported,
  eachItem,
  pageMissing,
  type ImportContext,
  type ImportStep,
} from '../runner';
import { ensurePeople, unmatchedReason } from './people.step';
import { matchByEmail, reportAmbiguous } from '../docmost-reader';
import { inviteUnmatched } from '../invites';
import type { GrantableRole } from '../import-writer';
import type { MsProject, MsProjectShare } from '../source/mindspace.types';
import { oldProjectUrl, sidebarOrder, spaceFor } from './projects.step';

/**
 * Mindspace does not store the period that was picked, only the date; 7 is its
 * default, and only decides how far "Renew" extends the link.
 */
export const IMPORTED_LINK_PERIOD_DAYS = 7;

/**
 * Q4: a project shared with one person makes them a member of the space the
 * project's workspace became (editor writer, viewer reader, never admin; a
 * higher role they already have is kept). The grant covers the whole space,
 * which the report says. A recipient with no docmost account is invited with
 * --invite-unmatched and added by a re-run once they accept.
 */
async function grantFromProjectShares(
  ctx: ImportContext,
  projects: MsProject[],
  shares: MsProjectShare[],
) {
  ctx.report.count('project-share.source', shares.length);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const { users: people, ambiguous } = await matchByEmail(
    ctx.docmost,
    shares.map((s) => s.email),
  );
  ctx.state.ambiguousReported ??= new Set();
  reportAmbiguous(ctx.report, ctx.state.ambiguousReported, ambiguous);
  const toInvite: { email: string; reason: 'project share' }[] = [];
  /** recipients with no account, by the waiting workspace they were seen in */
  const waiting = new Map<string, string>();

  // one report line per person and space, naming every project behind it
  const grants = new Map<string, { projects: string[] }>();

  for (const s of shares) {
    const project = byId.get(s.projectId);
    const email = s.email.toLowerCase();
    const key = `${s.projectId}:${email}`;
    await eachItem(ctx, 'project-share', key, async () => {
      const target = await spaceFor(ctx, project);
      if ('skipped' in target) {
        ctx.report.count(`project-share.skipped.${target.skipped}`);
        // a recipient with no account is invited once the owner is mapped;
        // noted now, listed after this run's invitations (below)
        if (
          (ctx.options.inviteUnmatched || ctx.options.noNewInvites) &&
          !people.has(email) &&
          !ambiguous.has(email) &&
          !waiting.has(email)
        ) {
          waiting.set(email, project.workspaceId);
        }
        return;
      }
      // the role column is mindspace data: only the two it defines count
      if (!Object.prototype.hasOwnProperty.call(SHARE_ROLE, s.role)) {
        ctx.report.count('project-share.skipped.unknown-role');
        ctx.report.warn('share-role-unknown', {
          projectId: s.projectId,
          project: project.name,
          email,
          role: s.role,
        });
        return;
      }
      // granted by an earlier run: an admin may have changed it since, so it stays
      if (await alreadyImported(ctx, 'grant', key, 'project-share')) return;
      if (ambiguous.has(email)) {
        // no grant and no invitation: the address is someone's, but whose
        ctx.report.count('project-share.skipped.ambiguous');
        return;
      }
      const user = people.get(email);
      const reason = unmatchedReason(user);
      if (reason) {
        if (!user) toInvite.push({ email, reason: 'project share' });
        ctx.report.count('project-share.skipped.unmatched');
        ctx.report.warn('project-share-unmatched', {
          projectId: s.projectId,
          project: project.name,
          email,
          role: s.role,
          reason,
        });
        return;
      }
      const role = SHARE_ROLE[s.role];
      const outcome = await ctx.writer.grantSpaceRole(
        target.spaceId,
        user.id,
        role,
        {
          type: 'grant',
          sourceId: key,
        },
      );
      const grantKey = `${target.spaceId}:${user.id}`;
      if (outcome === 'kept') {
        ctx.report.count('project-share.kept');
        grants.get(grantKey)?.projects.push(project.name);
        return;
      }
      ctx.report.count('project-share.imported');
      const entry = {
        projectId: s.projectId,
        project: project.name,
        projects: [project.name],
        email,
        role,
        outcome,
        note: 'the membership covers the whole space, not only this project',
      };
      grants.set(grantKey, entry);
      ctx.report.warn('space-member-granted-from-share', entry);
    });
  }
  await inviteUnmatched(ctx, toInvite);
  // recipients only of workspaces still waiting for their owner: listed for
  // sign-off; one with a share in a ready workspace was invited above
  const workspaces = new Map(
    (await ctx.source.workspaces()).map((w) => [w.id, w.name]),
  );
  for (const [email, workspaceId] of waiting) {
    if (ctx.state.invited?.has(email)) continue;
    (ctx.state.invited ??= new Set()).add(email);
    ctx.report.invite({
      email,
      status: 'would-invite-later',
      for: ['project share'],
      reason: `waits for the owner of workspace ${workspaceId} ("${workspaces.get(workspaceId) ?? ''}")`,
    });
    ctx.report.count('invite.would-invite-later');
  }
}

const SHARE_ROLE: Record<MsProjectShare['role'], GrantableRole> = {
  editor: 'writer',
  viewer: 'reader',
};

/**
 * Each public link becomes a docmost share with its original expiry, even one
 * already past (an expired link is created expired). Links to one person grant
 * nothing and are only reported, until Q4 is answered.
 */
export const sharesStep: ImportStep = {
  name: 'shares',
  async run(ctx) {
    await ensurePeople(ctx);
    const [all, workspaces, personShares] = await Promise.all([
      ctx.source.projects(),
      ctx.source.workspaces(),
      ctx.source.projectShares(),
    ]);
    const names = new Map(all.map((p) => [p.id, p.name]));

    await grantFromProjectShares(ctx, all, personShares);

    const links = sidebarOrder(
      all.filter((p) => p.visibility === 'link'),
      workspaces,
    );
    ctx.report.count('link.source', links.length);
    ctx.state.failedProjects ??= new Set();
    const now = Date.now();

    for (const p of links) {
      const target = await spaceFor(ctx, p);
      if ('skipped' in target) {
        ctx.report.count(`link.skipped.${target.skipped}`);
        continue;
      }
      const pageId = await ctx.map.get('project', p.id);
      if (!pageId && ctx.state.failedProjects.has(p.id)) {
        ctx.report.count('link.failed.project-failed');
        continue;
      }
      if (!pageId) {
        throw new MissingStepError(
          p.kind === 'doc' ? 'docs' : 'projects',
          `Project ${p.id} has no page`,
        );
      }
      await eachItem(ctx, 'link', p.id, async () => {
        const page: Page = await ctx.docmost.page(pageId);
        if (!page || page.deletedAt) {
          // explained only if the share was made before the page went
          const made = !!(await ctx.map.get('link', p.id));
          if (!made)
            throw new Error(
              `Project ${p.id}'s page is gone and its link was never made`,
            );
          pageMissing(ctx, 'link', { projectId: p.id, pageId });
          return;
        }

        let key: string;
        const shareId = await alreadyImported(ctx, 'link', p.id, 'link');
        if (shareId) {
          key = (await ctx.docmost.share(shareId))?.key;
        } else {
          const expiresAt = p.linkExpiresAt ? new Date(p.linkExpiresAt) : null;
          // share, expiry and map row in one transaction: a share must never
          // exist, even briefly, without the expiry its link had
          ({ key } = await ctx.writer.createShare({
            id: targetId(ctx.workspaceId, 'share', p.id),
            page,
            includeSubPages: p.kind === 'doc',
            creatorId: target.ownerId,
            expiry: expiresAt
              ? { expiresAt, periodDays: IMPORTED_LINK_PERIOD_DAYS }
              : undefined,
            map: { type: 'link', sourceId: p.id },
          }));
          ctx.report.count('link.imported');
          ctx.report.count(
            !expiresAt
              ? 'link.no-expiry'
              : expiresAt.getTime() > now
                ? 'link.live'
                : 'link.expired',
          );
        }
        // the old address goes to the share only while the link works for
        // visitors; otherwise members land on the page itself
        const live =
          !p.linkExpiresAt || new Date(p.linkExpiresAt).getTime() > Date.now();
        if (
          key &&
          page &&
          live &&
          (await ctx.docmost.sharingAllowed(page.spaceId))
        )
          ctx.report.link(
            oldProjectUrl(ctx, p.id),
            ctx.urls.share(key, page.slugId),
          );
      });
    }
  },
};
