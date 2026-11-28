import api from "@/lib/api-client";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { IPasskey } from "../types/passkey.types";

export async function getPasskeyLoginOptions(): Promise<{
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const req = await api.post("/passkeys/login/options");
  return req.data;
}

export async function verifyPasskeyLogin(data: {
  challengeId: string;
  response: AuthenticationResponseJSON;
}): Promise<void> {
  await api.post("/passkeys/login/verify", data);
}

export async function getPasskeyRegisterOptions(
  currentPassword?: string,
): Promise<{
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}> {
  const req = await api.post("/passkeys/register/options", { currentPassword });
  return req.data;
}

export async function verifyPasskeyRegistration(data: {
  challengeId: string;
  response: RegistrationResponseJSON;
  name: string;
}): Promise<{ id: string; name: string; createdAt: string }> {
  const req = await api.post("/passkeys/register/verify", data);
  return req.data;
}

export async function listPasskeys(): Promise<IPasskey[]> {
  const req = await api.post<IPasskey[]>("/passkeys/list");
  return req.data;
}

export async function renamePasskey(data: {
  id: string;
  name: string;
}): Promise<void> {
  await api.post("/passkeys/rename", data);
}

export async function deletePasskey(id: string): Promise<void> {
  await api.post("/passkeys/delete", { id });
}

export async function adminDeletePasskeys(userId: string): Promise<void> {
  await api.post("/passkeys/admin-delete", { userId });
}
