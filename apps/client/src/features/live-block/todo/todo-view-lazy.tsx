import { Suspense } from "react";
import { lazyWithPrefetch } from "@/lib/lazy-prefetch.ts";
import { NodeViewProps } from "@tiptap/react";

const TodoView = lazyWithPrefetch(
  () => import("@/features/live-block/todo/todo-view.tsx"),
);

export default function TodoViewLazy(props: NodeViewProps) {
  return (
    <Suspense fallback={null}>
      <TodoView {...props} />
    </Suspense>
  );
}
