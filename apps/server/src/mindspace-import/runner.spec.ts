import { MemoryImportMap } from './import-map';
import { RecordingWriter } from './recording-writer';
import {
  alreadyImported,
  eachItem,
  runImport,
  type ImportStep,
} from './runner';
import { assertDistinctDatabases } from './mindspace-import.service';
import { sameDatabase } from './source/postgres-mindspace-source';
import { sameServerDatabase } from './source/mindspace-source';
import { msWorkspace } from './testing/fake-source';
import { WS, testContext } from './testing/test-context';

describe('runImport', () => {
  it('runImport runs steps in order and stops at the first that throws', async () => {
    const ran: string[] = [];
    const step = (name: ImportStep['name'], fail = false): ImportStep => ({
      name,
      run: async () => {
        ran.push(name);
        if (fail) throw new Error(`${name} broke`);
      },
    });
    const { ctx } = testContext({});
    await expect(
      runImport(
        [step('people'), step('projects', true), step('docs'), step('shares')],
        ctx,
      ),
    ).rejects.toThrow('projects broke');
    expect(ran).toEqual(['people', 'projects']);
    expect(ctx.report.mismatches()).toEqual([
      'step projects stopped: projects broke',
    ]);
  });

  it('a second run skips rows already in the map and counts them', async () => {
    const data = {
      workspaces: [
        msWorkspace('w1', 'One', 'u1'),
        msWorkspace('w2', 'Two', 'u1'),
      ],
    };
    // a minimal step that follows the re-run rule every real step follows
    const step: ImportStep = {
      name: 'people',
      run: async (ctx) => {
        const workspaces = await ctx.source.workspaces();
        ctx.report.count('workspace.source', workspaces.length);
        for (const w of workspaces) {
          if (await alreadyImported(ctx, 'workspace', w.id, 'workspace'))
            continue;
          await ctx.writer.createSpace({
            id: `space-${w.id}`,
            name: w.name,
            description: '',
            adminId: 'admin',
            map: { type: 'workspace', sourceId: w.id },
          });
          ctx.report.count('workspace.imported');
        }
      },
    };
    const map = new MemoryImportMap();
    const writer = new RecordingWriter(map, WS);

    const first = testContext(data, { map, writer }).ctx;
    await runImport([step], first);
    expect(first.report.get('workspace.imported')).toBe(2);

    const second = testContext(data, { map, writer }).ctx;
    await runImport([step], second);
    expect(second.report.get('workspace.imported')).toBe(0);
    expect(second.report.get('workspace.already-imported')).toBe(2);
    expect(second.report.mismatches()).toEqual([]);
    expect(writer.spaces.size).toBe(2);
  });
});

describe('eachItem', () => {
  it('a failed item leaves only its failure in the report, not what it counted before failing', async () => {
    const { ctx } = testContext({});
    ctx.report.count('project.source', 2);
    await eachItem(ctx, 'project', 'p1', async () => {
      ctx.report.count('project.imported');
    });
    await eachItem(ctx, 'project', 'p2', async () => {
      ctx.report.count('project.imported');
      ctx.report.count('whiteboard.images-stored', 3);
      ctx.report.link('https://old/p/p2', 'https://new/p/x');
      ctx.report.warn('scene-note', { projectId: 'p2' });
      ctx.report.loss('scene-invalid', 'p2', { reason: 'x' });
      throw new Error('disk full');
    });
    expect(ctx.report.get('project.imported')).toBe(1);
    expect(ctx.report.get('project.failed.error')).toBe(1);
    expect(ctx.report.get('whiteboard.images-stored')).toBe(0);
    expect(ctx.report.links()).toEqual([]);
    expect(ctx.report.losses()).toEqual([]);
    expect(ctx.report.warningsOf('scene-note')).toEqual([]);
    // balanced: only the failure itself is listed
    expect(ctx.report.mismatches()).toEqual([
      'project: 1 failed (error); see the item-failed warnings',
    ]);
  });
});

describe('source and target', () => {
  it('the tool refuses to start when source and target point at the same database', () => {
    const target = 'postgresql://docmost@localhost:5432/docmost?schema=public';
    expect(sameDatabase('postgres://other:pw@127.0.0.1/docmost', target)).toBe(
      true,
    );
    expect(sameDatabase('postgres://u@localhost:5432/mindspace', target)).toBe(
      false,
    );
    expect(
      sameDatabase('postgres://u@db.example.com:5432/docmost', target),
    ).toBe(false);
    expect(sameDatabase('postgres://u@localhost:6543/docmost', target)).toBe(
      false,
    );
    expect(() =>
      assertDistinctDatabases('postgres://x@localhost/docmost', target),
    ).toThrow(/point at the same database/);
    expect(() =>
      assertDistinctDatabases('postgres://x@localhost/mindspace', target),
    ).not.toThrow();
  });

  it('compares what each connection reached: server identity, then address, then name', () => {
    const id = (o: Partial<Parameters<typeof sameServerDatabase>[0]>) => ({
      systemIdentifier: '1',
      database: 'docmost',
      address: '10.0.0.1',
      port: 5432,
      ...o,
    });
    // through a pooler or another host name, the same server and database
    expect(
      sameServerDatabase(id({ address: '10.9.9.9', port: 6543 }), id({})),
    ).toBe(true);
    expect(sameServerDatabase(id({ database: 'mindspace' }), id({}))).toBe(
      false,
    );
    expect(sameServerDatabase(id({ systemIdentifier: '2' }), id({}))).toBe(
      false,
    );
    // no identifier: the address decides
    expect(sameServerDatabase(id({ systemIdentifier: null }), id({}))).toBe(
      true,
    );
    expect(
      sameServerDatabase(
        id({ systemIdentifier: null, address: '10.0.0.2' }),
        id({}),
      ),
    ).toBe(false);
    // a socket on one side: the same name is treated as the same database
    expect(
      sameServerDatabase(
        id({ systemIdentifier: null, address: null, port: null }),
        id({}),
      ),
    ).toBe(true);
  });
});
