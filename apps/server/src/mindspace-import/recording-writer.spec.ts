import { MemoryImportMap } from './import-map';
import { RecordingWriter } from './recording-writer';
import { msUser, msWorkspace } from './testing/fake-source';
import {
  FakeDocmost,
  WS,
  docmostUser,
  testContext,
} from './testing/test-context';
import { peopleStep } from './steps/people.step';

describe('RecordingWriter.addSpaceMember', () => {
  it('a person who is already a member in docmost is not added again', async () => {
    const base = new FakeDocmost();
    base.spaceMembers = async () => [{ userId: 'u-1', role: 'admin' }];
    const writer = new RecordingWriter(new MemoryImportMap(), WS, base);
    expect(await writer.addSpaceMember('sp-1', 'u-1', 'admin')).toBe(false);
    expect(await writer.addSpaceMember('sp-1', 'u-2', 'reader')).toBe(true);
    expect(writer.operations).toEqual(['member sp-1 u-2 reader']);
  });

  it('a dry run after a real run reports no space-owner-added for an owner who is already admin', async () => {
    const ada = docmostUser('d-ada', 'ada@acme.test');
    const map = new MemoryImportMap();
    // the real run imported the workspace: its map row and its admin are in docmost
    await map.set('workspace', 'w1', 'space', 'sp-1');
    const { ctx, writer } = testContext(
      {
        users: [msUser('m-ada', 'ada@acme.test')],
        workspaces: [msWorkspace('w1', 'Team', 'm-ada')],
      },
      {
        users: [ada],
        map,
        members: { 'sp-1': [{ userId: 'd-ada', role: 'admin' }] },
      },
    );
    await peopleStep.run(ctx);
    expect(ctx.report.warningsOf('space-owner-added')).toEqual([]);
    expect(writer.operations).toEqual([]);
  });
});
