import { mergeAttributes, Node } from '@tiptap/core';
import type { Attribute } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import type { LiveBlockKind } from '@docmost/live-blocks';
import { defaultNewId, liveBlockOrigin } from './origin';

export type LiveBlockAttributes = {
  blockId: string | null;
  title: string | null;
  height: number | null;
};

export type LiveBlockNodeOptions = {
  HTMLAttributes: Record<string, any>;
  view: any;
  newId: () => string;
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Marks the parts of a block view (its body, its header buttons) that the page editor must ignore. */
export const LIVE_BLOCK_CONTROLS_ATTRIBUTE = 'data-live-block-controls';

// pointer movement stays with the page (its drag handle follows the mouse);
// a drag over a block belongs to the page unless it started inside the block
const PAGE_EVENTS = new Set(['mousemove']);
const DRAG_EVENTS = new Set(['dragenter', 'dragover', 'dragleave', 'drop']);

// the block whose body started the drag in progress, if any
let dragFromBlock: Element | null = null;
if (typeof document !== 'undefined') {
  const end = () => {
    dragFromBlock = null;
  };
  document.addEventListener('dragend', end, true);
  document.addEventListener('drop', () => setTimeout(end, 0), true);
}

function ownsEvent(dom: Element | null, event: Event): boolean {
  const target = event.target as Element | null;
  if (!dom || !target || typeof target.closest !== 'function') return false;
  const area = target.closest(`[${LIVE_BLOCK_CONTROLS_ATTRIBUTE}]`);
  return !!area && dom.contains(area);
}

export function createLiveBlockNode(config: {
  name: 'whiteboard' | 'todoBoard' | 'sheet';
  kind: LiveBlockKind;
  extraAttributes?: Record<string, Attribute>;
}) {
  const { name, kind } = config;
  const command = `set${capitalize(name)}`;

  return Node.create<LiveBlockNodeOptions>({
    name,
    inline: false,
    group: 'block',
    atom: true,
    isolating: true,
    defining: true,
    draggable: true,
    selectable: true,

    addOptions() {
      return { HTMLAttributes: {}, view: null, newId: defaultNewId };
    },

    addStorage() {
      return { kind };
    },

    addAttributes() {
      return {
        blockId: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-block-id'),
          renderHTML: (attributes) => ({
            'data-block-id': attributes.blockId,
          }),
        },
        title: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-title'),
          renderHTML: (attributes) => ({ 'data-title': attributes.title }),
        },
        height: {
          default: null,
          parseHTML: (element) => {
            const num = parseFloat(element.getAttribute('data-height') ?? '');
            return isNaN(num) ? null : num;
          },
          renderHTML: (attributes) => ({ 'data-height': attributes.height }),
        },
        ...(config.extraAttributes ?? {}),
      };
    },

    parseHTML() {
      return [{ tag: `div[data-type="${name}"]` }];
    },

    renderHTML({ HTMLAttributes }) {
      return [
        'div',
        mergeAttributes(
          { 'data-type': name },
          this.options.HTMLAttributes,
          HTMLAttributes,
        ),
      ];
    },

    addCommands() {
      return {
        // the id is set at insertion: two people's views would pick different ids
        [command]:
          (
            attrs: Partial<LiveBlockAttributes> & Record<string, unknown> = {},
          ) =>
          ({ commands, editor }) => {
            const blockId = this.options.newId();
            liveBlockOrigin(editor).created.add(blockId);
            return commands.insertContent({
              type: name,
              attrs: { ...attrs, blockId },
            });
          },
      } as any;
    },

    addNodeView() {
      this.editor.isInitialized = true;
      const render = ReactNodeViewRenderer(this.options.view);
      return (props) => {
        const nodeView: any = render(props);
        const base = nodeView.stopEvent?.bind(nodeView);
        // A click on a control's inner span or icon would otherwise reach
        // ProseMirror, which selects the whole block and takes the keyboard:
        // the next key would replace or delete the block in the page.
        nodeView.stopEvent = (event: Event) => {
          if (PAGE_EVENTS.has(event.type)) return false;
          if (event.type === 'dragstart' && ownsEvent(nodeView.dom, event)) {
            // text dragged within a cell or an item stays inside the block
            dragFromBlock = nodeView.dom;
            return true;
          }
          if (DRAG_EVENTS.has(event.type)) {
            return dragFromBlock !== null && dragFromBlock === nodeView.dom;
          }
          return ownsEvent(nodeView.dom, event) || (base ? base(event) : false);
        };
        return nodeView;
      };
    },
  });
}
