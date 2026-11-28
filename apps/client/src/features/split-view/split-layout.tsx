import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  useLocation,
  useNavigationType,
  useSearchParams,
} from "react-router-dom";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { paneSlugIdOf } from "./pane-location-reporter.tsx";
import { usePaneMessages, useSplitView } from "./use-split-view.ts";
import classes from "./split-layout.module.css";

const KEY_STEP = 0.02;

export function SplitLayout({ children }: { children: ReactNode }) {
  const { splitSlugId, available, close, ratio, setRatio } = useSplitView();
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const [, setSearchParams] = useSearchParams();
  const onPage = paneSlugIdOf(pathname) !== null;

  // Following a link on the left drops ?split from the URL; the pane stays and
  // the parameter is put back, so the split survives navigation on the left.
  // The ref is the source of truth so close() cannot leave a stale flag behind.
  const keptRef = useRef<string | null>(splitSlugId);
  const [kept, setKept] = useState<string | null>(splitSlugId);

  useEffect(() => {
    if (!available) return;
    if (!onPage) {
      keptRef.current = null;
      setKept(null);
      return;
    }
    if (splitSlugId) {
      keptRef.current = splitSlugId;
      setKept(splitSlugId);
    } else if (keptRef.current && navigationType === "POP") {
      // Back or Forward to an entry without ?split: the user left the split
      keptRef.current = null;
      setKept(null);
    } else if (keptRef.current) {
      const slug = keptRef.current;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("split", slug);
          return next;
        },
        { replace: true },
      );
    }
  }, [
    splitSlugId,
    available,
    onPage,
    pathname,
    navigationType,
    setSearchParams,
  ]);

  const active = available && onPage ? (splitSlugId ?? kept) : null;

  const onClose = useCallback(() => {
    keptRef.current = null;
    setKept(null);
    close();
  }, [close]);

  if (!active) return <>{children}</>;

  return (
    <SplitPanes
      slugId={active}
      ratio={ratio}
      setRatio={setRatio}
      onClose={onClose}
    >
      {children}
    </SplitPanes>
  );
}

function SplitPanes({
  slugId,
  ratio,
  setRatio,
  onClose,
  children,
}: {
  slugId: string;
  ratio: number;
  setRatio: (ratio: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [initialSlugId] = useState(slugId);
  const [dragging, setDragging] = useState(false);
  usePaneMessages(frameRef);

  // The address stays fixed after mount: replacing it for every link followed
  // in the pane would reload the pane. A page chosen from outside is loaded
  // into the frame directly, and only when the pane is not already showing it.
  const previous = useRef(slugId);
  useEffect(() => {
    if (previous.current === slugId) return;
    previous.current = slugId;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    try {
      if (paneSlugIdOf(win.location.pathname) === slugId) return;
      win.location.replace(`/p/${slugId}`);
    } catch {
      // not reachable from here: leave the pane where it is
    }
  }, [slugId]);

  const moveTo = (clientX: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setRatio((clientX - box.left) / box.width);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging) moveTo(event.clientX);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") setRatio(ratio - KEY_STEP);
    else if (event.key === "ArrowRight") setRatio(ratio + KEY_STEP);
    else return;
    event.preventDefault();
  };

  return (
    <div ref={containerRef} className={classes.container}>
      <div className={classes.left} style={{ flexBasis: `${ratio * 100}%` }}>
        {children}
      </div>
      <div
        className={classes.divider}
        data-dragging={dragging || undefined}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize split view")}
        aria-valuemin={25}
        aria-valuemax={75}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <Tooltip label={t("Close split view")} position="left" withArrow>
          <ActionIcon
            variant="default"
            size="sm"
            radius="xl"
            className={classes.close}
            aria-label={t("Close split view")}
            onClick={onClose}
          >
            <IconX size={14} />
          </ActionIcon>
        </Tooltip>
      </div>
      <div className={classes.right}>
        <iframe
          ref={frameRef}
          data-docmost-pane="1"
          className={classes.frame}
          data-dragging={dragging || undefined}
          title={t("Split view")}
          src={`/p/${initialSlugId}`}
        />
      </div>
    </div>
  );
}
