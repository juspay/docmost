import api from "@/lib/api-client";
import type { LiveBlockKind } from "@docmost/live-blocks";
import type { LiveBlockSnapshotResponse } from "../live-block.types";

export async function ensureLiveBlock(data: {
  blockId: string;
  pageId: string;
  kind: LiveBlockKind;
}): Promise<{ blockId: string }> {
  const req = await api.post<{ blockId: string }>("/live-blocks/ensure", data);
  return req.data;
}

export async function cloneLiveBlock(data: {
  sourceBlockId: string;
  blockId: string;
  pageId: string;
}): Promise<{ blockId: string }> {
  const req = await api.post<{ blockId: string }>("/live-blocks/clone", data);
  return req.data;
}

export async function getLiveBlockSnapshot(data: {
  blockId: string;
  pageId: string;
}): Promise<LiveBlockSnapshotResponse> {
  const req = await api.post<LiveBlockSnapshotResponse>(
    "/live-blocks/snapshot",
    data,
  );
  return req.data;
}

export async function getSharedLiveBlockSnapshot(data: {
  shareId?: string;
  pageId: string;
  blockId: string;
}): Promise<LiveBlockSnapshotResponse> {
  const req = await api.post<LiveBlockSnapshotResponse>(
    "/shares/live-block",
    data,
  );
  return req.data;
}
