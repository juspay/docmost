import { UserProvider } from "@/features/user/user-provider.tsx";
import { Outlet, useLocation, useParams } from "react-router-dom";
import GlobalAppShell from "@/components/layouts/global/global-app-shell.tsx";
import { PosthogUser } from "@/ee/components/posthog-user.tsx";
import { isCloud } from "@/lib/config.ts";
import { SearchSpotlight } from "@/features/search/components/search-spotlight.tsx";
import React from "react";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { AppErrorBoundary } from "@/components/ui/app-error-boundary.tsx";
import { PageLoading } from "@/pages/page/page-loading";
import { isPaneMode } from "@/features/split-view/pane-mode.ts";
import {
  PaneLocationReporter,
  paneSlugIdOf,
} from "@/features/split-view/pane-location-reporter.tsx";

export default function Layout() {
  const { spaceSlug, pageSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);
  const { pathname } = useLocation();

  // A split-view pane shows only the routed page: no sidebar, header or aside.
  // A route that is not a page renders nothing; the reporter hands it to the parent.
  if (isPaneMode()) {
    return (
      <UserProvider pending={pageSlug ? <PageLoading /> : null}>
        <PaneLocationReporter />
        {paneSlugIdOf(pathname) && (
          <AppErrorBoundary>
            <React.Suspense fallback={null}>
              <Outlet />
            </React.Suspense>
          </AppErrorBoundary>
        )}
      </UserProvider>
    );
  }

  return (
    <UserProvider
      pending={
        <GlobalAppShell sessionPending>
          {pageSlug && <PageLoading />}
        </GlobalAppShell>
      }
    >
      <GlobalAppShell>
        <AppErrorBoundary>
          <React.Suspense fallback={null}>
            <Outlet />
          </React.Suspense>
        </AppErrorBoundary>
      </GlobalAppShell>
      {isCloud() && <PosthogUser />}
      <SearchSpotlight spaceId={space?.id} />
    </UserProvider>
  );
}
