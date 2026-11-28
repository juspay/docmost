import { useQuery, UseQueryResult } from "@tanstack/react-query";
import type { LiveBlockHost } from "../live-block-host";
import type { LiveBlockSnapshotResponse } from "../live-block.types";
import {
  getLiveBlockSnapshot,
  getSharedLiveBlockSnapshot,
} from "../services/live-block-service";

export const SNAPSHOT_REFETCH_MS = 30_000;

export function useLiveBlockSnapshotQuery(args: {
  host: LiveBlockHost;
  blockId: string | null;
  enabled: boolean;
}): UseQueryResult<LiveBlockSnapshotResponse, any> {
  const { host, blockId, enabled } = args;
  const pageId = "pageId" in host ? host.pageId : null;
  const shareId = host.mode === "share" ? host.shareId : undefined;
  return useQuery({
    queryKey: ["live-block-snapshot", host.mode, pageId, shareId, blockId],
    enabled: enabled && Boolean(blockId && pageId) && host.mode !== "none",
    queryFn: () =>
      host.mode === "share"
        ? getSharedLiveBlockSnapshot({ shareId, pageId, blockId })
        : getLiveBlockSnapshot({ blockId, pageId }),
    // a past version is shown with today's block content once; it does not need refreshing
    refetchInterval:
      enabled && host.mode !== "history" ? SNAPSHOT_REFETCH_MS : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
