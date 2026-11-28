import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";

// setEditable(…, false) emits no event, but ProseMirror updates the
// contenteditable attribute, so watch that.
export function useEditorEditable(editor: Editor | null | undefined): boolean {
  const [editable, setEditable] = useState(() => Boolean(editor?.isEditable));

  useEffect(() => {
    if (!editor) return;
    const sync = () => setEditable(Boolean(editor.isEditable));
    sync();
    editor.on("transaction", sync);
    editor.on("update", sync);
    let observer: MutationObserver | null = null;
    const dom = editor.view?.dom;
    if (dom && typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(sync);
      observer.observe(dom, {
        attributes: true,
        attributeFilter: ["contenteditable"],
      });
    }
    return () => {
      editor.off("transaction", sync);
      editor.off("update", sync);
      observer?.disconnect();
    };
  }, [editor]);

  return editable;
}
