import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { validateScene } from './schema';
import { pushElements, readElements } from './ydoc';
import { beats } from './reconcile';

const shape = (version: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'a',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  version,
  versionNonce: 7,
  ...extra,
});

describe('element versions a client cannot be trusted with', () => {
  for (const bad of [NaN, 1e308, -5, 1.5, Infinity]) {
    it(`an element stored with version ${bad} can still be edited and deleted`, () => {
      const doc = new Y.Doc();
      doc.getMap<any>('elements').set('a', shape(bad));
      const [read] = readElements(doc);
      // repaired on read, so the editor works from a sane number
      expect(Number.isSafeInteger(read.version)).toBe(true);
      expect(read.version).toBeGreaterThanOrEqual(0);
      // the next edit, as Excalidraw makes it, wins over the stored copy
      const next = {
        ...read,
        version: (read.version as number) + 1,
        isDeleted: true,
      };
      expect(pushElements(doc, [next as any])).toBe(1);
      expect(readElements(doc)[0].isDeleted).toBe(true);
    });
  }

  it('beats treats a version that is not a sane integer as 0', () => {
    expect(beats({ version: 2 }, { version: NaN })).toBe(true);
    expect(beats({ version: 2 }, { version: 1e308 })).toBe(true);
    expect(beats({ version: NaN }, { version: 1 })).toBe(false);
  });

  it('validateScene clamps versions and nonces to sane integers', () => {
    const [el] = validateScene({
      elements: [shape(1e308, { versionNonce: NaN as any })],
    }).elements;
    expect(el.version).toBe(1);
    expect(el.versionNonce).toBe(0);
    const [ok] = validateScene({ elements: [shape(42)] }).elements;
    expect(ok.version).toBe(42);
  });
});

describe('repeated element ids', () => {
  it('validateScene refuses two elements with one id (the seeded document would keep only one)', () => {
    expect(() =>
      validateScene({ elements: [shape(1, { x: 1 }), shape(1, { x: 2 })] }),
    ).toThrow(/Duplicate element id/);
  });
});

describe('versions near the bound', () => {
  const MAX = 1_000_000_000;
  for (const stored of [MAX - 1, MAX, MAX + 1, MAX - 50_000_000]) {
    it(`a stored version of ${stored}: the next edit and a delete win, and two peers converge`, () => {
      const a = new Y.Doc();
      const b = new Y.Doc();
      a.getMap<any>('elements').set('a', shape(stored));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      // A edits what it read, the way Excalidraw does
      const [readA] = readElements(a);
      const edit = { ...readA, version: (readA.version as number) + 1, x: 99 };
      expect(pushElements(a, [edit as any])).toBe(1);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      expect(readElements(b)[0]).toMatchObject({ x: 99 });
      // B deletes what it read
      const [readB] = readElements(b);
      const del = {
        ...readB,
        version: (readB.version as number) + 1,
        isDeleted: true,
      };
      expect(pushElements(b, [del as any])).toBe(1);
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      expect(readElements(a)[0].isDeleted).toBe(true);
      expect(readElements(b)[0].isDeleted).toBe(true);
    });
  }

  it('validateScene does not keep a version in the headroom', () => {
    const [el] = validateScene({ elements: [shape(MAX - 1)] }).elements;
    expect(el.version).toBe(1);
  });
});
