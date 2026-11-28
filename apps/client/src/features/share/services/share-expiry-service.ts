import api from "@/lib/api-client";
import {
  IShareExpiry,
  SharePeriodDays,
} from "@/features/share/types/share.types.ts";

export async function setShareExpiry(data: {
  shareId: string;
  periodDays: SharePeriodDays | null;
}): Promise<IShareExpiry | null> {
  const req = await api.post<IShareExpiry | null>("/shares/expiry/set", data);
  return req.data ?? null;
}

export async function renewShareExpiry(data: {
  shareId: string;
}): Promise<IShareExpiry> {
  const req = await api.post<IShareExpiry>("/shares/expiry/renew", data);
  return req.data;
}
