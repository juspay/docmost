import { lazy, Suspense } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { Loader } from "@mantine/core";
import { IconChalkboard } from "@tabler/icons-react";
import { LiveBlockFrame } from "../components/live-block-frame";
import WhiteboardReadOnly from "./whiteboard-read-only";

// the Excalidraw bundle loads only when a board is opened
const WhiteboardCanvas = lazy(() => import("./whiteboard-canvas"));

export default function WhiteboardView(props: NodeViewProps) {
  return (
    <LiveBlockFrame
      nodeProps={props}
      kind="whiteboard"
      icon={<IconChalkboard size={18} />}
      liveWhen="opened"
      readOnlyWithoutSnapshot={Boolean(props.node.attrs.src)}
      renderInline={() => null}
      renderOpened={(ctx) => (
        <Suspense fallback={<Loader size="sm" />}>
          <WhiteboardCanvas ctx={ctx} nodeProps={props} />
        </Suspense>
      )}
      renderReadOnly={(snapshot, info) => (
        <WhiteboardReadOnly
          node={props.node}
          snapshot={snapshot}
          updatedAt={info?.updatedAt}
          local={info?.local}
        />
      )}
    />
  );
}
