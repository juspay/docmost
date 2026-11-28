import { ERR_REF, mapReferences } from './engine';
import { colToLetter } from './model';

/**
 * How formula text maps to stable ids. Positions are 0-based. `rowId` and
 * `colId` may grow the tab so a position past its end gets an id; they return
 * null when the position cannot have one.
 */
export type RefContext = {
  sheetId: string;
  rowId(sheetId: string, row: number): string | null;
  colId(sheetId: string, col: number): string | null;
  rowIndex(sheetId: string, rowId: string): number | null;
  colIndex(sheetId: string, colId: string): number | null;
  sheetIdByName(name: string): string | null;
  sheetName(sheetId: string): string | null;
};

// An anchor is `{` [tabId `!`] [`$`] colId `,` [`$`] rowId `}`. Braces never
// occur in a valid formula outside a string literal, and ids never hold
// `{ } , ! $`. The tab id is present only when the reference names a tab.
const ANCHOR =
  /\{(?:([A-Za-z0-9_-]+)!)?(\$?)([A-Za-z0-9_-]+),(\$?)([A-Za-z0-9_-]+)\}/y;

function anchor(
  tabId: string | null,
  absCol: boolean,
  colId: string,
  absRow: boolean,
  rowId: string,
): string {
  return (
    '{' +
    (tabId ? `${tabId}!` : '') +
    (absCol ? '$' : '') +
    colId +
    ',' +
    (absRow ? '$' : '') +
    rowId +
    '}'
  );
}

/** A1 text → stored text, each resolvable reference replaced by an anchor. */
export function encodeFormula(input: string, ctx: RefContext): string {
  if (!input.startsWith('=')) {
    return input;
  }
  return mapReferences(input, (ref, source) => {
    let tabId = ctx.sheetId;
    if (ref.sheetName !== undefined) {
      const named = ctx.sheetIdByName(ref.sheetName);
      if (!named) {
        // an unknown tab stays as typed; the engine shows #REF! for it
        return source;
      }
      tabId = named;
    }
    const rowId = ctx.rowId(tabId, ref.row);
    const colId = ctx.colId(tabId, ref.col);
    if (!rowId || !colId) {
      return source;
    }
    return anchor(
      ref.sheetName !== undefined ? tabId : null,
      ref.absCol,
      colId,
      ref.absRow,
      rowId,
    );
  });
}

const PLAIN_TAB_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function tabPrefix(name: string): string {
  return PLAIN_TAB_NAME.test(name)
    ? `${name}!`
    : `'${name.replace(/'/g, "''")}'!`;
}

function quotedEnd(body: string, start: number): number {
  const q = body[start];
  let i = start + 1;
  while (i < body.length) {
    if (body[i] === q && body[i + 1] === q) {
      i += 2;
      continue;
    }
    if (body[i] === q) {
      return i + 1;
    }
    i++;
  }
  return i;
}

/** Stored text → A1 text at the current positions; a vanished target is #REF!. */
export function decodeFormula(stored: string, ctx: RefContext): string {
  if (!stored.startsWith('=') || !stored.includes('{')) {
    return stored;
  }
  const body = stored.slice(1);
  // The output is a list of parts joined once at the end: cutting a range
  // back or dropping its ':' touches only the last parts, so each range
  // costs its own length, never the length of the output so far.
  const parts: string[] = ['='];
  let len = 1;
  const push = (text: string) => {
    parts.push(text);
    len += text.length;
  };
  let i = 0;
  // the end of the last anchor and its tab, to print `Name!A1:B2` once
  let lastEnd = -1;
  let lastTab: string | null = null;
  // where the last first-end anchor starts (index into parts, and length)
  let lastStart = -1;
  let lastStartLen = 0;
  // the last anchor was a deleted reference (#REF!)
  let lastWasRef = false;
  let run = -1; // start of a run of plain characters in body
  const flush = () => {
    if (run >= 0) {
      push(body.slice(run, i));
      run = -1;
    }
  };
  while (i < body.length) {
    if (len + (run >= 0 ? i - run : 0) > MAX_DECODED) return TOO_LONG;
    const c = body[i];
    if (c === '"' || c === "'") {
      flush();
      const end = quotedEnd(body, i);
      push(body.slice(i, end));
      i = end;
      continue;
    }
    if (c === '{') {
      ANCHOR.lastIndex = i;
      const m = ANCHOR.exec(body);
      if (m) {
        flush();
        const [whole, tab, absCol, colId, absRow, rowId] = m;
        const tabId = tab ?? ctx.sheetId;
        const name = ctx.sheetName(tabId);
        const row = name === null ? null : ctx.rowIndex(tabId, rowId);
        const col = name === null ? null : ctx.colIndex(tabId, colId);
        const secondEnd =
          i > 0 &&
          body[i - 1] === ':' &&
          lastEnd === i - 1 &&
          lastTab === (tab ?? null);
        if (row === null || col === null) {
          if (secondEnd && lastStart >= 0) {
            // the second end of a range is gone: the whole range is #REF!
            parts.length = lastStart;
            len = lastStartLen;
          } else {
            lastStart = parts.length;
            lastStartLen = len;
          }
          push(ERR_REF);
          lastWasRef = true;
        } else if (secondEnd && lastWasRef) {
          // the first end of the range was deleted: drop the ':' after #REF!
          len -= parts.pop()!.length;
          // the output still ends in #REF!: a chained `:{c}` joins it too
          lastWasRef = true;
        } else {
          if (!secondEnd) {
            lastStart = parts.length;
            lastStartLen = len;
          }
          push(
            (tab && !secondEnd ? tabPrefix(name) : '') +
              absCol +
              colToLetter(col) +
              absRow +
              (row + 1),
          );
          lastWasRef = false;
        }
        i += whole.length;
        if (len > MAX_DECODED) return TOO_LONG;
        lastEnd = i;
        lastTab = tab ?? null;
        continue;
      }
    }
    if (run < 0) run = i;
    // a ':' right after an anchor is its own part, so it can be dropped
    if (c === ':' && lastEnd === i) {
      flush();
      push(':');
      i++;
      continue;
    }
    i++;
  }
  flush();
  return len > MAX_DECODED ? TOO_LONG : parts.join('');
}

