import type { NodeViewProps } from "@tiptap/react";
import { IconLayoutKanban } from "@tabler/icons-react";
import { LiveBlockFrame } from "../components/live-block-frame";
import TodoCanvas from "./todo-canvas";
import TodoReadOnly from "./todo-read-only";

export default function TodoView(props: NodeViewProps) {
  const height: number | undefined = props.node.attrs.height ?? undefined;
  return (
    <LiveBlockFrame
      nodeProps={props}
      kind="todo"
      icon={<IconLayoutKanban size={18} />}
      liveWhen="visible"
      renderInline={(ctx) => <TodoCanvas ctx={ctx} height={height} />}
      renderOpened={(ctx) => <TodoCanvas ctx={ctx} />}
      renderReadOnly={(snapshot) => <TodoReadOnly snapshot={snapshot} />}
    />
  );
}
