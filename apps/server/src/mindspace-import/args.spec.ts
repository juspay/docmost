import { ArgsError, parseArgs, USAGE } from './args';

const required = [
  '--docmost-workspace',
  'ws-1',
  '--fallback-owner',
  'Admin@Example.com',
  '--old-base-url',
  'https://mindspace.example.com/',
];

describe('mindspace import arguments', () => {
  it('args: --docmost-workspace, --fallback-owner and --old-base-url are required', () => {
    for (let i = 0; i < required.length; i += 2) {
      const without = [...required.slice(0, i), ...required.slice(i + 2)];
      expect(() => parseArgs(without)).toThrow(
        new ArgsError(`${required[i]} is required`),
      );
    }
    const options = parseArgs(['--', ...required]);
    expect(options).toEqual({
      docmostWorkspace: 'ws-1',
      fallbackOwner: 'admin@example.com',
      oldBaseUrl: 'https://mindspace.example.com',
      dryRun: false,
      only: undefined,
      report: undefined,
      grantFallbackAdmin: false,
      inviteUnmatched: false,
      noNewInvites: false,
      acceptLoss: [],
    });
  });

  it('args: --only accepts a comma list and rejects an unknown step', () => {
    // always in the fixed order, whatever order was typed
    expect(parseArgs([...required, '--only', 'shares,people']).only).toEqual([
      'people',
      'shares',
    ]);
    expect(() => parseArgs([...required, '--only', 'people,boards'])).toThrow(
      /Unknown step in --only: boards/,
    );
  });

  it('--only with --dry-run is refused', () => {
    expect(() =>
      parseArgs([...required, '--dry-run', '--only', 'people']),
    ).toThrow(/--only cannot be combined with --dry-run/);
  });

  it('reads --accept-loss as a list, --report, and the two switches', () => {
    const options = parseArgs([
      ...required,
      '--dry-run',
      '--grant-fallback-admin',
      '--invite-unmatched',
      '--no-new-invites',
      '--report',
      '/tmp/r.json',
      '--accept-loss',
      'p1, p2',
      '--accept-loss',
      'p3',
    ]);
    expect(options).toMatchObject({
      dryRun: true,
      grantFallbackAdmin: true,
      inviteUnmatched: true,
      noNewInvites: true,
      report: '/tmp/r.json',
      acceptLoss: ['p1', 'p2', 'p3'],
    });
  });

  it('rejects an unknown flag and a flag without its value', () => {
    expect(() => parseArgs([...required, '--force'])).toThrow(
      /Unknown argument: --force/,
    );
    expect(() => parseArgs([...required, '--report'])).toThrow(
      /--report needs a value/,
    );
  });
});

describe('USAGE', () => {
  it('names the command that exists in the production image', () => {
    expect(USAGE.split('\n')[0]).toMatch(
      /^Usage: node dist\/mindspace-import\/main /,
    );
  });
});
