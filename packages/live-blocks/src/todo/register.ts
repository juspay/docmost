import { registerKind } from '../registry';
import type { TodoSnapshot } from '../snapshot';
import { createEmptyBoard } from './board';
import { boardToTaskListNodes } from './checklist';
import { validateBoardInput } from './schema';
import { readBoard, seedTodo } from './ydoc';

registerKind<TodoSnapshot>({
  kind: 'todo',
  empty: () => ({
    kind: 'todo',
    board: { ...createEmptyBoard(), columns: [] },
  }),
  build: (doc) => ({ kind: 'todo', board: readBoard(doc) }),
  seed: (doc, snapshot) => seedTodo(doc, snapshot.board),
  validate: validateBoardInput,
  staticNodes: (snapshot, ctx) => {
    const nodes = boardToTaskListNodes(snapshot.board);
    if (nodes.length > 0) return nodes;
    return [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: `To-do board: ${ctx.title}` }],
      },
    ];
  },
});
