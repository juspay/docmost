import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import type { NodeViewProps } from "@tiptap/react";
import { Loader } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { IconTable } from "@tabler/icons-react";
import { sheet as S, type SheetSnapshot } from "@docmost/live-blocks";
import { LiveBlockFrame } from "../components/live-block-frame";
import type { LiveBlockRenderContext } from "../live-block.types";
import SheetReadOnly from "./sheet-read-only";
import { SheetWorkspace } from "./sheet-workspace";
import { useWindowDrag } from "./use-window-drag";
import classes from "./sheet.module.css";

export const DEFAULT_SHEET_HEIGHT = 360;
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 1200;
const SEED_ORIGIN = Symbol("sheet-seed");

function seedIfEmpty(ctx: LiveBlockRenderContext) {
  if (!ctx.synced || ctx.readOnly || S.tabIds(ctx.doc).length > 0) return;
  const book = S.createEmptyBook();
  // a fixed first tab id: two people (or the server) starting a new sheet at
  // once end up with one tab, not two
  book.sheets[0].id = S.FIRST_TAB_ID;
  book.activeSheetId = S.FIRST_TAB_ID;
  ctx.doc.transact(() => S.seedSheet(ctx.doc, book), SEED_ORIGIN);
}

export function SheetLive({
  ctx,
  nodeProps,
  mode,
}: {
  ctx: LiveBlockRenderContext;
  nodeProps: NodeViewProps;
  mode: "inline" | "opened";
}) {
  useEffect(() => seedIfEmpty(ctx), [ctx.synced, ctx.readOnly, ctx.doc]);
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const openedHere = searchParams.get("block") === ctx.blockId;
  const [height, setHeight] = useState<number>(
    nodeProps.node.attrs.height ?? DEFAULT_SHEET_HEIGHT,
  );
  useEffect(() => {
    setHeight(nodeProps.node.attrs.height ?? DEFAULT_SHEET_HEIGHT);
  }, [nodeProps.node.attrs.height]);
  const drag = useWindowDrag();
  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = height;
      let next = startH;
      drag(
        (ev) => {
          next = Math.min(
            MAX_HEIGHT,
            Math.max(MIN_HEIGHT, startH + ev.clientY - startY),
          );
          setHeight(next);
        },
        (commit) => {
          if (!commit) setHeight(startH);
          else if (next !== startH)
            nodeProps.updateAttributes({ height: Math.round(next) });
        },
      );
    },
    [height, nodeProps, drag],
  );

  if (!ctx.synced && S.tabIds(ctx.doc).length === 0) {
    return (
      <div className={classes.empty}>
        <Loader size="sm" />
      </div>
    );
  }

  // While the full window is open, the inline view steps aside: one undo
  // history and one cursor per person.
  if (mode === "inline" && openedHere) {
    return <div className={classes.empty}>{t("Open in the full window")}</div>;
  }

  if (mode === "opened") {
    return (
      <div className={classes.fill}>
        <SheetWorkspace
          doc={ctx.doc}
          provider={ctx.provider}
          readOnly={ctx.readOnly}
          registerFlush={ctx.registerFlush}
        />
      </div>
    );
  }
  return (
    <div className={classes.inline}>
      <SheetWorkspace
        doc={ctx.doc}
        provider={ctx.provider}
        readOnly={ctx.readOnly}
        registerFlush={ctx.registerFlush}
        style={{ height }}
      />
      {nodeProps.editor.isEditable && (
        <div
          className={classes.resizeHandle}
          onPointerDown={startResize}
          aria-hidden
        />
      )}
    </div>
  );
}

export default function SheetView(props: NodeViewProps) {
  return (
    <LiveBlockFrame
      nodeProps={props}
      kind="sheet"
      icon={<IconTable size={18} />}
      liveWhen="visible"
      renderInline={(ctx) => (
        <SheetLive ctx={ctx} nodeProps={props} mode="inline" />
      )}
      renderOpened={(ctx) => (
        <SheetLive ctx={ctx} nodeProps={props} mode="opened" />
      )}
      renderReadOnly={(snapshot) => (
        <SheetReadOnly
          snapshot={snapshot as SheetSnapshot}
          height={props.node.attrs.height ?? DEFAULT_SHEET_HEIGHT}
        />
      )}
    />
  );
}
