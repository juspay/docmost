import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  adminDeletePasskeys,
  deletePasskey,
  listPasskeys,
  renamePasskey,
} from "../services/passkey-service.ts";

export const PASSKEYS_KEY = ["passkeys"];

export function usePasskeysQuery() {
  return useQuery({ queryKey: PASSKEYS_KEY, queryFn: listPasskeys });
}

export function useRenamePasskeyMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: renamePasskey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      notifications.show({ message: t("Passkey renamed") });
    },
    onError: (error: any) => {
      notifications.show({
        message:
          error?.response?.data?.message ?? t("Failed to rename passkey"),
        color: "red",
      });
    },
  });
}

export function useDeletePasskeyMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: deletePasskey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      notifications.show({ message: t("Passkey deleted") });
    },
    onError: (error: any) => {
      notifications.show({
        message:
          error?.response?.data?.message ?? t("Failed to delete passkey"),
        color: "red",
      });
    },
  });
}

export function useAdminDeletePasskeysMutation() {
  const { t } = useTranslation();
  return useMutation({
    mutationFn: adminDeletePasskeys,
    onSuccess: () => {
      notifications.show({ message: t("Passkeys removed") });
    },
    onError: (error: any) => {
      notifications.show({
        message:
          error?.response?.data?.message ?? t("Failed to remove passkeys"),
        color: "red",
      });
    },
  });
}
