jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

import { MemoryImportMap, targetId } from './import-map';
import { RecordingWriter } from './recording-writer';
import { ALL_STEPS } from './steps';
import { FailingWriter } from './testing/failing-writer';
import {
  msComment,
  msDocument,
  msProject,
  msUser,
  msWorkspace,
  type FakeData,
} from './testing/fake-source';
import {
  overviewMarkdown,
  whiteboardScene,
} from './testing/synthetic-mindspace';
import { WS, docmostUser, testContext } from './testing/test-context';
import { verifyImport } from './verify';

const ada = docmostUser('d-ada', 'ada@acme.test', { name: 'Ada' });
const data: FakeData = {
  users: [msUser('m-ada', 'ada@acme.test')],
  workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
  projects: [
    msProject({ id: 'p1', workspaceId: 'w1', scene: whiteboardScene }),
    msProject({
      id: 'p2',
      workspaceId: 'w1',
      scene: whiteboardScene,
      position: 2048,
      visibility: 'link',
    }),
    msProject({ id: 'dp', workspaceId: 'w1', kind: 'doc', position: 3072 }),
  ],
  documents: [
    msDocument({ id: 'd1', projectId: 'dp', content: overviewMarkdown }),
    msDocument({
      id: 'd2',
      projectId: 'dp',
      position: 1,
      content: 'Short note.',
    }),
  ],
  comments: [
    msComment({ id: 'c1', documentId: 'd1', anchorQuote: 'Read the source' }),
    msComment({ id: 'c2', documentId: 'd1', parentId: 'c1' }),
  ],
};

async function importAll(writer: FailingWriter, map: MemoryImportMap) {
  const world = testContext(data, { users: [ada], map, writer: writer.inner });
  world.ctx.writer = writer;
  for (const step of ALL_STEPS) await step.run(world.ctx);
  await verifyImport(world.ctx, ALL_STEPS);
  return world.ctx;
}

describe('a run with failing items', () => {
  it('carries on past them, reports each one, and a second run finishes the rest without duplicates', async () => {
    const map = new MemoryImportMap();
    const inner = new RecordingWriter(map, WS);
    const broken = new FailingWriter(
      inner,
      (call) =>
        // a reply inside the d1 transaction, and p2's block
        (call.op === 'comment' &&
          call.input.id === targetId(WS, 'comment', 'c2')) ||
        (call.op === 'block' &&
          call.input.blockId === targetId(WS, 'block', 'p2')),
    );

    const first = await importAll(broken, map);
    expect(broken.failures).toBe(2);
    // everything else was imported
    expect(inner.pages.has(targetId(WS, 'project', 'p1'))).toBe(true);
    expect(inner.pages.has(targetId(WS, 'document', 'd2'))).toBe(true);
    // the failed document's transaction left nothing: no page, no comment, no map row
    expect(inner.pages.has(targetId(WS, 'document', 'd1'))).toBe(false);
    expect(inner.comments.size).toBe(0);
    expect(await map.get('document', 'd1')).toBeUndefined();
    expect(await map.get('project', 'p2')).toBeUndefined();
    expect(first.report.warningsOf('item-failed')).toEqual([
      { kind: 'project', id: 'p2', error: 'injected failure on block' },
      { kind: 'document', id: 'd1', error: 'injected failure on comment' },
    ]);
    expect(first.report.get('link.failed.project-failed')).toBe(1);
    expect(first.report.get('comment.failed.document-failed')).toBe(2);
    expect(first.report.mismatches()).toEqual(
      expect.arrayContaining([
        'project: 1 failed (error); see the item-failed warnings',
        'document: 1 failed (error); see the item-failed warnings',
      ]),
    );

    const before = inner.operations.slice();
    const second = await importAll(new FailingWriter(inner, () => false), map);
    expect(second.report.mismatches()).toEqual([]);
    const created = inner.operations.slice(before.length);
    // only what was missing: p2's block (its empty page is adopted), d1 with its two comments, p2's share
    expect(created).toEqual([
      `block ${targetId(WS, 'block', 'p2')}`,
      `content ${targetId(WS, 'project', 'p2')}`,
      `page ${targetId(WS, 'document', 'd1')}`,
      `comment ${targetId(WS, 'comment', 'c1')}`,
      `comment ${targetId(WS, 'comment', 'c2')}`,
      `share ${targetId(WS, 'share', 'p2')}`,
    ]);
    expect(new Set(inner.operations).size).toBe(inner.operations.length);
  });
});
