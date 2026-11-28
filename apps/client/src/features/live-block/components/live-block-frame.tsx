import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import {
  ActionIcon,
  Avatar,
  Badge,
  Button,
  Loader,
  Menu,
  Modal,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowsMaximize,
  IconCloudOff,
  IconDots,
  IconTrash,
} from "@tabler/icons-react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import type { LiveBlockKind, LiveBlockSnapshot } from "@docmost/live-blocks";
import { useLiveBlock } from "../hooks/use-live-block";
import { useLiveBlockHost } from "../live-block-host";
import { LiveBlockRoom } from "./live-block-room";
import { useInView } from "./use-in-view";
import { retryBlockSave } from "./block-provider-registry";
import { blockDocumentName } from "@docmost/live-blocks";
import { safePeerColor } from "./peer-color";
import {
  useBlockSaveState,
  useLocalBlockSnapshot,
} from "./use-block-save-state";
import type {
  BlockPeer,
  LiveBlockRenderContext,
  LiveBlockRoomContext,
} from "../live-block.types";
import classes from "./live-block-frame.module.css";

const UNMOUNT_AFTER_MS = 30_000;
const BLOCK_PARAM = "block";

type FrameProps = {
  nodeProps: NodeViewProps;
  kind: LiveBlockKind;
  icon: ReactNode;
  liveWhen: "visible" | "opened";
  renderInline: (ctx: LiveBlockRenderContext) => ReactNode;
  renderOpened: (ctx: LiveBlockRenderContext) => ReactNode;
  renderReadOnly: (
    snapshot: LiveBlockSnapshot | undefined,
    info?: { updatedAt?: string; local?: boolean },
  ) => ReactNode;
  /** the read-only view can show something (e.g. a saved preview) without the snapshot */
  readOnlyWithoutSnapshot?: boolean;
};

function PeerStack({ peers }: { peers: BlockPeer[] }) {
  if (peers.length === 0) return null;
  const unique = [...new Map(peers.map((p) => [p.user.id, p])).values()];
  return (
    <Avatar.Group spacing="xs">
      {unique.slice(0, 4).map((peer) => (
        <Tooltip key={peer.user.id} label={peer.user.name} withArrow>
          <Avatar
            size={24}
            radius="xl"
            style={{
              background: safePeerColor(peer.user.color),
              color: "#1a1b1e",
            }}
            name={peer.user.name}
          >
            {peer.user.name?.charAt(0)?.toUpperCase()}
          </Avatar>
        </Tooltip>
      ))}
      {unique.length > 4 && (
        <Avatar size={24} radius="xl">
          +{unique.length - 4}
        </Avatar>
      )}
    </Avatar.Group>
  );
}

