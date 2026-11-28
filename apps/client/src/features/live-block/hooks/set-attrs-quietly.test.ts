import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import History from "@tiptap/extension-history";
import { Whiteboard } from "@docmost/editor-ext";
import { setAttrsQuietly } from "./set-attrs-quietly";

let editor: Editor;
afterEach(() => editor?.destroy());

describe("setAttrsQuietly", () => {
  it("an automatic attribute write is not undone by the person's Ctrl+Z", () => {
    editor = new Editor({
      extensions: [Document, Paragraph, Text, History, Whiteboard],
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hi" }] },
          { type: "whiteboard", attrs: { blockId: "old-id" } },
        ],
      },
    });
    editor.commands.setTextSelection(3);
    editor.commands.insertContent("!");
    const pos = editor.state.doc.child(0).nodeSize;
    const node = editor.state.doc.nodeAt(pos)!;
    setAttrsQuietly(
      {
        editor,
        getPos: () => pos,
        node,
        updateAttributes: () => undefined,
      } as any,
      { blockId: "new-id", attachmentId: "att-1" },
    );
    expect(editor.state.doc.nodeAt(pos)!.attrs).toMatchObject({
      blockId: "new-id",
      attachmentId: "att-1",
    });
    editor.commands.undo();
    // the person's own typing is undone; the automatic write stays
    expect(editor.getText()).not.toContain("!");
    expect(editor.state.doc.lastChild!.attrs).toMatchObject({
      blockId: "new-id",
      attachmentId: "att-1",
    });
  });
});
