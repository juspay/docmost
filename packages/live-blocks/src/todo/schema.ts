import { LiveBlockInputError, type TodoSnapshot } from '../snapshot';
import { createEmptyBoard, parseBoard, type TodoBoard } from './board';

export const MAX_TODO_COLUMNS = 200;
export const MAX_TODO_NODES = 5_000;
export const MAX_TODO_DEPTH = 50;
export const MAX_TODO_TEXT = 10_000;
/** characters of JSON input; every item stores its card and parent id, so size grows fast */
export const MAX_TODO_INPUT = 2_000_000;
/** ids are stored on every child: a long one multiplies the document size */
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkTree(columns: unknown[]): void {
  const ids = new Set<string>();
  let nodes = 0;
  const claim = (id: unknown, what: string) => {
    if (id === undefined) return;
    if (typeof id !== 'string' || !VALID_ID.test(id)) {
      throw new LiveBlockInputError(
        `A ${what} id must be 1 to 64 letters, digits, - or _`,
      );
    }
    if (ids.has(id)) throw new LiveBlockInputError(`Duplicate id: ${id}`);
    ids.add(id);
  };
  const text = (v: unknown, what: string) => {
    if (v === undefined) return;
    if (typeof v !== 'string' || v.length > MAX_TODO_TEXT) {
      throw new LiveBlockInputError(
        `A ${what} needs text of at most ${MAX_TODO_TEXT} characters`,
      );
    }
  };
  const walk = (list: unknown, depth: number) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      throw new LiveBlockInputError('Items must be a list');
    }
    if (depth > MAX_TODO_DEPTH) {
      throw new LiveBlockInputError(
        `Items nest at most ${MAX_TODO_DEPTH} levels deep`,
      );
    }
    for (const node of list) {
      if (!isObject(node))
        throw new LiveBlockInputError('An item is not an object');
      if (++nodes > MAX_TODO_NODES) {
        throw new LiveBlockInputError(
          `A to-do board holds at most ${MAX_TODO_NODES} items`,
        );
      }
      claim(node.id, 'item');
      text(node.text, 'item');
      walk(node.children, depth + 1);
    }
  };
  for (const column of columns) {
    if (!isObject(column))
      throw new LiveBlockInputError('A card is not an object');
    claim(column.id, 'card');
    text(column.title, 'card');
    walk(column.nodes, 1);
  }
}

/**
 * Untrusted input to a to-do snapshot: `{ columns, view? }`, or the same under
 * `board`. Throws LiveBlockInputError.
 */
export function validateBoardInput(input: unknown): TodoSnapshot {
  const raw = isObject(input) && isObject(input.board) ? input.board : input;
  if (!isObject(raw) || !Array.isArray(raw.columns)) {
    throw new LiveBlockInputError('A to-do board needs { columns: [...] }');
  }
  if (raw.columns.length > MAX_TODO_COLUMNS) {
    throw new LiveBlockInputError(
      `A to-do board holds at most ${MAX_TODO_COLUMNS} cards`,
    );
  }
  checkTree(raw.columns);
  const json = JSON.stringify(raw);
  if (json.length > MAX_TODO_INPUT) {
    throw new LiveBlockInputError(
      `A to-do board is at most ${MAX_TODO_INPUT} characters of JSON`,
    );
  }
  if (raw.columns.length === 0) {
    // parseBoard would add a starter card; an empty board is allowed here
    const { view } = parseBoard(JSON.stringify({ ...raw, columns: [{}] }));
    return {
      kind: 'todo',
      board: { ...createEmptyBoard(), columns: [], view },
    };
  }
  const board: TodoBoard = parseBoard(json);
  return { kind: 'todo', board };
}
