import { useCallback, useEffect, useState, type RefObject } from "react";
import { useLocation, useParams, useSearchParams } from "react-router-dom";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { extractPageSlugId } from "@/lib";
import APP_ROUTE from "@/lib/app-route.ts";
import { isPaneMode } from "./pane-mode.ts";
import {
  isPaneAuthExpiredMessage,
  isPaneLocationMessage,
} from "./pane-messages.ts";

export type { PaneAuthExpiredMessage } from "./pane-messages.ts";

export const SPLIT_SLUG_PATTERN = /^[A-Za-z0-9_-]{6,40}$/;
export const SPLIT_MIN_WIDTH = 1024;

const SPLIT_PARAM = "split";
const RATIO_KEY = "docmost:split-ratio";
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

function readRatio(): number {
  try {
    const stored = localStorage.getItem(RATIO_KEY);
    return stored === null ? 0.5 : clampRatio(Number(stored));
  } catch {
    return 0.5;
  }
}

export function useSplitView() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { pageSlug } = useParams();
  const wide = useMediaQuery(`(min-width: ${SPLIT_MIN_WIDTH}px)`, undefined, {
    getInitialValueInEffect: false,
  });
  const available = wide && !isPaneMode();
  const [ratio, setRatioState] = useState(readRatio);

  const raw = searchParams.get(SPLIT_PARAM);
  const splitSlugId =
    available && raw && SPLIT_SLUG_PATTERN.test(raw) ? raw : null;

  const open = useCallback(
    (slugId: string) => {
      if (!SPLIT_SLUG_PATTERN.test(slugId)) return;
      if (pageSlug && extractPageSlugId(pageSlug) === slugId) {
        notifications.show({ message: t("This page is already open") });
        return;
      }
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(SPLIT_PARAM, slugId);
        return next;
      });
    },
    [pageSlug, setSearchParams, t],
  );

  const close = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(SPLIT_PARAM);
      return next;
    });
  }, [setSearchParams]);

  const setRatio = useCallback((value: number) => {
    const next = clampRatio(value);
    setRatioState(next);
    try {
      localStorage.setItem(RATIO_KEY, String(next));
    } catch {
      // storage can be blocked; the ratio then lasts for this view only
    }
  }, []);

  return { splitSlugId, available, open, close, ratio, setRatio };
}

// The parent's side of the pane protocol: keeps the address bar true when the
// pane follows a link, and leaves for the login page when the pane's session ends.
export function usePaneMessages(frameRef: RefObject<HTMLIFrameElement | null>) {
  const [, setSearchParams] = useSearchParams();
  const location = useLocation();

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (isPaneAuthExpiredMessage(event, frame)) {
        const here = location.pathname + location.search + location.hash;
        const params = new URLSearchParams({ redirect: here });
        window.location.assign(`${APP_ROUTE.AUTH.LOGIN}?${params.toString()}`);
        return;
      }
      if (isPaneLocationMessage(event, frame)) {
        const slugId = event.data.slugId;
        if (!slugId || !SPLIT_SLUG_PATTERN.test(slugId)) return;
        setSearchParams(
          (prev) => {
            if (prev.get(SPLIT_PARAM) === slugId) return prev;
            const next = new URLSearchParams(prev);
            next.set(SPLIT_PARAM, slugId);
            return next;
          },
          { replace: true },
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef, location.pathname, location.search, location.hash, setSearchParams]);
}
