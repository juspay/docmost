import {
  createLiveBlockNode,
  type LiveBlockAttributes,
} from './live-block-node';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    sheet: {
      setSheet: (attributes?: Partial<LiveBlockAttributes>) => ReturnType;
    };
  }
}

export const Sheet = createLiveBlockNode({ name: 'sheet', kind: 'sheet' });
