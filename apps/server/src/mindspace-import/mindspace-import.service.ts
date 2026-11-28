import { sql } from 'kysely';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import type { Workspace } from '@docmost/db/types/entity.types';
import {
  DryRunInviter,
  IMPORT_EMAIL_QUEUE,
  ServiceInviter,
  type Inviter,
} from './invites';
import { InjectKysely } from 'nestjs-kysely';
import { promises as fs } from 'fs';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { User } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { DomainService } from '../integrations/environment/domain.service';
import { ShareExpiryService } from '../core/share-expiry/share-expiry.service';
import { STEP_NAMES, type ImportOptions } from './args';
import {
  KyselyDocmostReader,
  OverlayDocmostReader,
  type DocmostReader,
} from './docmost-reader';
import { DbImportMap, DryRunImportMap, type ImportMap } from './import-map';
import { ImportWriter, type ImportWriterPort } from './import-writer';
import { RecordingWriter } from './recording-writer';
import { ImportReport } from './report';
import {
  CachedSource,
  runImport,
  type ImportContext,
  type ImportStep,
} from './runner';
import type { MindspaceSource } from './source/mindspace-source';
import {
  PostgresMindspaceSource,
  readIdentity,
  sameDatabase,
} from './source/postgres-mindspace-source';
import { sameServerDatabase } from './source/mindspace-source';
import { LOCAL_STORAGE_PATH } from '../common/helpers';
import {
  DryRunFileStore,
  WHITEBOARD_FILE_STORE,
  type WhiteboardFileStore,
} from './whiteboard-file-store';

export type ImportIo = {
  log(line: string): void;
  /** Asks a question on the terminal and returns the typed answer. */
  ask(question: string): Promise<string>;
};

export class ImportRefused extends Error {}

export function stepsFor(
  only: ImportOptions['only'],
  all: ImportStep[] = [],
): ImportStep[] {
  const wanted = only ?? [...STEP_NAMES];
  return all.filter((s) => wanted.includes(s.name));
}

export type VerifyFn = (ctx: ImportContext, ran: ImportStep[]) => Promise<void>;

