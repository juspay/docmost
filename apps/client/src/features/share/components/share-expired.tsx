import { Anchor, Skeleton, Stack, Text, Title } from "@mantine/core";
import React, { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthenticatedUser } from "@/features/public-space/hooks/use-authenticated-user.ts";

/** The server answers an expired link with this body and nothing else. */
export function getShareExpired(
  error: unknown,
): { pageSlugId?: string } | null {
  const body = error?.["response"]?.data;
  return body?.code === "SHARE_EXPIRED"
    ? { pageSlugId: body.pageSlugId }
    : null;
}

interface ShareExpiredProps {
  pageSlugId?: string;
}

export default function ShareExpired({ pageSlugId }: ShareExpiredProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading } = useAuthenticatedUser();
  const signedIn = Boolean(data?.user);
  const pagePath = pageSlugId ? `/p/${pageSlugId}` : null;

  // A member who can view the page sees it; anyone else gets the usual
  // not-found screen. The share itself never serves a signed-in visitor.
  useEffect(() => {
    if (signedIn && pagePath) {
      navigate(pagePath, { replace: true });
    }
  }, [signedIn, pagePath, navigate]);

  if (isLoading || (signedIn && pagePath)) {
    return (
      <Stack gap="md" pt={4} aria-hidden>
        <Skeleton height={34} width="55%" radius="sm" mt={10} />
        <Skeleton height={12} width="90%" radius="sm" mt={18} />
        <Skeleton height={12} width="97%" radius="sm" />
        <Skeleton height={12} width="60%" radius="sm" />
      </Stack>
    );
  }

  return (
    <Stack gap="xs" align="center" pt={80}>
      <Title order={2}>{t("This link has expired")}</Title>
      <Text c="dimmed">{t("Sign in to view the page if you have access")}</Text>
      {pagePath && (
        <Anchor component={Link} to={pagePath} size="sm">
          {t("Sign in")}
        </Anchor>
      )}
    </Stack>
  );
}
