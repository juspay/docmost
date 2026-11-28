import * as Y from 'yjs';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { MAX_TODO_DEPTH } from './schema';
import {
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  type Rating,
  type TodoBoard,
  type TodoColumn,
  type TodoNode,
  type TodoSort,
} from './board';

const META = 'meta';
const COLUMNS = 'columns';
const NODES = 'nodes';

const COLUMN_FIELDS = [
  'title',
  'x',
  'y',
  'width',
  'effort',
  'time',
  'priority',
] as const;
const NODE_FIELDS = [
  'kind',
  'text',
  'done',
  'effort',
  'time',
  'priority',
  'collapsed',
] as const;

const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

type Fields = Record<string, unknown>;
type FlatNode = { fields: Fields; columnId: string; parentId: string | null };
type Flat = {
  columns: Map<string, Fields>;
  nodes: Map<string, FlatNode>;
  /** Sibling lists in display order. Cards are the list under CARDS. */
  groups: Map<string, string[]>;
};

const CARDS = 'cards';
const groupKey = (columnId: string, parentId: string | null) =>
  JSON.stringify([columnId, parentId]);

function flatten(board: TodoBoard): Flat {
  const flat: Flat = {
    columns: new Map(),
    nodes: new Map(),
    groups: new Map([[CARDS, []]]),
  };
  const walk = (
    list: TodoNode[],
    columnId: string,
    parentId: string | null,
  ) => {
    const ids: string[] = [];
    for (const node of list) {
      const fields: Fields = {};
      for (const f of NODE_FIELDS) fields[f] = node[f];
      flat.nodes.set(node.id, { fields, columnId, parentId });
      ids.push(node.id);
      walk(node.children, columnId, node.id);
    }
    flat.groups.set(groupKey(columnId, parentId), ids);
  };
  for (const column of board.columns) {
    const fields: Fields = {};
    for (const f of COLUMN_FIELDS) fields[f] = column[f];
    flat.columns.set(column.id, fields);
    flat.groups.get(CARDS)!.push(column.id);
    walk(column.nodes, column.id, null);
  }
  return flat;
}

const EMPTY_BOARD: TodoBoard = {
  version: 1,
  columns: [],
  viewport: DEFAULT_VIEWPORT,
  view: { sort: 'manual', hideDone: false },
};

function setIfDifferent(map: Y.Map<unknown>, key: string, value: unknown) {
  if (map.get(key) !== value) map.set(key, value);
}

function mapAt(
  parent: Y.Map<unknown>,
  id: string,
): { map: Y.Map<unknown>; fresh: boolean } {
  const existing = parent.get(id);
  if (existing instanceof Y.Map) return { map: existing, fresh: false };
  const map = new Y.Map<unknown>();
  parent.set(id, map);
  return { map, fresh: true };
}

/** Indices of the longest strictly increasing run of `values`. */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = [];
  const back: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (
    let i = tails.length ? tails[tails.length - 1] : -1;
    i >= 0;
    i = back[i]
  ) {
    keep.add(i);
  }
  return keep;
}

function keyBetween(a: string | null, b: string | null): string {
  try {
    return generateJitteredKeyBetween(a, b);
  } catch {
    // stored keys that tie or run backwards: settle for "after the previous"
    try {
      return generateJitteredKeyBetween(a, null);
    } catch {
      return generateJitteredKeyBetween(null, null);
    }
  }
}

/**
 * New order keys for the siblings whose position changed. Siblings that keep
 * their relative order keep their stored key; each other one gets a key between
 * its new neighbours. Only those are returned.
 */
function newOrderKeys(
  prevIds: string[],
  nextIds: string[],
  storedKey: (id: string) => string | null,
): Map<string, string> {
  const prevIndex = new Map(prevIds.map((id, i) => [id, i]));
  const common = nextIds.filter((id) => prevIndex.has(id));
  const stay = longestIncreasing(common.map((id) => prevIndex.get(id)!));
  const keep = new Set<string>();
  let last: string | null = null;
  common.forEach((id, i) => {
    const key = storedKey(id);
    if (!stay.has(i) || key === null || (last !== null && key <= last)) return;
    keep.add(id);
    last = key;
  });

  const out = new Map<string, string>();
  const following: Array<string | null> = new Array(nextIds.length).fill(null);
  let upcoming: string | null = null;
  for (let i = nextIds.length - 1; i >= 0; i--) {
    following[i] = upcoming;
    if (keep.has(nextIds[i])) upcoming = storedKey(nextIds[i]);
  }
  let before: string | null = null;
  nextIds.forEach((id, i) => {
    if (keep.has(id)) {
      before = storedKey(id);
      return;
    }
    before = keyBetween(before, following[i]);
    out.set(id, before);
  });
  return out;
}

const storedOrder = (map: Y.Map<unknown>, id: string): string | null => {
  const v = map.get(id);
  const order = v instanceof Y.Map ? v.get('order') : null;
  return typeof order === 'string' ? order : null;
};

