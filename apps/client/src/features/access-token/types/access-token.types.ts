export type AccessTokenScope = "read" | "write";

export interface IAccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scope: AccessTokenScope;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ICreatedAccessToken extends IAccessToken {
  token: string;
}

export interface ICreateAccessToken {
  name: string;
  scope: AccessTokenScope;
  expiresAt?: string | null;
}
