// Imported first by mindspace-import.module.spec.ts. EnvironmentModule reads
// and validates the environment when it is first imported (and exits the
// process if that fails), so these are set before any docmost module loads.
// Values already set win over the worktree's .env, which is then not needed.
// None of them is ever reached: the spec replaces the database connection
// and the email queue, and uses an in-memory cache.
export const MODULE_SPEC_ENV = {
  DATABASE_URL: 'postgresql://import-spec@db.invalid:5432/import_spec',
  REDIS_URL: 'redis://redis.invalid:6379/0',
  APP_URL: 'http://docs.invalid',
  APP_SECRET: 'mindspace-import-module-spec-secret-0123456789',
  STORAGE_DRIVER: 'local',
} as const;

export const savedEnv = Object.fromEntries(
  Object.keys(MODULE_SPEC_ENV).map((k) => [k, process.env[k]]),
);

Object.assign(process.env, MODULE_SPEC_ENV);
