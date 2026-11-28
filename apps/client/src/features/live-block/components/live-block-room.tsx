import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import {
  HocuspocusContext,
  HocuspocusRoomContext,
} from "@hocuspocus/provider-react";
import { blockDocumentName } from "@docmost/live-blocks";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { useCollabToken } from "@/features/auth/queries/auth-query.tsx";
import {
  acquireCollabSocket,
  getCollabSocket,
  PageCollabSocket,
  releaseCollabSocket,
} from "@/features/editor/collab-socket";
import { randomElement, userColors } from "@/features/editor/extensions/utils";
import type { BlockPeer, LiveBlockRoomContext } from "../live-block.types";
import {
  acquireBlockProvider,
  runFlushes,
  type BlockProviderEntry,
} from "./block-provider-registry";
import { useBlockSaveState } from "./use-block-save-state";
import { useLiveBlockHost } from "../live-block-host";

type RoomProps = {
  blockId: string;
  canEdit: boolean;
  children: (ctx: LiveBlockRoomContext) => ReactNode;
};

function readPeers(provider: HocuspocusProvider): BlockPeer[] {
  const awareness = provider.awareness;
  if (!awareness) return [];
  const peers: BlockPeer[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const user = state?.user;
    if (user && typeof user.id === "string") {
      peers.push({
        clientId,
        user: {
          id: user.id,
          name: String(user.name ?? ""),
          color: String(user.color ?? ""),
        },
      });
    }
  });
  return peers;
}

/**
 * A block document's room on the page's own socket. Mounted only while the
 * block should be live. Views of one block share a provider from the
 * registry, which outlives unmount until pending writes are sent, so this
 * does not use HocuspocusRoom.
 */
export function LiveBlockRoom({ blockId, canEdit, children }: RoomProps) {
  const socketContext = useContext(HocuspocusContext);
  const { data: session } = useCurrentUser();
  const user = session?.user;
  const { data: collab, refetch } = useCollabToken(user);
  const token = collab?.token;
  if (!socketContext?.websocketProvider || !user || !token) return null;
  return (
    <RoomWithProvider
      refetchToken={refetch}
      key={blockId}
      blockId={blockId}
      canEdit={canEdit}
      token={token}
      user={user}
      websocketProvider={socketContext.websocketProvider}
    >
      {children}
    </RoomWithProvider>
  );
}

function RoomWithProvider({
  blockId,
  canEdit,
  token,
  user,
  websocketProvider,
  refetchToken,
  children,
}: RoomProps & {
  refetchToken: () => Promise<{
    data?: { token?: string };
    isError?: boolean;
    error?: unknown;
  }>;
  token: string;
  user: { id: string; name: string };
  websocketProvider: any;
}) {
  const host = useLiveBlockHost();
  const hostPageId = host.mode === "page" ? host.pageId : null;
  const [entry, setEntry] = useState<BlockProviderEntry | null>(null);
  const saveState = useBlockSaveState(blockId);
  const [synced, setSynced] = useState(false);
  const [serverReadOnly, setServerReadOnly] = useState(false);
  const [peers, setPeers] = useState<BlockPeer[]>([]);
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const userRef = useRef(user);
  userRef.current = user;
  const refetchRef = useRef(refetchToken);
  refetchRef.current = refetchToken;

  useLayoutEffect(() => {
    const socket: PageCollabSocket =
      websocketProvider instanceof PageCollabSocket
        ? websocketProvider
        : getCollabSocket();
    const handle = acquireBlockProvider({
      socket,
      name: blockDocumentName(blockId),
      token: tokenRef.current,
      canEdit: () => canEditRef.current,
      // an editor's edits are also kept on this device, under this user
      userId: userRef.current.id,
      pageId: host.mode === "page" ? host.pageId : undefined,
      refreshToken: async () => {
        // a failed refetch resolves with the old data: never send that again
        const result = await refetchRef.current();
        if (result.isError || result.error) {
          const status = (result.error as any)?.response?.status;
          throw Object.assign(new Error("token refresh failed"), {
            signedOut: status === 401,
          });
        }
        // the api client answers a 401 from the token endpoint with nothing
        // at all instead of an error: that is a sign-out
        if (!result.data?.token) {
          throw Object.assign(new Error("signed out"), { signedOut: true });
        }
        return result.data.token;
      },
      // a provider holding unsaved edits must outlive the page that opened it
      retainSocket:
        socket === getCollabSocket()
          ? () => {
              acquireCollabSocket();
              return releaseCollabSocket;
            }
          : undefined,
      onCreate: (provider) =>
        provider.setAwarenessField("user", {
          id: userRef.current.id,
          name: userRef.current.name,
          color: randomElement(userColors) as string,
        }),
    });
    // views get the document only once the device copy is loaded (or given
    // up), so no edit is made before the cache records drafts
    let current = true;
    if (!handle.entry.storage) setEntry(handle.entry);
    else
      void handle.entry.ready.then(() => {
        if (current) setEntry(handle.entry);
      });
    return () => {
      current = false;
      setEntry(null);
      handle.release();
    };
  }, [blockId, websocketProvider, user.id, hostPageId]);

  // a refreshed token is used at once if the provider is not authenticated
  useEffect(() => {
    if (!entry) return;
    const { provider } = entry;
    if (provider.configuration.token === token) return;
    provider.configuration.token = token;
    if (!provider.isAuthenticated && provider.isAttached) {
      void provider.sendToken().then(() => provider.startSync());
    }
  }, [entry, token]);

  useEffect(() => {
    if (!entry) return;
    const onPageHide = () => {
      runFlushes(entry);
      entry.provider.flushPendingUpdates?.();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [entry]);

  useEffect(() => {
    if (!entry) return;
    const { provider } = entry;
    const onSynced = ({ state }: { state: boolean }) => setSynced(state);
    // the provider announces only a gained sync; a dropped socket loses it
    const onClose = () => setSynced(false);
    const onAuthenticated = ({ scope }: { scope: string }) =>
      setServerReadOnly(scope === "readonly");
    const onAwareness = () => setPeers(readPeers(provider));
    provider.on("synced", onSynced);
    provider.on("close", onClose);
    provider.on("authenticated", onAuthenticated);
    provider.awareness?.on("change", onAwareness);
    setSynced(provider.isSynced);
    // a view joining a shared provider has missed its "authenticated" event
    setServerReadOnly(provider.authorizedScope === "readonly");
    onAwareness();
    return () => {
      provider.off("synced", onSynced);
      provider.off("close", onClose);
      provider.off("authenticated", onAuthenticated);
      provider.awareness?.off("change", onAwareness);
    };
  }, [entry]);

  const registerFlush = useCallback(
    (fn: () => void) => {
      entry?.flushes.add(fn);
      return () => {
        entry?.flushes.delete(fn);
      };
    },
    [entry],
  );

  const roomContext = useMemo(
    () => (entry ? { provider: entry.provider } : null),
    [entry],
  );
  if (!entry) return null;

  const ctx: LiveBlockRoomContext = {
    doc: entry.doc,
    provider: entry.provider,
    synced,
    // refused or downgraded: nothing typed now could be saved
    readOnly: !canEdit || serverReadOnly || saveState.noAccess,
    peers,
    registerFlush,
    keepAlive: entry.keepAlive,
  };

  return (
    <HocuspocusRoomContext.Provider value={roomContext as any}>
      {children(ctx)}
    </HocuspocusRoomContext.Provider>
  );
}