/**
 * Writes the difference between two boards in one transaction. `prev` must be
 * what `readBoard` returned for this document a moment ago, and `next` a
 * mutated clone of it. Fields that did not change are not written, a removed
 * item is marked `deleted` and never removed from its map, and only an item
 * whose place among its siblings changed gets a new `order` key.
 */
export function writeBoardChange(
  doc: Y.Doc,
  prev: TodoBoard,
  next: TodoBoard,
  origin?: unknown,
): void {
  const before = flatten(prev);
  const after = flatten(next);
  const meta = doc.getMap<unknown>(META);
  const columns = doc.getMap<unknown>(COLUMNS);
  const nodes = doc.getMap<unknown>(NODES);

  doc.transact(() => {
    if (prev.view.sort !== next.view.sort) meta.set('sort', next.view.sort);
    if (prev.view.hideDone !== next.view.hideDone) {
      meta.set('hideDone', next.view.hideDone);
    }

    const markDeleted = (parent: Y.Map<unknown>, id: string) => {
      const v = parent.get(id);
      if (v instanceof Y.Map) setIfDifferent(v, 'deleted', true);
    };
    for (const id of before.columns.keys()) {
      if (!after.columns.has(id)) markDeleted(columns, id);
    }
    for (const id of before.nodes.keys()) {
      if (!after.nodes.has(id)) markDeleted(nodes, id);
    }

    const orders = new Map<string, string>();
    for (const [key, nextIds] of after.groups) {
      const keys = newOrderKeys(before.groups.get(key) ?? [], nextIds, (id) =>
        storedOrder(key === CARDS ? columns : nodes, id),
      );
      for (const [id, order] of keys) orders.set(`${key}\u0000${id}`, order);
    }

    for (const [id, fields] of after.columns) {
      const was = before.columns.get(id);
      const { map, fresh } = mapAt(columns, id);
      const all = fresh || !was;
      for (const f of COLUMN_FIELDS) {
        if (all || was[f] !== fields[f]) setIfDifferent(map, f, fields[f]);
      }
      const order = orders.get(`${CARDS}\u0000${id}`);
      if (order !== undefined) map.set('order', order);
      if (all) setIfDifferent(map, 'deleted', false);
    }

    for (const [id, node] of after.nodes) {
      const was = before.nodes.get(id);
      const { map, fresh } = mapAt(nodes, id);
      const all = fresh || !was;
      for (const f of NODE_FIELDS) {
        if (all || was.fields[f] !== node.fields[f]) {
          setIfDifferent(map, f, node.fields[f]);
        }
      }
      if (all || was.columnId !== node.columnId) {
        setIfDifferent(map, 'columnId', node.columnId);
      }
      if (all || was.parentId !== node.parentId) {
        setIfDifferent(map, 'parentId', node.parentId);
      }
      const order = orders.get(
        `${groupKey(node.columnId, node.parentId)}\u0000${id}`,
      );
      if (order !== undefined) map.set('order', order);
      if (all) setIfDifferent(map, 'deleted', false);
    }
  }, origin);
}

/** Writes a whole board into an empty document. */
export function seedTodo(doc: Y.Doc, board: TodoBoard): void {
  writeBoardChange(doc, EMPTY_BOARD, board);
}

// ----- reading -----

type RawNode = {
  id: string;
  columnId: string | null;
  parentId: string | null;
  order: string;
  deleted: boolean;
  node: TodoNode;
};
type RawColumn = {
  id: string;
  order: string;
  deleted: boolean;
  column: TodoColumn;
};

const str = (v: unknown, fallback: string) =>
  typeof v === 'string' ? v : fallback;
const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));
/** a card further out than this is a hostile or broken write */
const MAX_CARD_POSITION = 1_000_000;
const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const rating = (v: unknown): Rating => (v === 1 || v === 2 || v === 3 ? v : 0);
const byOrder = (
  a: { order: string; id: string },
  b: { order: string; id: string },
) =>
  a.order < b.order
    ? -1
    : a.order > b.order
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

function rawNode(id: string, m: Y.Map<unknown>): RawNode {
  const kind = m.get('kind') === 'section' ? 'section' : 'task';
  return {
    id,
    columnId:
      typeof m.get('columnId') === 'string'
        ? (m.get('columnId') as string)
        : null,
    parentId:
      typeof m.get('parentId') === 'string'
        ? (m.get('parentId') as string)
        : null,
    order: str(m.get('order'), ''),
    deleted: m.get('deleted') === true,
    node: {
      id,
      kind,
      text: str(m.get('text'), ''),
      done: kind === 'task' && m.get('done') === true,
      effort: rating(m.get('effort')),
      time: rating(m.get('time')),
      priority: rating(m.get('priority')),
      collapsed: m.get('collapsed') === true,
      children: [],
    },
  };
}

