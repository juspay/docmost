import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { connect, docWithClientId } from '../testing/sync';
import * as B from './board';
import { readBoard, seedTodo, writeBoardChange } from './ydoc';

const task = (id: string, text = id): B.TodoNode => ({
  ...B.newTask(text),
  id,
});

function makeBoard(): B.TodoBoard {
  const board = B.createEmptyBoard();
  board.columns = [
    {
      ...B.newColumn('To do', 40, 40),
      id: 'c1',
      nodes: [task('t1'), task('t2'), task('t3')],
    },
    {
      ...B.newColumn('Doing', 400, 40),
      id: 'c2',
      nodes: [task('d1')],
    },
  ];
  return board;
}

function seeded(): Y.Doc {
  const doc = docWithClientId(1);
  seedTodo(doc, makeBoard());
  return doc;
}

/** The documented way to change a board: clone the current one, mutate, diff. */
function change(doc: Y.Doc, mutate: (draft: B.TodoBoard) => void): void {
  const current = readBoard(doc);
  const next = structuredClone(current);
  mutate(next);
  writeBoardChange(doc, current, next);
}

function pair(): { a: Y.Doc; b: Y.Doc; link: ReturnType<typeof connect> } {
  const a = seeded();
  const b = docWithClientId(2);
  const link = connect(a, b);
  return { a, b, link };
}

function texts(board: B.TodoBoard, columnId: string): string[] {
  const out: string[] = [];
  const walk = (nodes: B.TodoNode[], depth: number) => {
    for (const n of nodes) {
      out.push(`${'-'.repeat(depth)}${n.id}`);
      walk(n.children, depth + 1);
    }
  };
  walk(board.columns.find((c) => c.id === columnId)?.nodes ?? [], 0);
  return out;
}

function find(board: B.TodoBoard, id: string): B.TodoNode | undefined {
  let found: B.TodoNode | undefined;
  const walk = (nodes: B.TodoNode[]) => {
    for (const n of nodes) {
      if (n.id === id) found = n;
      walk(n.children);
    }
  };
  board.columns.forEach((c) => walk(c.nodes));
  return found;
}

/** Every `key` that changed on a Yjs map during `fn`, sorted. */
function changedKeys(doc: Y.Doc, fn: () => void): string[] {
  const keys: string[] = [];
  const handler = (tr: Y.Transaction) => {
    tr.changed.forEach((set, type) => {
      if (type instanceof Y.Map) set.forEach((k) => k && keys.push(k));
    });
  };
  doc.on('afterTransaction', handler);
  fn();
  doc.off('afterTransaction', handler);
  return keys.sort();
}

