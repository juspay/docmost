import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  buildSnapshot,
  emptySnapshot,
  LiveBlockInputError,
  renderStaticNodes,
  seedYdoc,
  validateSnapshotInput,
} from '../index';
import { MAX_TODO_DEPTH } from './schema';

describe('to-do kind', () => {
  it('a new board has no cards, so nothing shows before the first store', () => {
    const snapshot = emptySnapshot('todo') as any;
    expect(snapshot.board.columns).toEqual([]);
    expect(snapshot.board.view).toEqual({ sort: 'manual', hideDone: false });
  });

  it('accepts an empty board as input, keeping its view', () => {
    const out = validateSnapshotInput('todo', {
      columns: [],
      view: { sort: 'time', hideDone: true },
    }) as any;
    expect(out.board.columns).toEqual([]);
    expect(out.board.view).toEqual({ sort: 'time', hideDone: true });
  });

  it('seeds a document from a snapshot and builds the same snapshot back', () => {
    const empty = emptySnapshot('todo');
    const doc = seedYdoc(empty);
    expect(buildSnapshot('todo', doc)).toEqual(empty);
  });

  it('builds from a document nothing has written to', () => {
    expect(buildSnapshot('todo', new Y.Doc())).toEqual({
      kind: 'todo',
      board: expect.objectContaining({ columns: [] }),
    });
  });

  it('validates input, with or without the board wrapper', () => {
    const columns = [
      { id: 'c', title: 'A', nodes: [{ id: 'n', text: 'x', done: true }] },
    ];
    const bare = validateSnapshotInput('todo', { columns });
    const wrapped = validateSnapshotInput('todo', { board: { columns } });
    expect(bare).toEqual(wrapped);
    expect((bare as any).board.columns[0].nodes[0]).toMatchObject({
      id: 'n',
      text: 'x',
      done: true,
    });
  });

  it('refuses input that is not a board', () => {
    for (const bad of [
      null,
      'x',
      {},
      { columns: [1] },
      { columns: [{ nodes: 'x' }] },
      { columns: [{ id: 'a', nodes: [{ id: 'a' }] }] },
      { columns: [{ nodes: [{ text: 5 }] }] },
    ]) {
      expect(() => validateSnapshotInput('todo', bad)).toThrow(
        LiveBlockInputError,
      );
    }
  });

  it('refuses items nested too deep', () => {
    let node: Record<string, unknown> = { text: 'leaf' };
    for (let i = 0; i < MAX_TODO_DEPTH + 1; i++) node = { children: [node] };
    expect(() =>
      validateSnapshotInput('todo', { columns: [{ nodes: [node] }] }),
    ).toThrow(LiveBlockInputError);
  });

  it('renders a checklist for the export', () => {
    const snapshot = validateSnapshotInput('todo', {
      columns: [{ title: 'Card', nodes: [{ text: 'a', done: true }] }],
    });
    const nodes = renderStaticNodes(snapshot, { title: 'Board' }) as any[];
    expect(nodes.map((n) => n.type)).toEqual(['heading', 'taskList']);
  });

  it('renders a line of text for a board with no cards', () => {
    const snapshot = buildSnapshot('todo', new Y.Doc());
    expect(renderStaticNodes(snapshot, { title: 'Board' })).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'To-do board: Board' }],
      },
    ]);
  });
});
