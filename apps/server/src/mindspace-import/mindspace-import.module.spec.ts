jest.mock('@react-email/render', () => ({
  render: async (element: { props: Record<string, unknown> }) =>
    JSON.stringify(element.props),
}));
// import-formatter pulls in an ESM-only package jest cannot load
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

// first: the environment this spec runs in, before any docmost module loads
import { MODULE_SPEC_ENV, savedEnv } from './testing/module-spec-env';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { CollaborationGateway } from '../collaboration/collaboration.gateway';
import { QueueName } from '../integrations/queue/constants';
import { RefusingQueue } from './import-infra.module';
import { IMPORT_EMAIL_QUEUE } from './invites';
import { MindspaceImportModule } from './mindspace-import.module';
import { EnvironmentService } from '../integrations/environment/environment.service';
import {
  MindspaceImportService,
  type ImportIo,
} from './mindspace-import.service';
import { ALL_STEPS } from './steps';
import { verifyImport } from './verify';
import {
  DryRunFileStore,
  WHITEBOARD_FILE_STORE,
} from './whiteboard-file-store';
import { createDocsStep } from './steps/docs.step';
import { peopleStep } from './steps/people.step';
import { projectsStep } from './steps/projects.step';
import { P, D } from './testing/synthetic-mindspace';
import { FakeSource } from './testing/fake-source';
import { RecordingDb, docmostLike } from './testing/recording-db';
import { WS, options } from './testing/test-context';
import { syntheticMindspace } from './testing/synthetic-mindspace';

/** Answers like a docmost database that holds one workspace and its people. */
const docmostDb = () =>
  docmostLike(syntheticMindspace.docmostUsers, { id: WS, name: 'Acme' });

const quietIo = (answer = 'Acme'): ImportIo => ({
  log: () => undefined,
  ask: async () => answer,
});