/** Longest decoded formula (a cell's limit). */
const MAX_DECODED = 32_767;
/**
 * What a formula decodes to when its text would pass the cell limit (tab
 * names repeated per reference): an error, not millions of characters.
 */
const TOO_LONG = '=#VALUE!';

/**
 * Before rows or columns of tab `tabId` are deleted: a stored range whose
 * first or last row (column) is deleted while part of it survives is
 * shrunk to the surviving part, as spreadsheets do (A1:A5 minus row 5 is
 * A1:A4). A range deleted whole is left to become #REF!. `order` is the
 * axis's ids in order before the delete; `gone` the ids going.
 */
export function shrinkRanges(
  stored: string,
  ownTab: string,
  tabId: string,
  axis: 'rows' | 'cols',
  order: Map<string, number>,
  ids: string[],
  gone: Set<string>,
): string {
  if (!stored.startsWith('=') || !stored.includes(':{')) return stored;
  const body = stored.slice(1);
  let out = '';
  let i = 0;
  let changed = false;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'") {
      const end = quotedEnd(body, i);
      out += body.slice(i, end);
      i = end;
      continue;
    }
    if (c === '{') {
      ANCHOR.lastIndex = i;
      const a = ANCHOR.exec(body);
      if (a && body[i + a[0].length] === ':') {
        ANCHOR.lastIndex = i + a[0].length + 1;
        const b = ANCHOR.exec(body);
        if (b && (b[1] ?? null) === (a[1] ?? null)) {
          const tab = a[1] ?? ownTab;
          let first = a;
          let second = b;
          if (tab === tabId) {
            const k = axis === 'rows' ? 5 : 3;
            const p1 = order.get(a[k]);
            const p2 = order.get(b[k]);
            if (
              p1 !== undefined &&
              p2 !== undefined &&
              (gone.has(a[k]) || gone.has(b[k]))
            ) {
              const lo = Math.min(p1, p2);
              const hi = Math.max(p1, p2);
              let top = lo;
              while (top <= hi && gone.has(ids[top])) top++;
              let bottom = hi;
              while (bottom >= lo && gone.has(ids[bottom])) bottom--;
              if (top <= bottom) {
                // the end that was first keeps being first
                const [startId, endId] =
                  p1 <= p2 ? [ids[top], ids[bottom]] : [ids[bottom], ids[top]];
                first = withId(a, k, startId);
                second = withId(b, k, endId);
                changed = true;
              }
            }
          }
          out += rebuild(first) + ':' + rebuild(second);
          i += a[0].length + 1 + b[0].length;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return changed ? '=' + out : stored;
}

function withId(m: RegExpExecArray, k: number, id: string): RegExpExecArray {
  const copy = [...m] as unknown as RegExpExecArray;
  copy[k] = id;
  return copy;
}

function rebuild(m: RegExpExecArray): string {
  return anchor(m[1] ?? null, m[2] === '$', m[3], m[4] === '$', m[5]);
}
