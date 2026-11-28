import * as Y from 'yjs';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { Page } from '@docmost/db/types/entity.types';
import type { LiveBlockSnapshot } from '@docmost/live-blocks';
import type { RecordedComment, RecordingWriter } from './recording-writer';
import type { SpaceRoleName } from './import-writer';

export type DocmostUser = {
  id: string;
  email: string;
  name: string | null;
  emailVerifiedAt: Date | null;
  deactivatedAt: Date | null;
  deletedAt: Date | null;
};

export type DocmostShare = {
  id: string;
  pageId: string;
  key: string;
  includeSubPages: boolean;
  expiresAt: Date | null;
};

/** Read-only lookups in the target docmost workspace. */
export interface DocmostReader {
  usersByEmail(emails: string[]): Promise<DocmostUser[]>;
  /** Lower-cased names of the workspace's spaces. */
  spaceNames(): Promise<Set<string>>;
  space(
    id: string,
  ): Promise<
    { id: string; slug: string; creatorId: string | null } | undefined
  >;
  spaceMembers(
    spaceId: string,
  ): Promise<{ userId: string; role: SpaceRoleName }[]>;
  page(id: string): Promise<Page | undefined>;
  block(
    id: string,
  ): Promise<
    { pageId: string; snapshot: LiveBlockSnapshot | null } | undefined
  >;
  /** As ShareService.isSharingAllowed: neither the workspace nor the space turned sharing off. */
  sharingAllowed(spaceId: string): Promise<boolean>;
  /** The block's stored Yjs document (what editors open), if any. */
  blockDoc(id: string): Promise<Y.Doc | undefined>;
  pageComments(pageId: string): Promise<RecordedComment[]>;
  share(id: string): Promise<DocmostShare | undefined>;
}

/**
 * docmost users by lower-cased email. An email that more than one account
 * matches without regard to case maps nobody: it is listed in `ambiguous`
 * with the number of accounts, so neither account receives anyone's content.
 */
export async function matchByEmail(
  reader: Pick<DocmostReader, 'usersByEmail'>,
  emails: string[],
): Promise<{
  users: Map<string, DocmostUser>;
  ambiguous: Map<string, number>;
}> {
  const counts = new Map<string, DocmostUser[]>();
  for (const u of await reader.usersByEmail(emails)) {
    const key = u.email.toLowerCase();
    counts.set(key, [...(counts.get(key) ?? []), u]);
  }
  const users = new Map<string, DocmostUser>();
  const ambiguous = new Map<string, number>();
  for (const [email, list] of counts) {
    if (list.length === 1) users.set(email, list[0]);
    else ambiguous.set(email, list.length);
  }
  return { users, ambiguous };
}

/** Reports each ambiguous email once per run. */
export function reportAmbiguous(
  report: { warn(code: string, detail: object): void },
  seen: Set<string>,
  ambiguous: Map<string, number>,
): void {
  for (const [email, count] of ambiguous) {
    if (seen.has(email)) continue;
    seen.add(email);
    report.warn('user-ambiguous', { email, count });
  }
}

export class KyselyDocmostReader implements DocmostReader {
  constructor(
    private readonly db: KyselyDB,
    private readonly workspaceId: string,
  ) {}

  async usersByEmail(emails: string[]) {
    const lower = [...new Set(emails.map((e) => e.toLowerCase()))];
    if (lower.length === 0) return [];
    return this.db
      .selectFrom('users')
      .select([
        'id',
        'email',
        'name',
        'emailVerifiedAt',
        'deactivatedAt',
        'deletedAt',
      ])
      .where('workspaceId', '=', this.workspaceId)
      .where((eb) => eb(eb.fn('lower', ['email']), 'in', lower))
      .execute() as Promise<DocmostUser[]>;
  }

