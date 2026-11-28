import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { Editor } from "@tiptap/core";

/** Where a block finds out which page it is on. */
export type LiveBlockHost =
  | { mode: "page"; pageId: string }
  | { mode: "share"; pageId: string; shareId?: string }
  | { mode: "history"; pageId: string }
  | { mode: "none" };

const NONE: LiveBlockHost = { mode: "none" };
const LiveBlockHostContext = createContext<LiveBlockHost>(NONE);

export function LiveBlockHostProvider(props: {
  host: LiveBlockHost;
  children: ReactNode;
}) {
  const { host } = props;
  const value = useMemo(
    () => host,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      host.mode,
      "pageId" in host ? host.pageId : null,
      "shareId" in host ? host.shareId : null,
    ],
  );
  return (
    <LiveBlockHostContext.Provider value={value}>
      {/* lets editor code outside React (the slash menu) see the host mode */}
      <div data-live-block-host={value.mode} style={{ display: "contents" }}>
        {props.children}
      </div>
    </LiveBlockHostContext.Provider>
  );
}

/**
 * The host for a synced block's content shown on another page. The server
 * answers for a block only on its own page, so it is asked as the source page;
 * a share or history view cannot reach that page.
 */
export function nestedHostFor(
  host: LiveBlockHost,
  sourcePageId: string | null,
): LiveBlockHost {
  return host.mode === "page" && sourcePageId
    ? { mode: "page", pageId: sourcePageId }
    : { mode: "none" };
}

export function useLiveBlockHost(): LiveBlockHost {
  return useContext(LiveBlockHostContext);
}

export function liveBlockHostModeOf(editor: Editor): LiveBlockHost["mode"] {
  const dom = editor?.view?.dom as HTMLElement | undefined;
  const mode = dom
    ?.closest?.("[data-live-block-host]")
    ?.getAttribute("data-live-block-host");
  return (mode as LiveBlockHost["mode"]) ?? "none";
}
