import api from "@/lib/api-client";
import {
  IAccessToken,
  ICreateAccessToken,
  ICreatedAccessToken,
} from "@/features/access-token/types/access-token.types";

export async function listAccessTokens(): Promise<IAccessToken[]> {
  const req = await api.post<IAccessToken[]>("/access-tokens/list");
  return req.data;
}

export async function createAccessToken(
  data: ICreateAccessToken,
): Promise<ICreatedAccessToken> {
  const req = await api.post<ICreatedAccessToken>(
    "/access-tokens/create",
    data,
  );
  return req.data;
}

export async function revokeAccessToken(data: { id: string }): Promise<void> {
  await api.post("/access-tokens/revoke", data);
}