export function LiveBlockFrame({
  nodeProps,
  kind,
  icon,
  liveWhen,
  renderInline,
  renderOpened,
  renderReadOnly,
  readOnlyWithoutSnapshot = false,
}: FrameProps) {
  const { t } = useTranslation();
  const { node, updateAttributes, deleteNode, selected } = nodeProps;
  const frameRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inView = useInView(frameRef, UNMOUNT_AFTER_MS);
  const [searchParams, setSearchParams] = useSearchParams();
  const blockIdAttr: string | null = node.attrs.blockId ?? null;
  const opened =
    Boolean(blockIdAttr) && searchParams.get(BLOCK_PARAM) === blockIdAttr;

  const saveState = useBlockSaveState(blockIdAttr);
  // the stored view is behind while edits are unsaved, or cannot be fetched offline
  const useLocal = saveState.unsaved || saveState.offline;

  const host = useLiveBlockHost();
  const block = useLiveBlock(
    nodeProps,
    kind,
    inView || opened,
    liveWhen === "opened" && !opened,
  );
  const liveLocal = useLocalBlockSnapshot(blockIdAttr, kind, useLocal);
  // after the edits are saved the server stores them a little later: keep the
  // last local view until the stored copy is newer than the save
  const kept = useRef<{ snapshot: LiveBlockSnapshot; savedAt: number } | null>(
    null,
  );
  if (liveLocal) kept.current = { snapshot: liveLocal, savedAt: Date.now() };
  const storedAt = Date.parse(block.snapshotUpdatedAt ?? "") || 0;
  if (!liveLocal && kept.current && storedAt > kept.current.savedAt) {
    kept.current = null;
  }
  const localSnapshot = liveLocal ?? kept.current?.snapshot ?? null;
  const { status, blockId, pageId } = block;
  const editable = status === "ready";

  const [title, setTitle] = useState<string>(node.attrs.title ?? "");
  const [titleFocused, setTitleFocused] = useState(false);
  // a rename by someone else waits until this person stops typing
  useEffect(() => {
    if (!titleFocused) setTitle(node.attrs.title ?? "");
  }, [node.attrs.title, titleFocused]);
  const commitTitle = useCallback(() => {
    const next = title.trim() || null;
    if (next !== (node.attrs.title ?? null)) updateAttributes({ title: next });
  }, [title, node.attrs.title, updateAttributes]);

  // once edits made offline are saved, the stored view (snapshot, preview) is
  // current again; an ordinary save or a reconnect with nothing pending is not
  const offlineEdits = useRef(false);
  const retryBlock = block.retry;
  useEffect(() => {
    if (saveState.offline && saveState.dirty) offlineEdits.current = true;
    if (offlineEdits.current && !saveState.unsaved && !saveState.dirty) {
      offlineEdits.current = false;
      if (block.snapshotState !== "idle") retryBlock();
    }
  }, [
    saveState.offline,
    saveState.dirty,
    saveState.unsaved,
    retryBlock,
    block.snapshotState,
  ]);

  const wasOpened = useRef(opened);
  useEffect(() => {
    if (wasOpened.current && !opened) {
      bodyRef.current?.focus({ preventScroll: true });
    }
    wasOpened.current = opened;
  }, [opened]);

  // a page loaded with ?block=<id> scrolls to that block
  useEffect(() => {
    if (opened) frameRef.current?.scrollIntoView?.({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = () =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(BLOCK_PARAM, blockId);
      return next;
    });
  const close = () =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(BLOCK_PARAM);
      return next;
    });

  const [peers, setPeersState] = useState<BlockPeer[]>([]);
  const setPeers = useCallback((next: BlockPeer[]) => {
    const key = (list: BlockPeer[]) =>
      list
        .map((p) => `${p.clientId}:${p.user.id}:${p.user.name}:${p.user.color}`)
        .join("|");
    setPeersState((prev) => (key(prev) === key(next) ? prev : next));
  }, []);
  const renderWithRoom = (
    render: (ctx: LiveBlockRenderContext) => ReactNode,
    isOpened: boolean,
  ) => (
    <LiveBlockRoom blockId={blockId} canEdit={editable}>
      {(room: LiveBlockRoomContext) => (
        <PeersReporter peers={room.peers} onChange={setPeers}>
          {render({ ...room, blockId, pageId, opened: isOpened })}
        </PeersReporter>
      )}
    </LiveBlockRoom>
  );

  const message = (text: string, action?: ReactNode) => (
    <div className={classes.message}>
      <Text size="sm" c="dimmed">
        {text}
      </Text>
      {action}
    </div>
  );

  const replaceButton = nodeProps.editor.isEditable ? (
    <Button size="xs" variant="default" onClick={block.replaceWithEmpty}>
      {t("Replace with an empty block")}
    </Button>
  ) : null;

  const renderSnapshot = () => {
    // edits kept in this tab, the server out of reach: show them, not an error
    if (localSnapshot) {
      return renderReadOnly(localSnapshot, { local: true });
    }
    if (readOnlyWithoutSnapshot && block.snapshotState !== "not-on-page") {
      return renderReadOnly(block.snapshot, {
        updatedAt: block.snapshotUpdatedAt,
      });
    }
    switch (block.snapshotState) {
      case "ready":
        return renderReadOnly(block.snapshot, {
          updatedAt: block.snapshotUpdatedAt,
        });
      case "not-ready":
        return message(t("Not ready yet"));
      case "not-on-page":
        return message(t("This block is not on the current page"));
      case "error":
        if (saveState.offline || saveState.unsaved) {
          return message(
            t(
              "You're offline. Your changes are kept on this device and will be saved when the connection is back.",
            ),
          );
        }
        return message(
          t("This block could not be loaded"),
          <Button size="xs" variant="default" onClick={block.retry}>
            {t("Retry")}
          </Button>,
        );
      default:
        return (
          <div className={classes.message}>
            <Loader size="sm" />
          </div>
        );
    }
  };

  let body: ReactNode;
  switch (status) {
    case "unavailable":
      body = message(t("Live blocks are not available here"));
      break;
    case "read-only":
      body = renderSnapshot();
      break;
    case "foreign":
      body = message(t("This block belongs to another page"), replaceButton);
      break;
    case "no-access":
      body = message(
        t("You do not have access to the original"),
        replaceButton,
      );
      break;
    case "error":
      body = message(
        t("Something went wrong with this block"),
        <Button size="xs" variant="default" onClick={block.retry}>
          {t("Retry")}
        </Button>,
      );
      break;
    case "ready":
      if (liveWhen === "visible") {
        body =
          inView || opened
            ? renderWithRoom(renderInline, false)
            : renderSnapshot();
      } else {
        body = renderSnapshot();
      }
      break;
    default:
      body = (
        <div className={classes.message}>
          <Loader size="sm" />
        </div>
      );
  }

  return (
    <NodeViewWrapper data-drag-handle>
      <div
        ref={frameRef}
        className={clsx(classes.frame, selected && classes.frameSelected)}
        data-live-block={kind}
        data-block-id={blockId ?? undefined}
        data-status={status}
        contentEditable={false}
      >
        <div className={classes.header}>
          <span className={classes.icon}>{icon}</span>
          <div className={classes.title}>
            {editable ? (
              <TextInput
                variant="unstyled"
                size="sm"
                className={classes.titleInput}
                aria-label={t("Title")}
                placeholder={t("Untitled")}
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                onFocus={() => setTitleFocused(true)}
                onBlur={() => {
                  commitTitle();
                  setTitleFocused(false);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            ) : (
              <Text fw={600} size="sm" truncate>
                {node.attrs.title || t("Untitled")}
              </Text>
            )}
          </div>
          <div
            className={classes.headerControls}
            data-live-block-header-controls=""
            data-live-block-controls=""
          >
            {host.mode === "history" && (
              <Tooltip
                label={t(
                  "Live blocks are not versioned: this is their content today, not at this version",
                )}
                withArrow
              >
                <Badge size="sm" variant="light" color="gray">
                  {t("Current content")}
                </Badge>
              </Tooltip>
            )}
            {saveState.unsaved && (
              <Tooltip
                label={
                  saveState.authFailed
                    ? t("Reconnecting to save your changes")
                    : saveState.storedLocally
                      ? t(
                          "Your changes are kept on this device and will be saved when the connection is back",
                        )
                      : t(
                          "Your changes will be saved when the connection is back. Keep this tab open until then.",
                        )
                }
                withArrow
              >
                <Text
                  size="xs"
                  c="orange"
                  className={classes.unsaved}
                  role="status"
                  data-testid="block-unsaved"
                >
                  <IconCloudOff size={14} />
                  {t("Not saved yet")}
                </Text>
              </Tooltip>
            )}
            {saveState.keptOnDevice && !saveState.lost && (
              <Tooltip
                label={t(
                  "You cannot edit this block right now, so your last changes were not sent. They are kept on this device and will be saved if you can edit it again.",
                )}
                withArrow
                multiline
                w={280}
              >
                <Text
                  size="xs"
                  c="orange"
                  className={classes.unsaved}
                  role="status"
                  data-testid="block-kept"
                >
                  <IconCloudOff size={14} />
                  {t("Not saved, kept on this device")}
                </Text>
              </Tooltip>
            )}
            {saveState.lost && !saveState.unsaved && (
              <Tooltip
                label={t(
                  "The server refused your last changes to this block, so they were not saved and will not be retried",
                )}
                withArrow
              >
                <Text
                  size="xs"
                  c="red"
                  className={classes.unsaved}
                  role="status"
                  data-testid="block-lost"
                >
                  <IconCloudOff size={14} />
                  {t("Changes not saved")}
                </Text>
              </Tooltip>
            )}
            <PeerStack peers={peers} />
            {editable && (
              <Tooltip label={t("Open")} withArrow>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={t("Open")}
                  onClick={open}
                >
                  <IconArrowsMaximize size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            {nodeProps.editor.isEditable && (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={t("More")}
                  >
                    <IconDots size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    color="red"
                    leftSection={<IconTrash size={16} />}
                    onClick={() => deleteNode()}
                  >
                    {t("Delete")}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            )}
          </div>
        </div>
        {saveState.notSaving && blockIdAttr && (
          <div className={classes.notSaving} role="alert">
            <Text size="sm" c="red">
              {t("Changes to this block are not being saved")}
            </Text>
            <Button
              size="xs"
              variant="default"
              onClick={() => retryBlockSave(blockDocumentName(blockIdAttr))}
            >
              {t("Try again")}
            </Button>
          </div>
        )}
        {/* the kind's own controls: the page editor ignores events here */}
        <div
          ref={bodyRef}
          className={classes.body}
          data-live-block-body=""
          data-live-block-controls=""
          tabIndex={-1}
        >
          {body}
        </div>
      </div>

      <Modal
        opened={opened && editable}
        onClose={close}
        fullScreen
        // Escape belongs to the board (cancel a tool, clear a selection)
        closeOnEscape={false}
        title={node.attrs.title || t("Untitled")}
        transitionProps={{ duration: 0 }}
        keepMounted={false}
        // focus goes back to the block, not to the page editor with the block selected
        returnFocus={false}
      >
        {opened && editable && (
          <div className={classes.openedBody}>
            {renderWithRoom(renderOpened, true)}
          </div>
        )}
      </Modal>
    </NodeViewWrapper>
  );
}

function PeersReporter({
  peers,
  onChange,
  children,
}: {
  peers: BlockPeer[];
  onChange: (peers: BlockPeer[]) => void;
  children: ReactNode;
}) {
  useEffect(() => {
    onChange(peers);
    return () => onChange([]);
  }, [peers, onChange]);
  return <>{children}</>;
}