function rawColumn(id: string, m: Y.Map<unknown>): RawColumn {
  const width = m.get('width');
  return {
    id,
    order: str(m.get('order'), ''),
    deleted: m.get('deleted') === true,
    column: {
      id,
      title: str(m.get('title'), ''),
      nodes: [],
      x: clamp(num(m.get('x'), 0), -MAX_CARD_POSITION, MAX_CARD_POSITION),
      y: clamp(num(m.get('y'), 0), -MAX_CARD_POSITION, MAX_CARD_POSITION),
      width:
        typeof width === 'number' && Number.isFinite(width)
          ? clamp(Math.round(width), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH)
          : null,
      effort: rating(m.get('effort')),
      time: rating(m.get('time')),
      priority: rating(m.get('priority')),
    },
  };
}

function readSort(v: unknown): TodoSort {
  return v === 'effort' || v === 'time' || v === 'priority' ? v : 'manual';
}

/**
 * The board as it should be shown. Never throws, and never drops a live item:
 * an item under a deleted or missing parent goes to its card's root, a deleted
 * card that still holds a live item stays visible, and a parent loop is cut at
 * the item with the smallest id. Pan and zoom are per person, so the viewport
 * is always the default.
 */
export function readBoard(doc: Y.Doc): TodoBoard {
  const meta = doc.getMap<unknown>(META);
  const rawColumns: RawColumn[] = [];
  doc.getMap<unknown>(COLUMNS).forEach((v, id) => {
    if (v instanceof Y.Map) rawColumns.push(rawColumn(id, v));
  });
  const live: RawNode[] = [];
  doc.getMap<unknown>(NODES).forEach((v, id) => {
    if (!(v instanceof Y.Map)) return;
    const raw = rawNode(id, v);
    if (!raw.deleted) live.push(raw);
  });

  const known = new Set(rawColumns.map((c) => c.id));
  const hasLive = new Set<string>();
  for (const n of live)
    if (n.columnId && known.has(n.columnId)) hasLive.add(n.columnId);
  const shown = rawColumns
    .filter((c) => !c.deleted || hasLive.has(c.id))
    .sort(byOrder);

  const fallbackColumn = shown[0]?.id ?? null;
  const columnOf = new Map<string, string>();
  const shownIds = new Set(shown.map((c) => c.id));
  const placed: RawNode[] = [];
  for (const n of live) {
    const home =
      n.columnId && shownIds.has(n.columnId) ? n.columnId : fallbackColumn;
    if (home === null) continue;
    columnOf.set(n.id, home);
    placed.push(n);
  }

  const byId = new Map(placed.map((n) => [n.id, n]));
  const parentOf = new Map<string, string | null>();
  for (const n of placed) {
    const p = n.parentId;
    const ok =
      p !== null &&
      p !== n.id &&
      byId.has(p) &&
      columnOf.get(p) === columnOf.get(n.id);
    parentOf.set(n.id, ok ? p : null);
  }

  // each item has one parent, so a loop is a cycle in a functional graph
  const state = new Map<string, 1 | 2>();
  for (const start of [...byId.keys()].sort()) {
    const path: string[] = [];
    let at: string | null = start;
    while (at !== null && !state.has(at)) {
      state.set(at, 1);
      path.push(at);
      at = parentOf.get(at) ?? null;
    }
    if (at !== null && state.get(at) === 1) {
      const loop = path.slice(path.indexOf(at));
      parentOf.set(
        loop.reduce((a, b) => (b < a ? b : a)),
        null,
      );
    }
    for (const id of path) state.set(id, 2);
  }

  // A client can write any depth; past the limit an item moves to its card's
  // root (with its subtree), so nothing downstream recurses too deep.
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of byId.keys()) {
    const parent = parentOf.get(id) ?? null;
    if (parent === null) roots.push(id);
    else {
      const list = childrenOf.get(parent);
      if (list) list.push(id);
      else childrenOf.set(parent, [id]);
    }
  }
  const queue: [string, number][] = roots.map((id) => [id, 1]);
  for (let i = 0; i < queue.length; i++) {
    const [id, depth] = queue[i];
    for (const child of childrenOf.get(id) ?? []) {
      if (depth + 1 > MAX_TODO_DEPTH) {
        parentOf.set(child, null);
        queue.push([child, 1]);
      } else {
        queue.push([child, depth + 1]);
      }
    }
  }

  const columnById = new Map(shown.map((c) => [c.id, c.column]));
  for (const n of placed.sort(byOrder)) {
    const parent = parentOf.get(n.id);
    if (parent) byId.get(parent)!.node.children.push(n.node);
    else columnById.get(columnOf.get(n.id)!)!.nodes.push(n.node);
  }

  return {
    version: 1,
    columns: shown.map((c) => c.column),
    viewport: { ...DEFAULT_VIEWPORT },
    view: {
      sort: readSort(meta.get('sort')),
      hideDone: meta.get('hideDone') === true,
    },
  };
}
