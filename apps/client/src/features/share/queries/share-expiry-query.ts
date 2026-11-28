import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  renewShareExpiry,
  setShareExpiry,
} from "@/features/share/services/share-expiry-service.ts";
import {
  IShareExpiry,
  IShareForPage,
  SharePeriodDays,
} from "@/features/share/types/share.types.ts";

// The server returns the whole new state, so the cached share is updated in
// place and the dialog shows the new date without another round trip.
function useApplyExpiry(shareId: string) {
  const queryClient = useQueryClient();

  return (expiry: IShareExpiry | null) => {
    queryClient.setQueriesData<IShareForPage | null>(
      { queryKey: ["share-for-page"] },
      (share) =>
        share && share.id === shareId
          ? {
              ...share,
              expiresAt: expiry?.expiresAt ?? null,
              periodDays: expiry?.periodDays ?? null,
              expired: expiry?.expired ?? false,
            }
          : share,
    );
    queryClient.invalidateQueries({ queryKey: ["share-list"] });
  };
}

export function useSetShareExpiryMutation(shareId: string) {
  const { t } = useTranslation();
  const apply = useApplyExpiry(shareId);

  return useMutation<IShareExpiry | null, Error, SharePeriodDays | null>({
    mutationFn: (periodDays) => setShareExpiry({ shareId, periodDays }),
    onSuccess: apply,
    onError: (error) => {
      notifications.show({
        message:
          error?.["response"]?.data?.message ||
          t("Failed to update link expiry"),
        color: "red",
      });
    },
  });
}

export function useRenewShareExpiryMutation(shareId: string) {
  const { t } = useTranslation();
  const apply = useApplyExpiry(shareId);

  return useMutation<IShareExpiry, Error, void>({
    mutationFn: () => renewShareExpiry({ shareId }),
    onSuccess: apply,
    onError: (error) => {
      notifications.show({
        message:
          error?.["response"]?.data?.message || t("Failed to renew link"),
        color: "red",
      });
    },
  });
}
