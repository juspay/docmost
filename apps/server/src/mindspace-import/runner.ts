import type { User } from '@docmost/db/types/entity.types';
import type { ImportOptions, StepName } from './args';
import type { DocmostReader } from './docmost-reader';
import type { ImportMap, SourceType } from './import-map';
import type { ImportWriterPort } from './import-writer';
import type { ImportReport } from './report';
import type { MindspaceSource } from './source/mindspace-source';
import type { WhiteboardFileStore } from './whiteboard-file-store';
import type { Inviter } from './invites';

export type { ImportOptions } from './args';

/** Results one step leaves for the next, in memory for this run only. */
export type RunState = {
  /** mindspace user id → docmost user id, for confirmed and matched people. */
  users?: Map<string, string>;
  /** mindspace user id → email, for every mindspace user. */
  emails?: Map<string, string | null>;
  /** mindspace workspace id → why it was not migrated. */
  skippedWorkspaces?: Map<string, string>;
  /** mindspace workspace id → docmost user id that owns its pages. */
  workspaceOwners?: Map<string, string>;
  /** mindspace project id → page position among its space's root pages. */
  positions?: Map<string, string>;
  /** lower-cased emails already reported as user-ambiguous in this run. */
  ambiguousReported?: Set<string>;
  /** lower-cased emails already handled by inviteUnmatched in this run. */
  invited?: Set<string>;
  /** projects whose page an earlier run made and docmost no longer has. */
  missingPages?: Set<string>;
  /** projects whose page could not be written in this run. */
  failedProjects?: Set<string>;
  /** source project fingerprints, for verify. */
  fingerprints?: Map<string, Fingerprint>;
};

export type Fingerprint =
  | { kind: 'whiteboard'; elements: number; images: number }
  | { kind: 'todo'; cards: number; items: number }
  | { kind: 'sheet'; tabs: number; cells: number }
  | { kind: 'invalid'; reason: string };

export type ImportContext = {
  workspaceId: string;
  dryRun: boolean;
  source: MindspaceSource;
  map: ImportMap;
  report: ImportReport;
  fallbackOwner: User;
  options: ImportOptions;
  writer: ImportWriterPort;
  docmost: DocmostReader;
  files: WhiteboardFileStore;
  /** Set with --invite-unmatched. */
  invites?: Inviter;
  urls: {
    /**
     * The space address, not /p/<slugId>: the client's redirect from the short
     * address drops the query string, and with it ?block=.
     */
    page(spaceSlug: string, slugId: string): string;
    share(key: string, slugId: string): string;
  };
  state: RunState;
};

export interface ImportStep {
  name: StepName;
  run(ctx: ImportContext): Promise<void>;
}

/** Thrown when a step needs a mapping that an earlier step makes. */
export class MissingStepError extends Error {
  constructor(step: StepName, what: string) {
    super(`${what}: run the "${step}" step first (or run all steps)`);
  }
}

/**
 * The re-run rule every step follows: a source row already in the map is
 * skipped and counted as `<kind>.already-imported`. Returns its target id.
 */
export async function alreadyImported(
  ctx: Pick<ImportContext, 'map' | 'report'>,
  type: SourceType,
  sourceId: string,
  kind: string,
): Promise<string | undefined> {
  const id = await ctx.map.get(type, sourceId);
  if (id) ctx.report.count(`${kind}.already-imported`);
  return id;
}

/**
 * Runs one item. If it throws, the item is recorded as `<kind>.failed.error`
 * with an `item-failed` warning and the run goes on; a missing earlier step
 * still stops the run. Each item writes in its own transaction, so a failed
 * item leaves nothing behind and the next run picks it up.
 */
export async function eachItem<T>(
  ctx: Pick<ImportContext, 'report'>,
  kind: string,
  id: string,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const before = ctx.report.checkpoint();
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof MissingStepError) throw err;
    // what the item counted before it failed did not happen
    ctx.report.rollback(before);
    ctx.report.count(`${kind}.failed.error`);
    ctx.report.warn('item-failed', { kind, id, error: (err as Error).message });
    return { ok: false };
  }
}

/**
 * A page an earlier run imported that is gone from docmost (deleted for good
 * by a space admin). Not a failure of this run: a warning, and its items are
 * skipped, so the step and the rest of the run go on.
 */
export function pageMissing(
  ctx: Pick<ImportContext, 'report'>,
  kind: string,
  detail: { projectId: string; pageId: string; documentId?: string },
  /** false when the item was already counted (already-imported) */
  count = true,
): void {
  if (count) ctx.report.count(`${kind}.skipped.page-missing`);
  ctx.report.warn('target-page-missing', { kind, ...detail });
}

export async function runImport(
  steps: ImportStep[],
  ctx: ImportContext,
): Promise<ImportReport> {
  for (const step of steps) {
    try {
      await step.run(ctx);
    } catch (err) {
      ctx.report.fail(`step ${step.name} stopped: ${(err as Error).message}`);
      throw err;
    }
  }
  return ctx.report;
}

/** Reads each source table once per run, however many steps ask. */
export class CachedSource implements MindspaceSource {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(private readonly inner: MindspaceSource) {}

  private once<T>(
    key: keyof MindspaceSource,
    read: () => Promise<T>,
  ): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, read());
    return this.cache.get(key) as Promise<T>;
  }

  identity = () => this.inner.identity?.();
  users = () => this.once('users', () => this.inner.users());
  workspaces = () => this.once('workspaces', () => this.inner.workspaces());
  members = () => this.once('members', () => this.inner.members());
  projects = () => this.once('projects', () => this.inner.projects());
  documents = () => this.once('documents', () => this.inner.documents());
  comments = () => this.once('comments', () => this.inner.comments());
  projectShares = () =>
    this.once('projectShares', () => this.inner.projectShares());
  close = () => this.inner.close();
}
