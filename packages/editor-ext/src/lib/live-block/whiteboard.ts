import {
  createLiveBlockNode,
  type LiveBlockAttributes,
} from './live-block-node';

export type WhiteboardAttributes = LiveBlockAttributes & {
  attachmentId: string | null;
  src: string | null;
  width: number | string | null;
  aspectRatio: number | null;
};

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    whiteboard: {
      setWhiteboard: (attributes?: Partial<WhiteboardAttributes>) => ReturnType;
    };
  }
}

// attachmentId and src hold the preview image, so the existing attachment
// copy and share-token code covers it like any other media node.
export const Whiteboard = createLiveBlockNode({
  name: 'whiteboard',
  kind: 'whiteboard',
  extraAttributes: {
    attachmentId: {
      default: null,
      parseHTML: (element) => element.getAttribute('data-attachment-id'),
      renderHTML: (attributes) => ({
        'data-attachment-id': attributes.attachmentId,
      }),
    },
    src: {
      default: null,
      parseHTML: (element) => element.getAttribute('data-src'),
      renderHTML: (attributes) => ({ 'data-src': attributes.src }),
    },
    width: {
      default: null,
      parseHTML: (element) => element.getAttribute('data-width'),
      renderHTML: (attributes) => ({ 'data-width': attributes.width }),
    },
    aspectRatio: {
      default: null,
      parseHTML: (element) => {
        const num = parseFloat(element.getAttribute('data-aspect-ratio') ?? '');
        return isNaN(num) ? null : num;
      },
      renderHTML: (attributes) => ({
        'data-aspect-ratio': attributes.aspectRatio,
      }),
    },
  },
});
