import type { Inviter } from '../invites';
import type { SpaceRoleName } from '../import-writer';
import type { User } from '@docmost/db/types/entity.types';
import type { ImportOptions } from '../args';
import {
  OverlayDocmostReader,
  type DocmostReader,
  type DocmostUser,
} from '../docmost-reader';
import { MemoryImportMap, type ImportMap } from '../import-map';
import { RecordingWriter } from '../recording-writer';
import { ImportReport } from '../report';
import { CachedSource, type ImportContext } from '../runner';
import {
  DryRunFileStore,
  type WhiteboardFileStore,
} from '../whiteboard-file-store';
import { FakeSource, type FakeData } from './fake-source';

export const WS = '0b6b1b7e-6f0e-4b52-9d8e-1f6b6a3c0001';

export const docmostUser = (
  id: string,
  email: string,
  extra: Partial<DocmostUser> = {},
): DocmostUser => ({
  id,
  email,
  name: email.split('@')[0],
  emailVerifiedAt: new Date('2026-01-01'),
  deactivatedAt: null,
  deletedAt: null,
  ...extra,
});

/** Docmost as it is before the import: people and existing space names only. */
export class FakeDocmost implements DocmostReader {
  constructor(
    readonly users: DocmostUser[] = [],
    readonly existingSpaceNames: string[] = [],
    readonly existingMembers: Record<
      string,
      { userId: string; role: SpaceRoleName }[]
    > = {},
  ) {}

  async usersByEmail(emails: string[]) {
    const wanted = new Set(emails.map((e) => e.toLowerCase()));
    return this.users.filter((u) => wanted.has(u.email.toLowerCase()));
  }
  sharing = true;
  async sharingAllowed() {
    return this.sharing;
  }
  async blockDoc() {
    return undefined;
  }
  async spaceNames() {
    return new Set(this.existingSpaceNames.map((n) => n.toLowerCase()));
  }
  async space() {
    return undefined;
  }
  async spaceMembers(spaceId: string) {
    return this.existingMembers[spaceId] ?? [];
  }
  async page() {
    return undefined;
  }
  async block() {
    return undefined;
  }
  async pageComments() {
    return [];
  }
  async share() {
    return undefined;
  }
}

export const options = (o: Partial<ImportOptions> = {}): ImportOptions => ({
  docmostWorkspace: WS,
  fallbackOwner: 'fallback@example.com',
  oldBaseUrl: 'https://mind.example.com',
  dryRun: false,
  grantFallbackAdmin: false,
  acceptLoss: [],
  ...o,
});

export type TestWorld = {
  ctx: ImportContext;
  writer: RecordingWriter;
  source: FakeSource;
};

/**
 * A context whose writer keeps everything in memory. Pass the same `map` and
 * `writer` again to model a second run against the same docmost.
 */
export function testContext(
  data: FakeData,
  o: {
    users?: DocmostUser[];
    spaceNames?: string[];
    map?: ImportMap;
    writer?: RecordingWriter;
    files?: WhiteboardFileStore;
    options?: Partial<ImportOptions>;
    fallbackOwner?: Partial<User>;
    invites?: Inviter;
    /** members already in docmost, by space id */
    members?: Record<string, { userId: string; role: SpaceRoleName }[]>;
    /** sharing switched off in docmost for every space */
    sharingOff?: boolean;
  } = {},
): TestWorld {
  const map = o.map ?? new MemoryImportMap();
  const base = new FakeDocmost(
    o.users ?? [],
    o.spaceNames ?? [],
    o.members ?? {},
  );
  base.sharing = !o.sharingOff;
  const writer = o.writer ?? new RecordingWriter(map, WS, base);
  const source = new FakeSource(data);
  const ctx: ImportContext = {
    workspaceId: WS,
    dryRun: false,
    source: new CachedSource(source),
    map,
    report: new ImportReport(),
    fallbackOwner: {
      id: 'fallback-user',
      email: 'fallback@example.com',
      name: 'Fallback',
      ...o.fallbackOwner,
    } as User,
    options: options(o.options),
    writer,
    docmost: new OverlayDocmostReader(writer, base),
    files: o.files ?? new DryRunFileStore('50mb'),
    urls: {
      page: (spaceSlug, slugId) =>
        `https://docs.example.com/s/${spaceSlug}/p/${slugId}`,
      share: (key, slugId) =>
        `https://docs.example.com/share/${key}/p/${slugId}`,
    },
    invites: o.invites,
    state: {},
  };
  return { ctx, writer, source };
}
