import type { NodeViewProps } from "@tiptap/react";

/**
 * Writes attributes the app sets on its own (a new id after a conflict, the
 * first preview file) without an entry in the person's undo history:
 * Ctrl+Z must not hand a block back an id that belongs to another page.
 */
export function setAttrsQuietly(
  props: Pick<NodeViewProps, "editor" | "getPos" | "updateAttributes">,
  attrs: Record<string, unknown>,
) {
  const { editor, getPos } = props;
  const pos = typeof getPos === "function" ? getPos() : undefined;
  if (typeof pos !== "number" || !editor?.view) {
    props.updateAttributes(attrs);
    return;
  }
  const current = editor.state.doc.nodeAt(pos);
  if (!current) return;
  editor.view.dispatch(
    editor.state.tr
      .setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs })
      .setMeta("addToHistory", false),
  );
}
