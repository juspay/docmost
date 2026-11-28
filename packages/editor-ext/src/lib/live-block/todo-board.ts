import {
  createLiveBlockNode,
  type LiveBlockAttributes,
} from './live-block-node';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    todoBoard: {
      setTodoBoard: (attributes?: Partial<LiveBlockAttributes>) => ReturnType;
    };
  }
}

export const TodoBoard = createLiveBlockNode({
  name: 'todoBoard',
  kind: 'todo',
});
