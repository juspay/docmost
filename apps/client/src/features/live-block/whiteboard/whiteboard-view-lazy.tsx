import { Suspense } from "react";
import { lazyWithPrefetch } from "@/lib/lazy-prefetch.ts";
import { NodeViewProps } from "@tiptap/react";

const WhiteboardView = lazyWithPrefetch(
  () => import("@/features/live-block/whiteboard/whiteboard-view.tsx"),
);

export default function WhiteboardViewLazy(props: NodeViewProps) {
  return (
    <Suspense fallback={null}>
      <WhiteboardView {...props} />
    </Suspense>
  );
}
