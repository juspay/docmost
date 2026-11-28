export const STEP_NAMES = ['people', 'projects', 'docs', 'shares'] as const;
export type StepName = (typeof STEP_NAMES)[number];

export type ImportOptions = {
  docmostWorkspace: string;
  fallbackOwner: string;
  oldBaseUrl: string;
  dryRun: boolean;
  /** Steps to run, always in the fixed order; undefined runs them all. */
  only?: StepName[];
  report?: string;
  grantFallbackAdmin: boolean;
  /** Invite people with no docmost account to the workspace (Q3). */
  inviteUnmatched?: boolean;
  /**
   * For the last runs: send and renew no invitation; list everyone with an
   * unaccepted invitation, expired or not, as invited-not-accepted.
   */
  noNewInvites?: boolean;
  acceptLoss: string[];
};

export class ArgsError extends Error {}

export const USAGE = `Usage: node dist/mindspace-import/main \\
  --docmost-workspace <id> --fallback-owner <email> --old-base-url <url>
  [--dry-run] [--only people,projects,docs,shares] [--report <file>]
  [--grant-fallback-admin] [--invite-unmatched] [--no-new-invites] [--accept-loss <project id,...>]
(run it in apps/server; from a source checkout use pnpm --filter server mindspace:import -- <flags>)`;

const VALUE_FLAGS = new Set([
  '--docmost-workspace',
  '--fallback-owner',
  '--old-base-url',
  '--only',
  '--report',
  '--accept-loss',
]);
const BOOLEAN_FLAGS = new Set([
  '--dry-run',
  '--grant-fallback-admin',
  '--invite-unmatched',
  '--no-new-invites',
]);

const list = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function parseArgs(argv: string[]): ImportOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const acceptLoss: string[] = [];

  // pnpm passes a lone "--" through
  const args = argv.filter((a) => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.add(arg);
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) throw new ArgsError(`Unknown argument: ${arg}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ArgsError(`${arg} needs a value`);
    }
    i++;
    if (arg === '--accept-loss') acceptLoss.push(...list(value));
    else values.set(arg, value);
  }

  for (const required of [
    '--docmost-workspace',
    '--fallback-owner',
    '--old-base-url',
  ]) {
    if (!values.get(required)) throw new ArgsError(`${required} is required`);
  }

  let only: StepName[] | undefined;
  if (values.has('--only')) {
    const wanted = list(values.get('--only'));
    for (const name of wanted) {
      if (!(STEP_NAMES as readonly string[]).includes(name)) {
        throw new ArgsError(
          `Unknown step in --only: ${name} (steps: ${STEP_NAMES.join(', ')})`,
        );
      }
    }
    if (wanted.length === 0)
      throw new ArgsError('--only needs at least one step');
    only = STEP_NAMES.filter((s) => wanted.includes(s));
  }

  const dryRun = flags.has('--dry-run');
  if (dryRun && only) {
    throw new ArgsError(
      '--only cannot be combined with --dry-run: a dry run keeps its mappings in memory, so later steps would have nothing to build on',
    );
  }

  let oldBaseUrl = values.get('--old-base-url');
  try {
    new URL(oldBaseUrl);
  } catch {
    throw new ArgsError(`--old-base-url is not a URL: ${oldBaseUrl}`);
  }
  oldBaseUrl = oldBaseUrl.replace(/\/+$/, '');

  return {
    docmostWorkspace: values.get('--docmost-workspace'),
    fallbackOwner: values.get('--fallback-owner').trim().toLowerCase(),
    oldBaseUrl,
    dryRun,
    only,
    report: values.get('--report'),
    grantFallbackAdmin: flags.has('--grant-fallback-admin'),
    inviteUnmatched: flags.has('--invite-unmatched'),
    noNewInvites: flags.has('--no-new-invites'),
    acceptLoss,
  };
}