describe('to-do ydoc', () => {
  it('seedTodo then readBoard returns the same board', () => {
    const board = makeBoard();
    board.columns[0].nodes[0].children = [task('t1a')];
    board.columns[0].nodes[0].collapsed = true;
    board.columns[0].nodes[1].kind = 'section';
    board.columns[0].nodes[2].done = true;
    board.columns[0].nodes[2].priority = 3;
    board.columns[1].width = 420;
    board.columns[1].effort = 2;
    board.view = { sort: 'priority', hideDone: true };
    const doc = new Y.Doc();
    seedTodo(doc, board);
    expect(readBoard(doc)).toEqual(board);
  });

  it('keeps the viewport at its default', () => {
    const board = makeBoard();
    board.viewport = { x: 50, y: 60, zoom: 2 };
    const doc = new Y.Doc();
    seedTodo(doc, board);
    expect(readBoard(doc).viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('shares sort and hide-done through meta', () => {
    const { a, b } = pair();
    change(a, (d) => B.setView(d, { sort: 'effort', hideDone: true }));
    expect(readBoard(b).view).toEqual({ sort: 'effort', hideDone: true });
  });

  it('two people editing different items both keep their edits', () => {
    const { a, b, link } = pair();
    link.disconnect();
    change(a, (d) => B.setText(d, 't1', 'renamed'));
    change(b, (d) => B.toggleDone(d, 't2'));
    link.reconnect();
    for (const doc of [a, b]) {
      const board = readBoard(doc);
      expect(find(board, 't1')?.text).toBe('renamed');
      expect(find(board, 't2')?.done).toBe(true);
    }
    expect(readBoard(a)).toEqual(readBoard(b));
  });

  it('two people adding an item to the same list keep both, in the same order on both sides', () => {
    const { a, b, link } = pair();
    link.disconnect();
    change(a, (d) => B.addSiblingAfter(d, 't1', task('xa')));
    change(b, (d) => B.addSiblingAfter(d, 't1', task('xb')));
    link.reconnect();
    const order = texts(readBoard(a), 'c1');
    expect(order).toEqual(texts(readBoard(b), 'c1'));
    expect(order).toHaveLength(5);
    expect(order).toContain('xa');
    expect(order).toContain('xb');
    expect(order[0]).toBe('t1');
    expect(order.slice(3)).toEqual(['t2', 't3']);
  });

  it('two people editing the same item text: one value wins on both sides', () => {
    const { a, b, link } = pair();
    link.disconnect();
    change(a, (d) => B.setText(d, 't1', 'from a'));
    change(b, (d) => B.setText(d, 't1', 'from b'));
    link.reconnect();
    const winner = find(readBoard(a), 't1')?.text;
    expect(['from a', 'from b']).toContain(winner);
    expect(find(readBoard(b), 't1')?.text).toBe(winner);
  });

  it('ticking a parent and concurrently adding a child keeps the child', () => {
    const { a, b, link } = pair();
    change(a, (d) => B.addChild(d, 't1', task('k1')));
    link.disconnect();
    change(a, (d) => B.toggleDone(d, 't1'));
    change(b, (d) => B.addChild(d, 't1', task('k2')));
    link.reconnect();
    for (const doc of [a, b]) {
      const board = readBoard(doc);
      expect(find(board, 't1')?.done).toBe(true);
      expect(find(board, 't1')?.children.map((c) => c.id)).toEqual([
        'k1',
        'k2',
      ]);
    }
  });

  it('deleting an item while someone else edits its text leaves it deleted on both sides', () => {
    const { a, b, link } = pair();
    link.disconnect();
    change(a, (d) => B.removeNode(d, 't1'));
    change(b, (d) => B.setText(d, 't1', 'still here?'));
    link.reconnect();
    for (const doc of [a, b]) {
      expect(find(readBoard(doc), 't1')).toBeUndefined();
    }
  });

  it('deleting an item hides everything under it', () => {
    const { a, b } = pair();
    change(a, (d) => B.addChild(d, 't1', task('k1')));
    change(a, (d) => B.removeNode(d, 't1'));
    expect(texts(readBoard(b), 'c1')).toEqual(['t2', 't3']);
  });

  it('an item moved under a concurrently deleted item reappears at its card root, not lost', () => {
    const { a, b, link } = pair();
    link.disconnect();
    change(a, (d) => B.removeNode(d, 't2'));
    change(b, (d) => B.indentNode(d, 't3'));
    link.reconnect();
    // its key was made for the deleted parent's list, so its place among the
    // root items is arbitrary; it must be at the root and the same on both sides
    expect(readBoard(a)).toEqual(readBoard(b));
    expect(texts(readBoard(a), 'c1').sort()).toEqual(['t1', 't3']);
  });

  it('an item added to a card that someone else deletes at the same moment keeps the card visible', () => {
    const { a, b, link } = pair();
    link.disconnect();
    change(a, (d) => B.removeColumn(d, 'c2'));
    change(b, (d) => B.appendToColumn(d, 'c2', task('late')));
    link.reconnect();
    for (const doc of [a, b]) {
      const board = readBoard(doc);
      expect(board.columns.map((c) => c.id)).toEqual(['c1', 'c2']);
      expect(texts(board, 'c2')).toEqual(['late']);
    }
  });

  it('a deleted card disappears with its items', () => {
    const { a, b } = pair();
    change(a, (d) => B.removeColumn(d, 'c2'));
    expect(readBoard(b).columns.map((c) => c.id)).toEqual(['c1']);
  });

  it('readBoard never throws on a node whose parent or card is missing', () => {
    const doc = seeded();
    const nodes = doc.getMap<Y.Map<unknown>>('nodes');
    const orphan = new Y.Map<unknown>();
    nodes.set('orphan', orphan);
    orphan.set('columnId', 'ghost-card');
    orphan.set('parentId', 'ghost-parent');
    orphan.set('order', 'a0');
    const lost = new Y.Map<unknown>();
    nodes.set('lost', lost);
    lost.set('columnId', 'c1');
    lost.set('parentId', 'ghost-parent');
    lost.set('order', 42);
    lost.set('text', { not: 'a string' });
    lost.set('priority', 'high');
    doc.getMap('columns').set('junk', 'not a map');
    nodes.set('junk', 7);
    let board!: B.TodoBoard;
    expect(() => (board = readBoard(doc))).not.toThrow();
    expect(find(board, 'lost')?.text).toBe('');
    expect(find(board, 'lost')?.priority).toBe(0);
    expect(texts(board, 'c1')).toContain('lost');
    expect(find(board, 'orphan')).toBeDefined();
  });

  it('an empty document reads as a board with no cards', () => {
    expect(readBoard(new Y.Doc()).columns).toEqual([]);
  });

  it('writeBoardChange after a mutating board.ts function on a clone writes exactly the changed fields', () => {
    const doc = seeded();
    change(doc, (d) => {
      B.addChild(d, 't1', task('k1'));
      B.addChild(d, 't1', task('k2'));
    });
    const keys = changedKeys(doc, () =>
      change(doc, (d) => B.toggleDone(d, 't1')),
    );
    expect(keys).toEqual(['done', 'done', 'done']);
  });

  it('a change that touches one field writes one field', () => {
    const doc = seeded();
    expect(
      changedKeys(doc, () => change(doc, (d) => B.setText(d, 't2', 'x'))),
    ).toEqual(['text']);
    expect(
      changedKeys(doc, () =>
        change(doc, (d) => B.setColumnPosition(d, 'c1', 90, 40)),
      ),
    ).toEqual(['x']);
    expect(changedKeys(doc, () => change(doc, () => {}))).toEqual([]);
  });

  it('writes one transaction per change', () => {
    const doc = seeded();
    let transactions = 0;
    doc.on('afterTransaction', () => transactions++);
    change(doc, (d) => {
      B.addChild(d, 't1', task('k1'));
      B.setText(d, 't2', 'y');
      B.removeNode(d, 't3');
    });
    expect(transactions).toBe(1);
  });

  it('moving an item writes only that item', () => {
    const doc = seeded();
    const keys = changedKeys(doc, () =>
      change(doc, (d) => B.moveNode(d, 't3', -1)),
    );
    expect(keys).toEqual(['order']);
    expect(texts(readBoard(doc), 'c1')).toEqual(['t1', 't3', 't2']);
  });

  it('keeps sibling order through moves, indents and outdents', () => {
    const doc = seeded();
    change(doc, (d) => B.indentNode(d, 't2'));
    change(doc, (d) => B.addChild(d, 't1', task('k2')));
    change(doc, (d) => B.moveNode(d, 'k2', -1));
    expect(texts(readBoard(doc), 'c1')).toEqual(['t1', '-k2', '-t2', 't3']);
    change(doc, (d) => B.outdentNode(d, 'k2'));
    expect(texts(readBoard(doc), 'c1')).toEqual(['t1', '-t2', 'k2', 't3']);
  });

  it('concurrent moves that would form a loop are cut the same way on both sides', () => {
    const { a, b, link } = pair();
    link.disconnect();
    change(a, (d) => B.indentNode(d, 't2')); // t2 under t1
    change(b, (d) => {
      // t1 under t2: no ported function can do this, so edit the clone directly
      const col = d.columns[0];
      const t1 = col.nodes.shift()!;
      col.nodes[0].children.push(t1);
    });
    link.reconnect();
    const boardA = readBoard(a);
    expect(boardA).toEqual(readBoard(b));
    expect(texts(boardA, 'c1')).toEqual(['t1', '-t2', 't3']);
  });

  it('edits made while disconnected merge on reconnect', () => {
    const { a, b, link } = pair();
    link.disconnect();
    change(a, (d) => B.toggleDone(d, 't1'));
    change(a, (d) => B.setText(d, 't1', 'a was here'));
    change(b, (d) => B.setText(d, 't2', 'b was here'));
    change(b, (d) => B.addColumn(d, { x: 700, y: 40 }));
    link.reconnect();
    const board = readBoard(a);
    expect(board).toEqual(readBoard(b));
    expect(find(board, 't1')).toMatchObject({ done: true, text: 'a was here' });
    expect(find(board, 't2')?.text).toBe('b was here');
    expect(board.columns).toHaveLength(3);
  });

  it('keeps cards in the order they were added', () => {
    const doc = seeded();
    change(doc, (d) => B.addColumn(d));
    change(doc, (d) => B.addColumn(d));
    expect(
      readBoard(doc)
        .columns.map((c) => c.id)
        .slice(0, 2),
    ).toEqual(['c1', 'c2']);
    expect(readBoard(doc).columns).toHaveLength(4);
  });

  it('removing the last card leaves the fresh card the ported function adds', () => {
    const doc = new Y.Doc();
    const board = B.createEmptyBoard();
    seedTodo(doc, board);
    change(doc, (d) => B.removeColumn(d, d.columns[0].id));
    const after = readBoard(doc);
    expect(after.columns).toHaveLength(1);
    expect(after.columns[0].id).not.toBe(board.columns[0].id);
  });
});

describe('readBoard on a hostile document', () => {
  // the shape a client can write straight into the document
  function chain(depth: number): Y.Doc {
    const doc = docWithClientId(9);
    doc.transact(() => {
      const card = new Y.Map<unknown>();
      card.set('title', 'Deep');
      card.set('order', 'a0');
      doc.getMap('columns').set('c1', card);
      for (let i = 0; i < depth; i++) {
        const node = new Y.Map<unknown>();
        node.set('kind', 'task');
        node.set('text', `n${i}`);
        node.set('columnId', 'c1');
        node.set('parentId', i === 0 ? null : `n${i - 1}`);
        node.set('order', 'a0');
        doc.getMap('nodes').set(`n${i}`, node);
      }
    });
    return doc;
  }

  const depthOf = (nodes: B.TodoNode[]): number => {
    let max = 0;
    const stack = nodes.map((n) => [n, 1] as const);
    while (stack.length) {
      const [n, d] = stack.pop()!;
      max = Math.max(max, d);
      for (const c of n.children) stack.push([c, d + 1]);
    }
    return max;
  };

  it('a 1,600-deep chain is read at most 50 deep, keeps every item and stays editable', () => {
    const doc = chain(1600);
    const board = readBoard(doc);
    expect(depthOf(board.columns[0].nodes)).toBeLessThanOrEqual(50);
    let count = 0;
    const stack = [...board.columns[0].nodes];
    while (stack.length) {
      const n = stack.pop()!;
      count++;
      stack.push(...n.children);
    }
    expect(count).toBe(1600);
    // what the client does before every edit
    const next = structuredClone(board);
    next.columns[0].title = 'Repaired';
    expect(() => writeBoardChange(doc, board, next)).not.toThrow();
    expect(readBoard(doc).columns[0].title).toBe('Repaired');
  });

  it('a 5,000-deep chain still renders for export', async () => {
    const { renderStaticNodes } = await import('../static-render');
    await import('./register');
    const doc = chain(5000);
    const board = readBoard(doc);
    expect(() =>
      renderStaticNodes({ kind: 'todo', board } as any, { title: 'Deep' }),
    ).not.toThrow();
  });

  it('card positions and widths from the document are clamped', () => {
    const doc = docWithClientId(9);
    const card = new Y.Map<unknown>();
    card.set('title', 'Huge');
    card.set('order', 'a0');
    card.set('x', 1e300);
    card.set('y', -1e300);
    card.set('width', 1e300);
    doc.getMap('columns').set('c1', card);
    const [column] = readBoard(doc).columns;
    expect(Math.abs(column.x)).toBeLessThanOrEqual(1_000_000);
    expect(Math.abs(column.y)).toBeLessThanOrEqual(1_000_000);
    expect(column.width).toBe(B.MAX_COLUMN_WIDTH);
  });
});
