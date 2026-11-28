// Rows read from a mindspace database, as its supabase/migrations 0001 to 0016
// leave the schema. Column names are camel-cased; nothing else is changed.

export type MsUser = {
  id: string;
  email: string | null;
  /** auth.users.email_confirmed_at; null for a sign-up that was never confirmed. */
  emailConfirmedAt: Date | null;
};

export type MsWorkspace = {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
};

export type MsMemberRole = 'editor' | 'viewer';

export type MsMember = {
  workspaceId: string;
  userId: string;
  role: MsMemberRole;
};

export type MsProjectKind = 'whiteboard' | 'doc' | 'todo' | 'sheet';

export type MsProject = {
  id: string;
  workspaceId: string;
  name: string;
  kind: MsProjectKind;
  /** jsonb: an object, or a string for old rows; null for an empty project. */
  scene: unknown;
  position: number | null;
  visibility: 'private' | 'link';
  linkExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MsDocument = {
  id: string;
  projectId: string;
  name: string;
  content: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
};

export type MsComment = {
  id: string;
  documentId: string;
  /** null for a thread root. */
  parentId: string | null;
  body: string;
  anchorQuote: string | null;
  anchorPrefix: string;
  anchorSuffix: string;
  /** null when the author was deleted from mindspace. */
  createdBy: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
};

export type MsProjectShare = {
  projectId: string;
  email: string;
  role: 'viewer' | 'editor';
};
