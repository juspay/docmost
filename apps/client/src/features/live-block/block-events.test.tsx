import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import History from "@tiptap/extension-history";
import {
  EditorContent,
  NodeViewWrapper,
  useEditor,
  type Editor,
} from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { Sheet, TodoBoard, Whiteboard } from "@docmost/editor-ext";

// Stands in for the frame: a header that selects and drags the block, and a
// body holding the kind's controls (todo toolbar, sheet "Add sheet" and find bar).
function FakeFrame() {
  return (
    <NodeViewWrapper data-drag-handle>
      <div data-testid="header">Title</div>
      <div data-live-block-controls="" data-testid="body" tabIndex={-1}>
        <button type="button">
          <span data-testid="control-label">Card</span>
        </button>
      </div>
    </NodeViewWrapper>
  );
}

const kinds = [
  ["whiteboard", Whiteboard],
  ["todoBoard", TodoBoard],
  ["sheet", Sheet],
] as const;

let editor: Editor | null = null;
function Harness({ type, node }: { type: string; node: any }) {
  editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      History,
      node.configure({ view: FakeFrame }),
    ],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Page text" }] },
        { type, attrs: { blockId: "0193c7a0-1111-7abc-8def-00000000000a" } },
      ],
    },
  });
  return <EditorContent editor={editor} />;
}

afterEach(() => {
  cleanup();
  editor = null;
});

describe.each(kinds)("block controls of a %s", (type, node) => {
  it("the page editor ignores clicks, keys and drags on the block's controls", async () => {
    const view = render(<Harness type={type} node={node} />);
    await act(async () => undefined);
    const nodeView = (editor!.view as any).docView.children[1].spec;
    const label = view.getByTestId("control-label");
    for (const kind of [
      "mousedown",
      "mouseup",
      "click",
      "keydown",
      "keyup",
      "copy",
      "paste",
    ]) {
      const ev = new Event(kind, { bubbles: true });
      Object.defineProperty(ev, "target", { value: label });
      // a click on a button's inner span would otherwise select the whole block
      // and hand the keyboard to the page editor
      expect([kind, nodeView.stopEvent(ev)]).toEqual([kind, true]);
    }
  });

  it("Ctrl+Z inside the block (where focus returns after the full window closes) does not undo a page edit", async () => {
    const view = render(<Harness type={type} node={node} />);
    await act(async () => undefined);
    act(() => {
      editor!.commands.setTextSelection(10);
      editor!.commands.insertContent(" edited");
    });
    expect(editor!.getText()).toContain("Page text edited");
    const body = view.getByTestId("body");
    act(() => body.focus());
    act(() => {
      body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(editor!.getText()).toContain("Page text edited");
  });

  const fire = (nodeView: any, kind: string, target: Element) => {
    const ev = new Event(kind, { bubbles: true });
    Object.defineProperty(ev, "target", { value: target });
    return nodeView.stopEvent(ev);
  };

  it("a text drag that starts inside the block stays with the block", async () => {
    const view = render(<Harness type={type} node={node} />);
    await act(async () => undefined);
    const nodeView = (editor!.view as any).docView.children[1].spec;
    const label = view.getByTestId("control-label");
    expect(fire(nodeView, "dragstart", label)).toBe(true);
    for (const kind of ["dragenter", "dragover", "drop"]) {
      expect([kind, fire(nodeView, kind, label)]).toEqual([kind, true]);
    }
    act(() => {
      label.dispatchEvent(new Event("dragend", { bubbles: true }));
    });
    // and the page text is untouched by a real drop of that text
    const before = editor!.getText();
    act(() => {
      const ev = new Event("drop", { bubbles: true, cancelable: true }) as any;
      ev.dataTransfer = {
        getData: (t: string) => (t === "text/plain" ? "dragged" : ""),
        types: ["text/plain"],
        files: [],
      };
      fire(nodeView, "dragstart", label);
      label.dispatchEvent(ev);
    });
    expect(editor!.getText()).toBe(before);
  });

  it("a drag that starts outside the block reaches the page editor over it", async () => {
    const view = render(<Harness type={type} node={node} />);
    await act(async () => undefined);
    const nodeView = (editor!.view as any).docView.children[1].spec;
    const label = view.getByTestId("control-label");
    for (const kind of ["mousemove", "dragenter", "dragover", "drop"]) {
      expect([kind, fire(nodeView, kind, label)]).toEqual([kind, false]);
    }
  });

  it("the header still belongs to the page editor (select and drag the block)", async () => {
    const view = render(<Harness type={type} node={node} />);
    await act(async () => undefined);
    const nodeView = (editor!.view as any).docView.children[1].spec;
    const ev = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(ev, "target", { value: view.getByTestId("header") });
    expect(nodeView.stopEvent(ev)).toBe(false);
  });
});
