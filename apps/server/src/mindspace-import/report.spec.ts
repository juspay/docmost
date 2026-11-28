import { ImportReport } from './report';

describe('ImportReport', () => {
  it('report.mismatches lists a source count that differs from its imported + skipped + failed count', () => {
    const report = new ImportReport();
    report.count('project.source', 5);
    report.count('project.imported', 2);
    report.count('project.already-imported', 1);
    report.count('project.skipped.owner-unmatched', 1);
    report.count('project.images', 9); // information, not part of the balance
    expect(report.mismatches()).toEqual([
      'project: 5 in mindspace, but 4 imported, already imported, skipped or failed',
    ]);

    report.count('project.failed.write-error');
    // balanced now, but a failed item still fails the run
    expect(report.mismatches()).toEqual([
      'project: 1 failed (write-error); see the item-failed warnings',
    ]);
  });

  it('a skip or failure without a named reason is a mismatch', () => {
    const report = new ImportReport();
    report.count('comment.source', 1);
    report.count('comment.skipped');
    expect(report.mismatches()).toEqual([
      'comment: 1 skipped without a named reason',
      'comment: 1 in mindspace, but 0 imported, already imported, skipped or failed',
    ]);
  });

  it('a failed check is listed after the count mismatches', () => {
    const report = new ImportReport();
    report.fail('project p1 has no page');
    expect(report.mismatches()).toEqual(['project p1 has no page']);
  });

  it('groups warnings by code, keeps one link pair per old URL, and lists losses', () => {
    const report = new ImportReport();
    report.warn('user-unmatched', { email: 'a@x' });
    report.warn('user-unmatched', { email: 'b@x' });
    report.loss('scene-invalid', 'p1', { reason: 'bad json' });
    report.link('https://old/p/p1', 'https://new/p/abc');
    report.link('https://old/p/p1', 'https://new/share/k/p/abc');

    const json = report.toJSON() as any;
    expect(json.warnings['user-unmatched']).toEqual([
      { email: 'a@x' },
      { email: 'b@x' },
    ]);
    expect(json.warnings['scene-invalid']).toEqual([
      { projectId: 'p1', reason: 'bad json' },
    ]);
    expect(json.losses).toEqual([
      {
        code: 'scene-invalid',
        projectId: 'p1',
        detail: { reason: 'bad json' },
      },
    ]);
    expect(json.links).toEqual([
      {
        oldUrl: 'https://old/p/p1',
        newUrl: 'https://new/share/k/p/abc',
        pageUrl: 'https://new/p/abc',
      },
    ]);
    const text = report.toText();
    expect(text).toContain('user-unmatched (2)');
    expect(text).toContain(
      'https://old/p/p1 -> https://new/share/k/p/abc (page https://new/p/abc)',
    );
  });

  it('a failure naming a project with a newline or a terminal escape cannot forge lines', () => {
    const report = new ImportReport();
    report.fail(
      'project p1 ("evil\nMismatches (0)\u001b[2K") has no page in docmost',
    );
    const [line] = report.mismatches();
    expect(line).toBe(
      'project p1 ("evil\\nMismatches (0)\\u001b[2K") has no page in docmost',
    );
    expect(report.toText()).not.toMatch(/\nMismatches \(0\)\u001b/);
  });
});
