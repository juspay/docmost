import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { acceptMerges } from './ydoc';
import { createEmptyBook } from './model';
import { FIRST_TAB_ID, readBook, seedSheet, sheetTabs } from './ydoc';

type R = { r1: number; c1: number; r2: number; c2: number };
const run = (list: R[]) => {
  const count = { n: 0 };
  const out = acceptMerges(list, count);
  return { out, n: count.n };
};
// n log2 n with room for the constant: the old code did 10^7 to 10^10
const bound = (n: number) => 20 * n * Math.ceil(Math.log2(n));

describe('readMerges sweep (refix3)', () => {
  it('10,000 identical merges keep one, in O(n log n) comparisons', () => {
    const { out, n } = run(
      Array.from({ length: 10_000 }, () => ({ r1: 0, c1: 0, r2: 1, c2: 1 })),
    );
    expect(out).toHaveLength(1);
    expect(n).toBeLessThan(bound(10_000));
  });

  it('10,000 merges in one row are all kept', () => {
    const list = Array.from({ length: 10_000 }, (_, i) => ({
      r1: 7,
      c1: (i % 351) * 2,
      r2: 7 + Math.floor(i / 351),
      c2: (i % 351) * 2 + 1,
    }));
    // one row band: rows 7..35, columns in disjoint pairs per row group
    const disjoint = list.map((m, i) => ({
      r1: Math.floor(i / 351),
      c1: (i % 351) * 2,
      r2: Math.floor(i / 351),
      c2: (i % 351) * 2 + 1,
    }));
    const { out, n } = run(disjoint);
    expect(out).toHaveLength(10_000);
    expect(n).toBeLessThan(bound(10_000));
    expect(list).toHaveLength(10_000);
  });

  it('10,000 merges that all overlap the first are rejected cheaply', () => {
    const list = [
      { r1: 0, c1: 0, r2: 4999, c2: 701 },
      ...Array.from({ length: 9_999 }, (_, i) => ({
        r1: i % 5000,
        c1: 3,
        r2: i % 5000,
        c2: 9,
      })),
    ];
    const { out, n } = run(list);
    expect(out).toEqual([{ r1: 0, c1: 0, r2: 4999, c2: 701 }]);
    expect(n).toBeLessThan(bound(10_000));
  });

  it('nested and partly overlapping pairs: the first in (r1, c1, r2, c2) order wins', () => {
    expect(
      run([
        { r1: 1, c1: 1, r2: 2, c2: 2 },
        { r1: 0, c1: 0, r2: 5, c2: 5 },
      ]).out,
    ).toEqual([{ r1: 0, c1: 0, r2: 5, c2: 5 }]);
    expect(
      run([
        { r1: 0, c1: 1, r2: 1, c2: 2 },
        { r1: 0, c1: 0, r2: 1, c2: 1 },
      ]).out,
    ).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }]);
    // touching corners do not overlap
    expect(
      run([
        { r1: 0, c1: 0, r2: 1, c2: 1 },
        { r1: 2, c1: 2, r2: 3, c2: 3 },
      ]).out,
    ).toHaveLength(2);
    // a tall merge still blocks a later row; an expired one does not
    expect(
      run([
        { r1: 0, c1: 0, r2: 9, c2: 1 },
        { r1: 5, c1: 1, r2: 5, c2: 3 },
        { r1: 10, c1: 0, r2: 10, c2: 1 },
      ]).out,
    ).toEqual([
      { r1: 0, c1: 0, r2: 9, c2: 1 },
      { r1: 10, c1: 0, r2: 10, c2: 1 },
    ]);
  });

  it('two peers with the same entries in another insertion order get the same merges', () => {
    const list: R[] = [];
    for (let i = 0; i < 500; i++)
      list.push({
        r1: (i * 37) % 200,
        c1: (i * 11) % 50,
        r2: ((i * 37) % 200) + (i % 3),
        c2: ((i * 11) % 50) + 1 + (i % 2),
      });
    const a = run(list).out;
    const b = run([...list].reverse()).out;
    expect(b).toEqual(a);
  });

  it('a merge over the whole tab is kept on read', () => {
    const book = createEmptyBook();
    book.sheets[0].id = FIRST_TAB_ID;
    book.sheets[0].rows = 5000;
    book.sheets[0].cols = 702;
    const doc = new Y.Doc();
    seedSheet(doc, book);
    const tab = sheetTabs(doc).get(FIRST_TAB_ID) as Y.Map<any>;
    const rows = (tab.get('rows') as Y.Array<string>).toArray();
    const cols = (tab.get('cols') as Y.Array<string>).toArray();
    const merges = tab.get('merges') as Y.Map<any>;
    doc.transact(() => {
      merges.set('all', {
        r1: rows[0],
        c1: cols[0],
        r2: rows[4999],
        c2: cols[701],
      });
      for (let i = 0; i < 9_999; i++) {
        merges.set(`s${i}`, {
          r1: rows[i % 5000],
          c1: cols[2],
          r2: rows[i % 5000],
          c2: cols[3],
        });
      }
    });
    expect(readBook(doc).sheets[0].merges).toEqual([
      { r1: 0, c1: 0, r2: 4999, c2: 701 },
    ]);
  });
});
