import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
} from "@/features/access-token/services/access-token-service";
import {
  IAccessToken,
  ICreateAccessToken,
  ICreatedAccessToken,
} from "@/features/access-token/types/access-token.types";

const KEY = ["access-tokens"];

export function useAccessTokensQuery(): UseQueryResult<IAccessToken[], Error> {
  return useQuery({ queryKey: KEY, queryFn: () => listAccessTokens() });
}

export function useCreateAccessTokenMutation() {
  const queryClient = useQueryClient();
  return useMutation<ICreatedAccessToken, Error, ICreateAccessToken>({
    // the result holds the token's secret; don't keep it in the mutation cache
    gcTime: 0,
    mutationFn: (data) => createAccessToken(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
    onError: (error) => {
      notifications.show({
        message: error["response"]?.data?.message,
        color: "red",
      });
    },
  });
}

export function useRevokeAccessTokenMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation<void, Error, { id: string }>({
    mutationFn: (data) => revokeAccessToken(data),
    onSuccess: () => {
      notifications.show({ message: t("Access token revoked") });
      queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (error) => {
      notifications.show({
        message: error["response"]?.data?.message,
        color: "red",
      });
    },
  });
}
