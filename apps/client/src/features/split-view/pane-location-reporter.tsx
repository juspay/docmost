import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { extractPageSlugId } from "@/lib";
import { isPaneMode } from "./pane-mode.ts";
import { postToParent } from "./pane-messages.ts";

const PAGE_PATH = /^\/s\/[^/]+\/p\/([^/]+)\/?$/;

export function paneSlugIdOf(pathname: string): string | null {
  const match = PAGE_PATH.exec(pathname);
  if (!match) return null;
  try {
    return extractPageSlugId(decodeURIComponent(match[1])) ?? null;
  } catch {
    return null;
  }
}

export function PaneLocationReporter() {
  const { pathname, search, hash } = useLocation();

  useEffect(() => {
    if (!isPaneMode()) return;
    const slugId = paneSlugIdOf(pathname);
    if (slugId) {
      postToParent({ type: "docmost:pane-location", pathname, slugId });
    } else {
      // the pane only ever shows pages
      // "//host" is protocol-relative and would leave the site
      if (pathname.startsWith("/") && !pathname.startsWith("//")) {
        window.parent.location.assign(pathname + search + hash);
      }
    }
  }, [pathname, search, hash]);

  return null;
}
