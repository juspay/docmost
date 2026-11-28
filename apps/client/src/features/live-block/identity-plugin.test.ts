import { afterEach, describe, expect, it } from "vitest";
import { Editor, Node } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Slice, Fragment } from "@tiptap/pm/model";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  LiveBlockIdentity,
  liveBlockOrigin,
  Sheet,
  TodoBoard,
  TransclusionReference,
  TRANSCLUSION_SOURCE_ALLOWED_NODE_TYPES,
  TransclusionSource,
  Whiteboard,
} from "@docmost/editor-ext";

// stand-ins for the other node types the synced block's content expression names
const otherSyncedBlockNodes = TRANSCLUSION_SOURCE_ALLOWED_NODE_TYPES.filter(
  (name) => name !== "paragraph",
).map((name) =>
  Node.create({ name, group: "block", content: "inline*", atom: false }),
);

const A = "0193c7a0-1111-7abc-8def-00000000000a";

let editors: Editor[] = [];
afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors = [];
});

function makeEditor(content?: any) {
  let n = 0;
  const newId = () => `id-${++n}`;
  const editor = new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      Whiteboard.configure({ newId }),
      TodoBoard.configure({ newId }),
      Sheet.configure({ newId }),
      ...otherSyncedBlockNodes,
      TransclusionSource,
      TransclusionReference,
      LiveBlockIdentity.configure({ newId }),
    ],
    content: content ?? {
      type: "doc",
      content: [
        { type: "whiteboard", attrs: { blockId: A, title: "Plan" } },
        { type: "paragraph", content: [{ type: "text", text: "end" }] },
      ],
    },
  });
  editors.push(editor);
  return editor;
}

const blockIds = (editor: Editor) => {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.attrs.blockId !== undefined) ids.push(node.attrs.blockId);
  });
  return ids;
};

function paste(
  editor: Editor,
  nodes: any[],
  at = editor.state.doc.content.size,
) {
  const fragment = Fragment.fromArray(
    nodes.map((json) => editor.schema.nodeFromJSON(json)),
  );
  let slice = new Slice(fragment, 0, 0);
  // run the paste transform the way ProseMirror does on a real paste
  editor.view.someProp("transformPasted", (f: any) => {
    slice = f(slice, editor.view);
  });
  editor.view.dispatch(
    editor.state.tr.replaceRange(at, at, slice).setMeta("uiEvent", "paste"),
  );
}

const whiteboard = (blockId: string) => ({
  type: "whiteboard",
  attrs: { blockId, title: "Plan" },
});