@Injectable()
export class MindspaceImportService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly config: ConfigService,
    private readonly environment: EnvironmentService,
    private readonly domain: DomainService,
    private readonly shareExpiry: ShareExpiryService,
    @Inject(WHITEBOARD_FILE_STORE)
    private readonly fileStore: WhiteboardFileStore,
    private readonly userRepo: UserRepo,
    private readonly groupUserRepo: GroupUserRepo,
    @Inject(IMPORT_EMAIL_QUEUE)
    private readonly emailQueue: () => Pick<Queue, 'add' | 'close'> &
      Partial<Pick<Queue, 'waitUntilReady'>>,
  ) {}

  /** Also used by tests to give a fake source. */
  openSource(): MindspaceSource {
    const sourceUrl = this.config.get<string>('MINDSPACE_DATABASE_URL');
    if (!sourceUrl)
      throw new ImportRefused('MINDSPACE_DATABASE_URL is not set');
    assertDistinctDatabases(sourceUrl, this.environment.getDatabaseURL());
    return new PostgresMindspaceSource(sourceUrl);
  }

  async run(
    options: ImportOptions,
    io: ImportIo,
    deps: {
      source?: MindspaceSource;
      steps?: ImportStep[];
      verify?: VerifyFn;
    } = {},
  ): Promise<{ exitCode: number; report: ImportReport }> {
    const workspace = await this.db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', options.docmostWorkspace)
      .executeTakeFirst();
    if (!workspace)
      throw new ImportRefused(
        `No docmost workspace with id ${options.docmostWorkspace}`,
      );

    const fallbackOwner = await this.findActiveUser(
      workspace.id,
      options.fallbackOwner,
    );
    if (!fallbackOwner) {
      throw new ImportRefused(
        `--fallback-owner ${options.fallbackOwner} is not an active docmost user with a verified email in this workspace`,
      );
    }

    let emailQueue:
      | (Pick<Queue, 'add' | 'close'> & Partial<Pick<Queue, 'waitUntilReady'>>)
      | undefined;
    const source = new CachedSource(deps.source ?? this.openSource());
    try {
      // first, so whoever runs it sees where it writes before anything else
      io.log(this.describeTarget(workspace));
      await this.printSourceCounts(source, io);
      await this.checkAcceptLoss(source, options);
      await this.checkNotDocmost(source);
      await this.checkMigrated();

      if (!options.dryRun) {
        const typed = await io.ask(
          `This writes to docmost workspace "${workspace.name}". Type its name to continue: `,
        );
        if (typed.trim() !== workspace.name)
          throw new ImportRefused(
            'The name did not match. Nothing was written.',
          );
      }

      const dbMap = new DbImportMap(this.db, workspace.id);
      const map: ImportMap = options.dryRun
        ? new DryRunImportMap(dbMap)
        : dbMap;
      const baseReader = new KyselyDocmostReader(this.db, workspace.id);
      let writer: ImportWriterPort;
      let docmost: DocmostReader;
      let files: WhiteboardFileStore;
      if (options.dryRun) {
        const recorder = new RecordingWriter(map, workspace.id, baseReader);
        writer = recorder;
        docmost = new OverlayDocmostReader(recorder, baseReader);
        files = new DryRunFileStore(this.environment.getFileUploadSizeLimit());
      } else {
        writer = new ImportWriter(this.db, map, workspace.id, this.shareExpiry);
        docmost = baseReader;
        files = this.fileStore;
      }

      // --invite-unmatched: a dry run only reads which invitations exist
      let invites: Inviter | undefined;
      if (options.inviteUnmatched && !options.noNewInvites) {
        // docmost lets only owners and admins invite; the email names them
        if (!['owner', 'admin'].includes(fallbackOwner.role)) {
          throw new ImportRefused(
            `--invite-unmatched sends invitations as the fallback owner, who must be a workspace owner or admin (${fallbackOwner.email} is ${fallbackOwner.role ?? 'neither'})`,
          );
        }
      }
      if (options.noNewInvites || (options.inviteUnmatched && options.dryRun)) {
        // reads invitations, never sends: --no-new-invites, or a dry run
        invites = new DryRunInviter(this.db, workspace as Workspace);
      } else if (options.inviteUnmatched) {
        emailQueue = this.emailQueue();
        const inviter = new ServiceInviter({
          db: this.db,
          userRepo: this.userRepo,
          groupUserRepo: this.groupUserRepo,
          environment: this.environment,
          domain: this.domain,
          emailQueue,
          workspace: workspace as Workspace,
          inviter: fallbackOwner,
        });
        // before anything is written
        await inviter.ready().catch((err: Error) => {
          throw new ImportRefused(
            `Redis does not answer, so invitation emails could not be queued (${err.message}). Nothing was written.`,
          );
        });
        invites = inviter;
      }

      const base = this.domain.getWorkspaceUrl(workspace).replace(/\/+$/, '');
      const ctx: ImportContext = {
        workspaceId: workspace.id,
        dryRun: options.dryRun,
        source,
        map,
        report: new ImportReport(),
        fallbackOwner,
        options,
        writer,
        docmost,
        files,
        invites,
        urls: {
          page: (spaceSlug, slugId) => `${base}/s/${spaceSlug}/p/${slugId}`,
          share: (key, slugId) => `${base}/share/${key}/p/${slugId}`,
        },
        state: {},
      };

      const steps = stepsFor(options.only, deps.steps);
      io.log(
        `${options.dryRun ? 'Dry run' : 'Import'}: steps ${steps.map((s) => s.name).join(', ') || '(none)'}`,
      );
      try {
        await runImport(steps, ctx);
        if (deps.verify) await deps.verify(ctx, steps);
      } finally {
        await this.writeReport(ctx.report, options, io);
      }

      const mismatches = ctx.report.mismatches();
      io.log(
        mismatches.length === 0
          ? 'Result: everything is accounted for.'
          : `Result: ${mismatches.length} problem(s); exit code 1.`,
      );
      return { exitCode: mismatches.length === 0 ? 0 : 1, report: ctx.report };
    } finally {
      await source.close();
      await emailQueue?.close();
    }
  }

  /** Every id in --accept-loss must be a mindspace project. */
  private async checkAcceptLoss(
    source: MindspaceSource,
    options: ImportOptions,
  ) {
    const ids = new Set((await source.projects()).map((p) => p.id));
    const unknown = options.acceptLoss.filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      throw new ImportRefused(
        `--accept-loss names no mindspace project: ${unknown.join(', ')}`,
      );
    }
  }

  /** The tool runs no migrations: the release that ships it must be deployed. */
  private async checkMigrated() {
    const { rows } = await sql<{ exists: boolean; column: boolean }>`
      select to_regclass('mindspace_import_map') is not null as "exists",
             exists (select 1 from information_schema.columns
                     where table_name = 'mindspace_import_map'
                       and column_name = 'verified_at'
                       and table_schema = current_schema()) as "column"`.execute(
      this.db,
    );
    if (!rows[0]?.exists) {
      throw new ImportRefused(
        'The table mindspace_import_map does not exist: deploy this release and let docmost run its migrations first.',
      );
    }
    if (!rows[0]?.column) {
      throw new ImportRefused(
        'The column mindspace_import_map.verified_at does not exist: run the migration 20261127T090000-mindspace-import-map-verified-at (docmost runs it when it starts on this release). Nothing was written.',
      );
    }
  }

  /** The URL check, again on what each connection actually reached. */
  private async checkNotDocmost(source: MindspaceSource) {
    const theirs = await source.identity?.();
    if (!theirs) return;
    const ours = await readIdentity(this.db);
    if (sameServerDatabase(theirs, ours)) {
      throw new ImportRefused(
        `The mindspace connection reached the docmost database itself (${ours.database}). Refusing to start.`,
      );
    }
  }

  /** Where this run writes, printed before anyone confirms it. */
  describeTarget(workspace: { id: string; name: string }): string {
    const db = new URL(this.environment.getDatabaseURL());
    const driver = this.environment.getStorageDriver();
    const where =
      driver === 's3'
        ? `bucket ${this.environment.getAwsS3Bucket()} at ${this.environment.getAwsS3Endpoint() || 'AWS'}`
        : driver === 'azure'
          ? `container ${this.environment.getAzureStorageContainer()} of account ${this.environment.getAzureStorageAccountName()}`
          : `directory ${LOCAL_STORAGE_PATH}`;
    return [
      `Target: docmost workspace "${workspace.name}" (${workspace.id})`,
      `  database ${db.hostname}:${db.port || '5432'}${db.pathname}`,
      `  storage  ${driver}, ${where}`,
    ].join('\n');
  }

  private async findActiveUser(
    workspaceId: string,
    email: string,
  ): Promise<User | undefined> {
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
      .where('deletedAt', 'is', null)
      .where('deactivatedAt', 'is', null)
      .where('emailVerifiedAt', 'is not', null)
      .executeTakeFirst();
    return user as User | undefined;
  }

  private async printSourceCounts(source: MindspaceSource, io: ImportIo) {
    const [users, workspaces, members, projects, documents, comments, shares] =
      await Promise.all([
        source.users(),
        source.workspaces(),
        source.members(),
        source.projects(),
        source.documents(),
        source.comments(),
        source.projectShares(),
      ]);
    const byKind = new Map<string, number>();
    for (const p of projects) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
    io.log('Mindspace source:');
    io.log(
      `  users              ${users.length} (${users.filter((u) => u.emailConfirmedAt).length} confirmed)`,
    );
    io.log(`  workspaces         ${workspaces.length}`);
    io.log(`  workspace members  ${members.length}`);
    io.log(
      `  projects           ${projects.length} (${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})`,
    );
    io.log(`  documents          ${documents.length}`);
    io.log(
      `  comments           ${comments.length} (${comments.filter((c) => !c.parentId).length} threads)`,
    );
    io.log(
      `  public links       ${projects.filter((p) => p.visibility === 'link').length}`,
    );
    io.log(`  person shares      ${shares.length}`);
  }

  private async writeReport(
    report: ImportReport,
    options: ImportOptions,
    io: ImportIo,
  ) {
    io.log('');
    io.log(report.toText());
    if (!options.report) return;
    await fs.writeFile(
      options.report,
      JSON.stringify(report.toJSON(), null, 2) + '\n',
    );
    await fs.writeFile(`${options.report}.links.csv`, linksCsv(report));
    io.log(
      `Report written to ${options.report} and ${options.report}.links.csv`,
    );
  }
}

export function assertDistinctDatabases(sourceUrl: string, targetUrl: string) {
  if (sameDatabase(sourceUrl, targetUrl)) {
    throw new ImportRefused(
      'MINDSPACE_DATABASE_URL and DATABASE_URL point at the same database. Refusing to start.',
    );
  }
}

const csvField = (v: string) =>
  /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

export function linksCsv(report: ImportReport): string {
  const lines = ['old_url,new_url'];
  for (const l of report.links())
    lines.push(`${csvField(l.oldUrl)},${csvField(l.newUrl)}`);
  return lines.join('\n') + '\n';
}
