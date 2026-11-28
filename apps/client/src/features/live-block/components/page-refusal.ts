import { getPageById } from "@/features/page/services/page-service";
import { discardStoredBlocksOfPage } from "./block-provider-registry";

/** The app server's own Nest error body for this status (not a proxy's page). */
function isAppServerRefusal(err: unknown): boolean {
  const response = (err as { response?: { status?: number; data?: any } })
    ?.response;
  const status = response?.status;
  const data = response?.data;
  if (status !== 403 && status !== 404) return false;
  if (!data || typeof data !== "object") return false;
  if (data.statusCode !== status || typeof data.message !== "string") {
    return false;
  }
  // a workspace that does not resolve is a routing problem, not this page
  return !/workspace not found/i.test(data.message);
}

/**
 * The page editor calls this where it drops its own page cache. The page is
 * asked again here, and the blocks' stored copies for this user go only if
 * the app server itself answers 403 or 404 for it (M1): a bare status from a
 * proxy, a WAF challenge or a misrouted deploy never drops them.
 */
export async function dropBlocksOfRefusedPage(
  pageId: string,
  userId: string | undefined,
): Promise<void> {
  if (!userId) return;
  try {
    await getPageById({ pageId });
    return; // the page answers: nothing to drop
  } catch (err) {
    if (!isAppServerRefusal(err)) return;
  }
  try {
    await discardStoredBlocksOfPage(pageId, userId);
  } catch {
    // local cleanup must never break the page
  }
}
