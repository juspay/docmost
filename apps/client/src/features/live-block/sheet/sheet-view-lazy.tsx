import { Suspense } from "react";
import { lazyWithPrefetch } from "@/lib/lazy-prefetch.ts";
import { NodeViewProps } from "@tiptap/react";

const SheetView = lazyWithPrefetch(
  () => import("@/features/live-block/sheet/sheet-view.tsx"),
);

export default function SheetViewLazy(props: NodeViewProps) {
  return (
    <Suspense fallback={null}>
      <SheetView {...props} />
    </Suspense>
  );
}