  async spaceNames() {
    const rows = await this.db
      .selectFrom('spaces')
      .select('name')
      .where('workspaceId', '=', this.workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
    return new Set(rows.map((r) => (r.name ?? '').toLowerCase()));
  }

  space(id: string) {
    return this.db
      .selectFrom('spaces')
      .select(['id', 'slug', 'creatorId'])
      .where('id', '=', id)
      .where('workspaceId', '=', this.workspaceId)
      .executeTakeFirst();
  }

  spaceMembers(spaceId: string) {
    return this.db
      .selectFrom('spaceMembers')
      .select(['userId', 'role'])
      .where('spaceId', '=', spaceId)
      .where('userId', 'is not', null)
      .where('deletedAt', 'is', null)
      .execute() as Promise<{ userId: string; role: SpaceRoleName }[]>;
  }

  page(id: string) {
    return this.db
      .selectFrom('pages')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', this.workspaceId)
      .executeTakeFirst() as Promise<Page | undefined>;
  }

  async sharingAllowed(spaceId: string) {
    const row = await this.db
      .selectFrom('workspaces')
      .innerJoin('spaces', 'spaces.workspaceId', 'workspaces.id')
      .select([
        'workspaces.settings as workspaceSettings',
        'spaces.settings as spaceSettings',
      ])
      .where('workspaces.id', '=', this.workspaceId)
      .where('spaces.id', '=', spaceId)
      .executeTakeFirst();
    if (!row) return false;
    return (
      (row.workspaceSettings as any)?.sharing?.disabled !== true &&
      (row.spaceSettings as any)?.sharing?.disabled !== true
    );
  }

  async blockDoc(id: string) {
    const row = await this.db
      .selectFrom('liveBlocks')
      .select('ydoc')
      .where('id', '=', id)
      .where('workspaceId', '=', this.workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!row?.ydoc) return undefined;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.ydoc));
    return doc;
  }

  async block(id: string) {
    const row = await this.db
      .selectFrom('liveBlocks')
      .select(['pageId', 'snapshot'])
      .where('id', '=', id)
      .where('workspaceId', '=', this.workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return row
      ? {
          pageId: row.pageId,
          snapshot: row.snapshot as LiveBlockSnapshot | null,
        }
      : undefined;
  }

  pageComments(pageId: string) {
    return this.db
      .selectFrom('comments')
      .select([
        'id',
        'pageId',
        'parentCommentId',
        'selection',
        'resolvedAt',
        'resolvedById',
        'creatorId',
        'createdAt',
      ])
      .where('pageId', '=', pageId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt')
      .execute() as Promise<RecordedComment[]>;
  }

  async share(id: string) {
    const row = await this.db
      .selectFrom('shares')
      .leftJoin('shareExpiries', 'shareExpiries.shareId', 'shares.id')
      .select([
        'shares.id',
        'shares.pageId',
        'shares.key',
        'shares.includeSubPages',
        'shareExpiries.expiresAt',
      ])
      .where('shares.id', '=', id)
      .where('shares.workspaceId', '=', this.workspaceId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id,
      pageId: row.pageId,
      key: row.key,
      includeSubPages: !!row.includeSubPages,
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
    };
  }
}

/** The dry run's view: what it would have written, on top of docmost. */
export class OverlayDocmostReader implements DocmostReader {
  constructor(
    private readonly recorded: RecordingWriter,
    private readonly base: DocmostReader,
  ) {}

  usersByEmail(emails: string[]) {
    return this.base.usersByEmail(emails);
  }

  async spaceNames() {
    const names = await this.base.spaceNames();
    for (const s of this.recorded.spaces.values())
      names.add(s.name.toLowerCase());
    return names;
  }

  async space(id: string) {
    const s = this.recorded.spaces.get(id);
    return s
      ? { id: s.id, slug: s.slug, creatorId: s.creatorId }
      : this.base.space(id);
  }

  async spaceMembers(spaceId: string) {
    const recorded = this.recorded.members.get(spaceId);
    const base = await this.base.spaceMembers(spaceId);
    const out = new Map(base.map((m) => [m.userId, m.role]));
    // what the dry run recorded (a raised role included) wins over docmost
    for (const [userId, role] of recorded ?? []) out.set(userId, role);
    return [...out].map(([userId, role]) => ({ userId, role }));
  }

  async page(id: string) {
    return this.recorded.pages.get(id) ?? this.base.page(id);
  }

  async block(id: string) {
    return this.recorded.blocks.get(id) ?? this.base.block(id);
  }

  sharingAllowed(spaceId: string) {
    return this.base.sharingAllowed(spaceId);
  }

  async blockDoc(id: string) {
    return this.recorded.blockDocs.get(id) ?? this.base.blockDoc(id);
  }

  async pageComments(pageId: string) {
    const recorded = [...this.recorded.comments.values()].filter(
      (c) => c.pageId === pageId,
    );
    const base = await this.base.pageComments(pageId);
    const ids = new Set(recorded.map((c) => c.id));
    return [...base.filter((c) => !ids.has(c.id)), ...recorded];
  }

  async share(id: string) {
    const s = this.recorded.shares.get(id);
    if (!s) return this.base.share(id);
    return { id, ...s };
  }
}