describe("LiveBlockIdentity", () => {
  it("a pasted copy of a block gets a new id and is recorded in origin.copies", () => {
    const editor = makeEditor();
    paste(editor, [whiteboard(A)]);
    expect(blockIds(editor)).toEqual([A, "id-1"]);
    expect(liveBlockOrigin(editor).copies.get("id-1")).toBe(A);
  });

  it("the first occurrence keeps its id", () => {
    const editor = makeEditor();
    paste(editor, [whiteboard(A)], 0);
    expect(blockIds(editor)[0]).toBe(A);
    expect(blockIds(editor)[1]).toBe("id-1");
  });

  it("three copies get three distinct ids, each recorded with the original as its source", () => {
    const editor = makeEditor();
    paste(editor, [whiteboard(A), whiteboard(A), whiteboard(A)]);
    const ids = blockIds(editor);
    expect(ids).toEqual([A, "id-1", "id-2", "id-3"]);
    const { copies } = liveBlockOrigin(editor);
    for (const id of ids.slice(1)) expect(copies.get(id)).toBe(A);
  });

  it("a cut and paste of a single block keeps its id", () => {
    const editor = makeEditor();
    const node = editor.state.doc.firstChild!;
    editor.view.dispatch(editor.state.tr.delete(0, node.nodeSize));
    expect(blockIds(editor)).toEqual([]);
    paste(editor, [whiteboard(A)]);
    expect(blockIds(editor)).toEqual([A]);
    // marked as pasted here by this person
    expect(liveBlockOrigin(editor).copies.get(A)).toBe(A);
  });

  it("a duplicate that existed before the transaction gets a new id and no copy record", () => {
    const editor = makeEditor();
    // a merge of two people's changes arrives as a remote transaction
    const remote = editor.state.tr
      .insert(
        editor.state.doc.content.size,
        editor.schema.nodeFromJSON(whiteboard(A)),
      )
      .setMeta(ySyncPluginKey, { isChangeOrigin: true });
    editor.view.dispatch(remote);
    expect(blockIds(editor)).toEqual([A, A]);

    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "typing" }],
    });
    expect(blockIds(editor)).toEqual([A, "id-1"]);
    const origin = liveBlockOrigin(editor);
    expect(origin.copies.has("id-1")).toBe(false);
    expect(origin.created.has("id-1")).toBe(true);
  });

  it("remote transactions are left alone", () => {
    const editor = makeEditor();
    const remote = editor.state.tr
      .insert(
        editor.state.doc.content.size,
        editor.schema.nodeFromJSON(whiteboard(A)),
      )
      .setMeta(ySyncPluginKey, { isChangeOrigin: true });
    editor.view.dispatch(remote);
    expect(blockIds(editor)).toEqual([A, A]);
    expect(liveBlockOrigin(editor).created.size).toBe(0);
  });

  it("nothing about copies is written into the document", () => {
    const editor = makeEditor();
    paste(editor, [{ type: "todoBoard", attrs: { blockId: A } }]);
    const json = editor.getJSON();
    for (const node of json.content!) {
      if (node.type === "todoBoard") {
        expect(Object.keys(node.attrs!).sort()).toEqual([
          "blockId",
          "height",
          "title",
        ]);
      }
    }
  });

  it("setWhiteboard inserts a node that already has a blockId", () => {
    const editor = makeEditor({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    editor.commands.setWhiteboard({ title: "New" });
    const ids = blockIds(editor);
    expect(ids).toEqual(["id-1"]);
    expect(liveBlockOrigin(editor).created.has("id-1")).toBe(true);
    editor.commands.setTextSelection(editor.state.doc.content.size);
    editor.commands.setTodoBoard();
    editor.commands.setTextSelection(editor.state.doc.content.size);
    editor.commands.setSheet();
    expect(blockIds(editor)).toHaveLength(3);
    expect(new Set(blockIds(editor)).size).toBe(3);
  });

  it("the schema refuses a live block inside a synced block", () => {
    const editor = makeEditor();
    for (const type of ["whiteboard", "todoBoard", "sheet"]) {
      expect(() =>
        editor.schema
          .nodeFromJSON({
            type: "transclusionSource",
            content: [{ type, attrs: { blockId: A } }],
          })
          .check(),
      ).toThrow();
    }
  });

  it("renders a div with data-type and data-block-id", () => {
    const editor = makeEditor();
    expect(editor.getHTML()).toContain(`data-type="whiteboard"`);
    expect(editor.getHTML()).toContain(`data-block-id="${A}"`);
  });

  it("a pasted copy of a whiteboard gets no share of the source's preview file", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "whiteboard",
          attrs: {
            blockId: A,
            title: "Plan",
            attachmentId: "att-src",
            src: "/api/files/att-src/w.svg",
          },
        },
        { type: "paragraph" },
      ],
    });
    paste(editor, [
      {
        type: "whiteboard",
        attrs: {
          blockId: A,
          title: "Plan",
          attachmentId: "att-src",
          src: "/api/files/att-src/w.svg",
        },
      },
    ]);
    const boards = editor
      .getJSON()
      .content!.filter((n) => n.type === "whiteboard");
    expect(boards[0].attrs).toMatchObject({
      blockId: A,
      attachmentId: "att-src",
    });
    expect(boards[1].attrs).toMatchObject({
      blockId: "id-1",
      attachmentId: null,
      src: null,
      title: "Plan",
    });
  });
});
