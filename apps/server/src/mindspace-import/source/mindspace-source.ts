import type {
  MsComment,
  MsDocument,
  MsMember,
  MsProject,
  MsProjectShare,
  MsUser,
  MsWorkspace,
} from './mindspace.types';

/** Which server and database a connection really reached. */
export type ServerIdentity = {
  /** pg_control_system().system_identifier; null when the role may not read it. */
  systemIdentifier: string | null;
  database: string;
  /** inet_server_addr() and inet_server_port(); null over a Unix socket. */
  address: string | null;
  port: number | null;
};

export interface MindspaceSource {
  /** Optional: the import refuses to start when it equals docmost's. */
  identity?(): Promise<ServerIdentity>;
  users(): Promise<MsUser[]>;
  workspaces(): Promise<MsWorkspace[]>;
  members(): Promise<MsMember[]>;
  projects(): Promise<MsProject[]>;
  documents(): Promise<MsDocument[]>;
  comments(): Promise<MsComment[]>;
  projectShares(): Promise<MsProjectShare[]>;
  close(): Promise<void>;
}

/** True when both identities are the same database on the same server. */
export function sameServerDatabase(
  a: ServerIdentity,
  b: ServerIdentity,
): boolean {
  if (a.database !== b.database) return false;
  if (a.systemIdentifier && b.systemIdentifier) {
    return a.systemIdentifier === b.systemIdentifier;
  }
  if (a.address && b.address) {
    return a.address === b.address && a.port === b.port;
  }
  // a socket connection on either side: same name is treated as the same database
  return true;
}
