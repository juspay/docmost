import { Button, Group, SegmentedControl, Text } from "@mantine/core";
import React from "react";
import { useTranslation } from "react-i18next";
import { IShareForPage } from "@/features/share/types/share.types.ts";
import {
  useRenewShareExpiryMutation,
  useSetShareExpiryMutation,
} from "@/features/share/queries/share-expiry-query.ts";
import { formatLocalized, useDateFnsLocale } from "@/lib/date-locale.ts";

const NEVER = "never";

interface ShareExpiryControlProps {
  share: IShareForPage;
  readOnly: boolean;
}

export default function ShareExpiryControl({
  share,
  readOnly,
}: ShareExpiryControlProps) {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();
  const setExpiry = useSetShareExpiryMutation(share.id);
  const renew = useRenewShareExpiryMutation(share.id);

  const inherited = share.level > 0;
  const date = share.expiresAt
    ? formatLocalized(share.expiresAt, "MMM dd, yyyy h:mm a", "PPp", locale)
    : null;

  const status = date ? (
    <Text size="xs" c={share.expired ? "red" : "dimmed"}>
      {inherited
        ? share.expired
          ? t("Expired on {{date}}, set on {{page}}", {
              date,
              page: share.sharedPage.title || t("untitled"),
            })
          : t("Expires on {{date}}, set on {{page}}", {
              date,
              page: share.sharedPage.title || t("untitled"),
            })
        : share.expired
          ? t("Expired on {{date}}", { date })
          : t("Expires on {{date}}", { date })}
    </Text>
  ) : null;

  // An inherited link is changed on the page that owns it; readers only look.
  if (inherited || readOnly) {
    return status && <div style={{ marginTop: 8 }}>{status}</div>;
  }

  return (
    <div style={{ marginTop: 12 }}>
      <Text size="sm" mb={6}>
        {t("Link expires")}
      </Text>
      <SegmentedControl
        fullWidth
        size="xs"
        value={share.periodDays ? String(share.periodDays) : NEVER}
        disabled={setExpiry.isPending}
        onChange={(value) =>
          setExpiry.mutate(
            value === NEVER ? null : (Number(value) as 1 | 7 | 30),
          )
        }
        data={[
          { value: NEVER, label: t("Never") },
          { value: "1", label: t("1 day") },
          { value: "7", label: t("7 days") },
          { value: "30", label: t("30 days") },
        ]}
      />
      {status && (
        <Group justify="space-between" wrap="nowrap" gap="xs" mt={8}>
          {status}
          <Button
            size="compact-xs"
            variant="light"
            loading={renew.isPending}
            onClick={() => renew.mutate()}
          >
            {t("Renew")}
          </Button>
        </Group>
      )}
    </div>
  );
}
