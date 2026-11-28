import type { MindspaceSource } from '../source/mindspace-source';
import type {
  MsComment,
  MsDocument,
  MsMember,
  MsProject,
  MsProjectShare,
  MsUser,
  MsWorkspace,
} from '../source/mindspace.types';

export type FakeData = {
  users?: MsUser[];
  workspaces?: MsWorkspace[];
  members?: MsMember[];
  projects?: MsProject[];
  documents?: MsDocument[];
  comments?: MsComment[];
  projectShares?: MsProjectShare[];
};

/** Arrays in, arrays out. */
export class FakeSource implements MindspaceSource {
  closed = false;
  reads = 0;

  constructor(readonly data: FakeData = {}) {}

  private give<T>(rows: T[] | undefined): Promise<T[]> {
    this.reads++;
    return Promise.resolve(structuredClone(rows ?? []));
  }

  users = () => this.give(this.data.users);
  workspaces = () => this.give(this.data.workspaces);
  members = () => this.give(this.data.members);
  projects = () => this.give(this.data.projects);
  documents = () => this.give(this.data.documents);
  comments = () => this.give(this.data.comments);
  projectShares = () => this.give(this.data.projectShares);
  async close() {
    this.closed = true;
  }
}

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));

export const msUser = (
  id: string,
  email: string,
  confirmed = true,
): MsUser => ({
  id,
  email,
  emailConfirmedAt: confirmed ? at(0) : null,
});

export const msWorkspace = (
  id: string,
  name: string,
  ownerId: string,
): MsWorkspace => ({
  id,
  name,
  ownerId,
  createdAt: at(1),
});

export const msProject = (
  p: Partial<MsProject> & Pick<MsProject, 'id' | 'workspaceId'>,
): MsProject => ({
  name: `Project ${p.id}`,
  kind: 'whiteboard',
  scene: null,
  position: 1024,
  visibility: 'private',
  linkExpiresAt: null,
  createdAt: at(2),
  updatedAt: at(5),
  ...p,
});

export const msDocument = (
  d: Partial<MsDocument> & Pick<MsDocument, 'id' | 'projectId'>,
): MsDocument => ({
  name: `${d.id}.md`,
  content: '',
  position: 0,
  createdAt: at(3),
  updatedAt: at(6),
  ...d,
});

export const msComment = (
  c: Partial<MsComment> & Pick<MsComment, 'id' | 'documentId'>,
): MsComment => ({
  parentId: null,
  body: `comment ${c.id}`,
  anchorQuote: null,
  anchorPrefix: '',
  anchorSuffix: '',
  createdBy: null,
  createdAt: at(4),
  resolvedAt: null,
  resolvedBy: null,
  ...c,
});