describe('MindspaceImportModule', () => {
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('runs on the environment the spec sets, not on a .env file', () => {
    expect(process.env.DATABASE_URL).toBe(MODULE_SPEC_ENV.DATABASE_URL);
    expect(moduleRef.get(EnvironmentService).getDatabaseURL()).toBe(
      MODULE_SPEC_ENV.DATABASE_URL,
    );
  });

  let moduleRef: TestingModule;
  let rec: RecordingDb;
  const fakeQueue = () => {
    const q = {
      jobs: [] as { name: string; data: any }[],
      closed: false,
      add: async (name: string, data: any) => {
        q.jobs.push({ name, data });
        return {} as any;
      },
      close: async () => {
        q.closed = true;
      },
      waitUntilReady: () => queueReady(),
    };
    return q;
  };
  let queues: ReturnType<typeof fakeQueue>[] = [];
  let queueReady: () => Promise<unknown> = async () => undefined;

  beforeEach(async () => {
    queues = [];
    queueReady = async () => undefined;
    rec = docmostDb();
    moduleRef = await Test.createTestingModule({
      imports: [MindspaceImportModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(rec.db)
      // counts what it would store instead of writing image files to disk
      .overrideProvider(WHITEBOARD_FILE_STORE)
      .useValue(new DryRunFileStore('50mb'))
      .overrideProvider(IMPORT_EMAIL_QUEUE)
      .useValue(() => {
        queues.push(fakeQueue());
        return queues[queues.length - 1];
      })
      .compile();
  });
  afterEach(() => moduleRef.close());

  it('the import module resolves without CollaborationGateway or any queue processor', () => {
    expect(moduleRef.get(MindspaceImportService)).toBeInstanceOf(
      MindspaceImportService,
    );
    expect(() =>
      moduleRef.get(CollaborationGateway, { strict: false }),
    ).toThrow();
    const modules = [...(moduleRef as any).container.getModules().values()].map(
      (m: any) => m.metatype?.name,
    );
    for (const banned of [
      'CollaborationModule',
      'QueueModule',
      'BullModule',
      'PageModule',
      'CommentModule',
    ]) {
      expect(modules).not.toContain(banned);
    }
    for (const name of Object.values(QueueName)) {
      expect(
        moduleRef.get(getQueueToken(name), { strict: false }),
      ).toBeInstanceOf(RefusingQueue);
    }
  });

  it('dry run performs no docmost write', async () => {
    const service = moduleRef.get(MindspaceImportService);
    const { exitCode, report } = await service.run(
      options({
        dryRun: true,
        fallbackOwner: 'admin@acme.test',
        acceptLoss: [P.broken],
      }),
      quietIo(),
      {
        source: new FakeSource(syntheticMindspace.data),
        steps: ALL_STEPS,
        verify: verifyImport,
      },
    );
    // the run did the whole import in memory and checked it
    expect(report.get('project.imported')).toBe(7);
    expect(report.get('document.imported')).toBe(2);
    expect(report.get('comment.imported')).toBe(9);
    expect(report.get('link.imported')).toBe(3);
    expect(report.mismatches()).toEqual([]);
    expect(exitCode).toBe(0);
    // and wrote nothing
    expect(rec.writes()).toEqual([]);
    expect(rec.events.filter((e) => e.startsWith('begin'))).toEqual([]);
  });

  it('dry run reports a scene that fails validation and a document whose markdown fails to convert', async () => {
    const service = moduleRef.get(MindspaceImportService);
    const failing = createDocsStep(async (markdown) => {
      if (markdown.startsWith('Notes from Monday'))
        throw new Error('cannot convert');
      return {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: markdown }] },
        ],
      };
    });
    const { report } = await service.run(
      options({ dryRun: true, fallbackOwner: 'admin@acme.test' }),
      quietIo(),
      {
        source: new FakeSource(syntheticMindspace.data),
        steps: [peopleStep, projectsStep, failing],
      },
    );
    expect(report.losses().map((l) => [l.code, l.projectId])).toEqual([
      ['scene-invalid', P.broken],
      ['document-convert-failed', P.docs],
    ]);
    expect(report.losses()[1].detail).toEqual({
      documentId: D.notes,
      reason: 'cannot convert',
    });
    expect(rec.writes()).toEqual([]);
  });

  it('no queue job is added during an import, and ImportWriter emits no event', async () => {
    const emitter = moduleRef.get(EventEmitter2, { strict: false });
    const emit = jest.spyOn(emitter, 'emit');
    const service = moduleRef.get(MindspaceImportService);
    const { exitCode, report } = await service.run(
      options({ fallbackOwner: 'admin@acme.test', acceptLoss: [P.broken] }),
      quietIo(),
      { source: new FakeSource(syntheticMindspace.data), steps: ALL_STEPS },
    );
    // a real import happened
    expect(report.get('project.imported')).toBe(7);
    expect(report.get('comment.imported')).toBe(9);
    expect(rec.writesTo('pages').length).toBeGreaterThanOrEqual(9);
    expect(rec.writesTo('comments')).toHaveLength(9);
    expect(rec.writesTo('shares')).toHaveLength(3);
    expect(exitCode).toBe(0);
    // and nothing else was set in motion
    for (const name of Object.values(QueueName)) {
      expect(
        (moduleRef.get(getQueueToken(name), { strict: false }) as RefusingQueue)
          .added,
      ).toEqual([]);
    }
    expect(emit).not.toHaveBeenCalled();
  });

  it('prints the target database and storage before asking for the workspace name', async () => {
    const lines: string[] = [];
    const service = moduleRef.get(MindspaceImportService);
    await expect(
      service.run(
        options({ fallbackOwner: 'admin@acme.test' }),
        {
          log: (l) => lines.push(l),
          ask: async () => {
            lines.push('<asked>');
            return 'not it';
          },
        },
        { source: new FakeSource(syntheticMindspace.data), steps: ALL_STEPS },
      ),
    ).rejects.toThrow('The name did not match');
    const target = lines.findIndex((l) =>
      l.startsWith('Target: docmost workspace "Acme"'),
    );
    expect(target).toBeGreaterThanOrEqual(0);
    expect(lines[target]).toMatch(
      /\n  database db\.invalid:5432\/import_spec\n  storage  local, directory \//,
    );
    expect(target).toBeLessThan(lines.indexOf('<asked>'));
    // before it reads mindspace
    expect(target).toBeLessThan(lines.indexOf('Mindspace source:'));
  });

  it('refuses to start when the mindspace connection reaches the docmost database', async () => {
    const service = moduleRef.get(MindspaceImportService);
    const source = new FakeSource(syntheticMindspace.data);
    (source as any).identity = async () => ({
      systemIdentifier: '7001',
      database: 'docmost',
      address: '10.0.0.2',
      port: 6543,
    });
    await expect(
      service.run(
        options({ dryRun: true, fallbackOwner: 'admin@acme.test' }),
        quietIo(),
        { source, steps: ALL_STEPS },
      ),
    ).rejects.toThrow(
      'The mindspace connection reached the docmost database itself (docmost)',
    );
    // another database on the same server is fine
    (source as any).identity = async () => ({
      systemIdentifier: '7001',
      database: 'mindspace',
      address: '10.0.0.1',
      port: 5432,
    });
    await expect(
      service.run(
        options({ dryRun: true, fallbackOwner: 'admin@acme.test' }),
        quietIo(),
        { source, steps: [] },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it('refuses to start when the release migrations have not run (no import map table)', async () => {
    const respond = rec.respond;
    rec.respond = (q) =>
      /to_regclass/.test(q.sql) ? [{ exists: false }] : respond(q);
    const service = moduleRef.get(MindspaceImportService);
    await expect(
      service.run(
        options({ dryRun: true, fallbackOwner: 'admin@acme.test' }),
        quietIo(),
        {
          source: new FakeSource(syntheticMindspace.data),
          steps: ALL_STEPS,
        },
      ),
    ).rejects.toThrow(/mindspace_import_map does not exist.*migrations/);
    expect(rec.writes()).toEqual([]);
  });

  it('refuses to start when the verified_at migration has not run, naming it', async () => {
    const respond = rec.respond;
    rec.respond = (q) =>
      /to_regclass/.test(q.sql)
        ? [{ exists: true, column: false }]
        : respond(q);
    const service = moduleRef.get(MindspaceImportService);
    await expect(
      service.run(
        options({ dryRun: true, fallbackOwner: 'admin@acme.test' }),
        quietIo(),
        {
          source: new FakeSource(syntheticMindspace.data),
          steps: ALL_STEPS,
        },
      ),
    ).rejects.toThrow(/20261127T090000-mindspace-import-map-verified-at/);
    expect(rec.writes()).toEqual([]);
  });

  it('refuses an --accept-loss id that names no mindspace project', async () => {
    const service = moduleRef.get(MindspaceImportService);
    await expect(
      service.run(
        options({
          dryRun: true,
          fallbackOwner: 'admin@acme.test',
          acceptLoss: [P.broken, 'no-such-project'],
        }),
        quietIo(),
        { source: new FakeSource(syntheticMindspace.data), steps: ALL_STEPS },
      ),
    ).rejects.toThrow(
      '--accept-loss names no mindspace project: no-such-project',
    );
    expect(rec.writes()).toEqual([]);
  });

  describe('--invite-unmatched', () => {
    // olga@acme.test is a confirmed mindspace user with no docmost account
    it('a real run invites through docmost, queues the email, and closes the queue', async () => {
      const service = moduleRef.get(MindspaceImportService);
      const { report } = await service.run(
        options({
          fallbackOwner: 'admin@acme.test',
          acceptLoss: [P.broken],
          inviteUnmatched: true,
        }),
        quietIo(),
        { source: new FakeSource(syntheticMindspace.data), steps: ALL_STEPS },
      );
      expect(report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'invited',
          for: ['workspace member'],
        },
        {
          email: 'friend@outside.test',
          status: 'invited',
          for: ['project share'],
        },
      ]);
      const invites = rec.writesTo('workspace_invitations');
      expect(invites).toHaveLength(2);
      expect(invites[0].parameters).toEqual(
        expect.arrayContaining(['olga@acme.test', 'member']),
      );
      expect(invites[1].parameters).toEqual(
        expect.arrayContaining(['friend@outside.test', 'member']),
      );
      expect(queues).toHaveLength(1);
      expect(queues[0].jobs.map((j) => [j.name, j.data.to])).toEqual([
        ['send-email', 'olga@acme.test'],
        ['send-email', 'friend@outside.test'],
      ]);
      expect(queues[0].closed).toBe(true);
      // and no user row was created
      expect(rec.writesTo('users')).toEqual([]);
    });

    it('a dry run lists who would be invited and opens no queue', async () => {
      const service = moduleRef.get(MindspaceImportService);
      const { report } = await service.run(
        options({
          dryRun: true,
          fallbackOwner: 'admin@acme.test',
          inviteUnmatched: true,
        }),
        quietIo(),
        { source: new FakeSource(syntheticMindspace.data), steps: ALL_STEPS },
      );
      expect(report.invited()).toEqual([
        {
          email: 'olga@acme.test',
          status: 'would-invite',
          for: ['workspace member'],
        },
        {
          email: 'friend@outside.test',
          status: 'would-invite',
          for: ['project share'],
        },
      ]);
      expect(queues).toEqual([]);
      expect(rec.writes()).toEqual([]);
    });

    it('is refused when the fallback owner may not invite (not owner or admin), before anything is written', async () => {
      const service = moduleRef.get(MindspaceImportService);
      await expect(
        service.run(
          options({ fallbackOwner: 'ada@acme.test', inviteUnmatched: true }),
          quietIo(),
          { source: new FakeSource(syntheticMindspace.data), steps: ALL_STEPS },
        ),
      ).rejects.toThrow(
        /must be a workspace owner or admin \(ada@acme.test is/,
      );
      expect(rec.writes()).toEqual([]);
      expect(queues).toEqual([]);
    });

    it('is refused when Redis does not answer, before any invitation or other write', async () => {
      queueReady = () => Promise.reject(new Error('connect ECONNREFUSED'));
      const service = moduleRef.get(MindspaceImportService);
      await expect(
        service.run(
          options({
            fallbackOwner: 'admin@acme.test',
            inviteUnmatched: true,
            acceptLoss: [P.broken],
          }),
          quietIo(),
          { source: new FakeSource(syntheticMindspace.data), steps: ALL_STEPS },
        ),
      ).rejects.toThrow(
        'Redis does not answer, so invitation emails could not be queued (connect ECONNREFUSED). Nothing was written.',
      );
      expect(rec.writes()).toEqual([]);
      expect(queues[0].closed).toBe(true);
    });

    it('--no-new-invites opens no queue and writes no invitation, even with --invite-unmatched', async () => {
      const service = moduleRef.get(MindspaceImportService);
      const { report } = await service.run(
        options({
          fallbackOwner: 'admin@acme.test',
          acceptLoss: [P.broken],
          inviteUnmatched: true,
          noNewInvites: true,
        }),
        quietIo(),
        { source: new FakeSource(syntheticMindspace.data), steps: ALL_STEPS },
      );
      expect(queues).toEqual([]);
      expect(rec.writesTo('workspace_invitations')).toEqual([]);
      expect(report.invited().map((i) => i.status)).toEqual([
        'not-invited',
        'not-invited',
      ]);
    });

    it('without the flag no queue is opened and nobody is invited', async () => {
      const service = moduleRef.get(MindspaceImportService);
      const { report } = await service.run(
        options({ fallbackOwner: 'admin@acme.test', acceptLoss: [P.broken] }),
        quietIo(),
        { source: new FakeSource(syntheticMindspace.data), steps: ALL_STEPS },
      );
      expect(report.invited()).toEqual([]);
      expect(queues).toEqual([]);
      expect(rec.writesTo('workspace_invitations')).toEqual([]);
    });
  });

  it('a real run asks for the workspace name and writes nothing when it does not match', async () => {
    const service = moduleRef.get(MindspaceImportService);
    await expect(
      service.run(
        options({ fallbackOwner: 'admin@acme.test' }),
        quietIo('acme'),
        {
          source: new FakeSource(syntheticMindspace.data),
          steps: ALL_STEPS,
        },
      ),
    ).rejects.toThrow('The name did not match. Nothing was written.');
    expect(rec.writes()).toEqual([]);
  });

  it('refuses a fallback owner who is not an active, verified docmost user', async () => {
    const service = moduleRef.get(MindspaceImportService);
    await expect(
      service.run(
        options({ dryRun: true, fallbackOwner: 'nobody@acme.test' }),
        quietIo(),
        {
          source: new FakeSource({}),
        },
      ),
    ).rejects.toThrow(
      /--fallback-owner nobody@acme.test is not an active docmost user/,
    );
  });
});
