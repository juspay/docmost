import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { connect, docWithClientId } from '../testing/sync';
import {
  buildSnapshot,
  kindDefinition,
  LiveBlockInputError,
  renderStaticNodes,
  seedYdoc,
} from '../index';
import { beats, reconcileElements } from './reconcile';
import { pushElements, readElements, readFiles, setFile } from './ydoc';
import { validateScene } from './schema';
import type { WhiteboardSnapshot } from '../snapshot';

const el = (id: string, version: number, versionNonce = 0, extra = {}) => ({
  id,
  type: 'rectangle',
  version,
  versionNonce,
  ...extra,
});

const shape = (id: string, extra = {}) => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...extra,
});

describe('beats', () => {
  it('compares version, then versionNonce, treating missing as 0', () => {
    expect(beats(el('a', 2), el('a', 1))).toBe(true);
    expect(beats(el('a', 1), el('a', 2))).toBe(false);
    expect(beats(el('a', 1, 5), el('a', 1, 4))).toBe(true);
    expect(beats(el('a', 1, 4), el('a', 1, 4))).toBe(false);
    expect(beats({ version: 1 }, {})).toBe(true);
  });

  it('reconcileElements keeps the newer copy and appends remote-only elements', () => {
    const out = reconcileElements(
      [el('a', 1), el('b', 5)],
      [el('b', 3), el('a', 2), el('c', 1)],
    );
    expect(out.map((e) => [e.id, e.version])).toEqual([
      ['a', 2],
      ['b', 5],
      ['c', 1],
    ]);
  });
});

describe('whiteboard ydoc', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = new Y.Doc();
  });

  it('pushing a lower version over a higher one writes nothing', () => {
    pushElements(doc, [el('r1', 7)]);
    expect(pushElements(doc, [el('r1', 5)])).toBe(0);
    expect(readElements(doc)[0].version).toBe(7);
  });

  it('the higher version wins even when Yjs keeps the lower write', () => {
    // Yjs keeps the write of the higher client id. Give the LOWER version the higher client id.
    const a = docWithClientId(2),
      b = docWithClientId(1);
    pushElements(a, [el('r1', 5, 0, { x: 1 })]);
    pushElements(b, [el('r1', 7, 0, { x: 2 })]);
    connect(a, b);
    expect(readElements(a)[0].version).toBe(5); // proves the test is exercising the rule
    pushElements(b, [el('r1', 7, 0, { x: 2 })]); // b re-pushes after seeing the remote change
    expect(readElements(a)).toEqual(readElements(b));
    expect(readElements(a)[0]).toMatchObject({ version: 7, x: 2 });
  });

  it('a version tie is settled by versionNonce on both docs', () => {
    const a = docWithClientId(2),
      b = docWithClientId(1);
    pushElements(a, [el('r1', 3, 1, { x: 1 })]);
    pushElements(b, [el('r1', 3, 9, { x: 2 })]);
    connect(a, b);
    expect(readElements(a)[0].versionNonce).toBe(1);
    expect(pushElements(a, [el('r1', 3, 1, { x: 1 })])).toBe(0);
    expect(pushElements(b, [el('r1', 3, 9, { x: 2 })])).toBe(1);
    expect(readElements(a)).toEqual(readElements(b));
    expect(readElements(a)[0]).toMatchObject({ versionNonce: 9, x: 2 });
  });

  it('pushElements writes nothing when nothing beats the stored copy', () => {
    pushElements(doc, [el('a', 2), el('b', 1)]);
    let updates = 0;
    doc.on('update', () => updates++);
    expect(pushElements(doc, [el('a', 2), el('b', 1), el('a', 1)])).toBe(0);
    expect(updates).toBe(0);
  });

  it('pushElements writes all changes in one transaction and never deletes a key', () => {
    pushElements(doc, [el('a', 1), el('b', 1)]);
    let transactions = 0;
    doc.on('afterTransaction', () => transactions++);
    expect(pushElements(doc, [el('a', 2), el('c', 1)])).toBe(2);
    expect(transactions).toBe(1);
    expect(readElements(doc).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('three clients converge on the highest version', () => {
    const a = docWithClientId(3),
      b = docWithClientId(2),
      c = docWithClientId(1);
    const mine = new Map([
      [a, el('r1', 3, 0, { x: 'a' })],
      [b, el('r1', 9, 0, { x: 'b' })],
      [c, el('r1', 5, 0, { x: 'c' })],
    ]);
    for (const [d, e] of mine) pushElements(d, [e]);
    connect(a, b);
    connect(b, c);
    // each client re-pushes after a remote change until nothing more is written
    for (let round = 0; round < 3; round++)
      for (const [d, e] of mine) pushElements(d, [e]);
    for (const d of [a, b, c])
      expect(readElements(d)[0]).toMatchObject({ version: 9, x: 'b' });
  });

  it('a deleted element stays as a tombstone and is left out of the snapshot', () => {
    pushElements(doc, [shape('a', { version: 1 }), shape('b', { version: 1 })]);
    pushElements(doc, [shape('a', { version: 2, isDeleted: true })]);
    expect(readElements(doc).find((e) => e.id === 'a')?.isDeleted).toBe(true);
    const snap = buildSnapshot('whiteboard', doc) as WhiteboardSnapshot;
    expect(snap.elements.map((e) => e.id)).toEqual(['b']);
  });

  it('an offline edit with more edits beats an online delete', () => {
    // documents the known limit: "newer" means more edits, not later in time
    const a = docWithClientId(1),
      b = docWithClientId(2);
    const link = connect(a, b);
    pushElements(a, [el('r1', 1)]);
    link.disconnect();
    pushElements(a, [el('r1', 2, 0, { isDeleted: true })]);
    const offline = el('r1', 6, 0, { x: 'edited' });
    pushElements(b, [offline]);
    link.reconnect();
    pushElements(b, [offline]);
    pushElements(a, [el('r1', 2, 0, { isDeleted: true })]);
    expect(readElements(a)[0]).toMatchObject({ version: 6, x: 'edited' });
    expect(readElements(a)[0].isDeleted).toBeUndefined();
  });

  it('readElements orders by index', () => {
    pushElements(doc, [
      el('z', 1, 0, { index: 'a0' }),
      el('y', 1, 0, { index: 'a2' }),
      el('x', 1, 0, { index: 'a1' }),
    ]);
    expect(readElements(doc).map((e) => e.id)).toEqual(['z', 'x', 'y']);
  });

  it('edits made while disconnected merge on reconnect', () => {
    const a = docWithClientId(1),
      b = docWithClientId(2);
    const link = connect(a, b);
    link.disconnect();
    pushElements(a, [el('fromA', 1)]);
    pushElements(b, [el('fromB', 1)]);
    setFile(b, 'f1', {
      attachmentId: '0193c7a0-0000-7000-8000-0000000000a1',
      mimeType: 'image/png',
    });
    link.reconnect();
    expect(readElements(a).map((e) => e.id)).toEqual(['fromA', 'fromB']);
    expect(readElements(b)).toEqual(readElements(a));
    expect(readFiles(a)).toEqual({
      f1: {
        attachmentId: '0193c7a0-0000-7000-8000-0000000000a1',
        mimeType: 'image/png',
      },
    });
  });

  it('build does not throw on junk a client could write', () => {
    doc.getMap('elements').set('junk', 5 as any);
    doc.getMap('elements').set('noid', { version: 1 } as any);
    doc.getMap('files').set('bad', 'x' as any);
    pushElements(doc, [shape('ok', { version: 1 })]);
    const snap = buildSnapshot('whiteboard', doc) as WhiteboardSnapshot;
    expect(snap.elements.map((e) => e.id)).toEqual(['ok']);
    expect(snap.files).toEqual({});
  });
});

describe('validateScene', () => {
  it('validateScene gives missing versions 1 and 0, assigns indexes in order, and drops deleted elements', () => {
    const snap = validateScene({
      elements: [
        shape('a'),
        shape('gone', { isDeleted: true }),
        shape('b'),
        shape('c', { version: 4, versionNonce: 7 }),
      ],
      files: {
        f1: {
          attachmentId: '0193c7a0-0000-7000-8000-0000000000a1',
          mimeType: 'image/png',
        },
      },
    });
    expect(snap.kind).toBe('whiteboard');
    expect(snap.elements.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(snap.elements[0]).toMatchObject({ version: 1, versionNonce: 0 });
    expect(snap.elements[2]).toMatchObject({ version: 4, versionNonce: 7 });
    const [i0, i1, i2] = snap.elements.map((e) => e.index as string);
    expect(typeof i0).toBe('string');
    expect(i0 < i1 && i1 < i2).toBe(true);
    expect(snap.files).toEqual({
      f1: {
        attachmentId: '0193c7a0-0000-7000-8000-0000000000a1',
        mimeType: 'image/png',
      },
    });
  });

  it('keeps given indexes and fits missing ones between them', () => {
    const snap = validateScene({
      elements: [
        shape('a', { index: 'a0' }),
        shape('b'),
        shape('c', { index: 'a5' }),
      ],
    });
    const [i0, i1, i2] = snap.elements.map((e) => e.index as string);
    expect(i0).toBe('a0');
    expect(i2).toBe('a5');
    expect(i0 < i1 && i1 < i2).toBe(true);
  });

  it('validateScene refuses 20,001 elements, a non-finite coordinate, and an unknown type', () => {
    const many = Array.from({ length: 20001 }, (_, i) => shape(`e${i}`));
    expect(() => validateScene({ elements: many })).toThrow(
      LiveBlockInputError,
    );
    expect(() =>
      validateScene({ elements: [shape('a', { x: Infinity })] }),
    ).toThrow(LiveBlockInputError);
    expect(() =>
      validateScene({ elements: [shape('a', { y: 'nope' })] }),
    ).toThrow(LiveBlockInputError);
    expect(() =>
      validateScene({ elements: [shape('a', { type: 'virus' })] }),
    ).toThrow(LiveBlockInputError);
    expect(() =>
      validateScene({ elements: [{ ...shape('a'), id: 5 }] }),
    ).toThrow(LiveBlockInputError);
    expect(() =>
      validateScene({
        elements: [
          shape('a', {
            type: 'freedraw',
            points: Array.from({ length: 10001 }, () => [0, 0]),
          }),
        ],
      }),
    ).toThrow(LiveBlockInputError);
    expect(() => validateScene(null)).toThrow(LiveBlockInputError);
    expect(() => validateScene({ elements: 'x' })).toThrow(LiveBlockInputError);
    expect(() =>
      validateScene({ elements: [], files: { f: { attachmentId: 3 } } }),
    ).toThrow(LiveBlockInputError);
  });
});

describe('whiteboard kind', () => {
  it('seedYdoc then buildSnapshot returns the same elements and files', () => {
    const snap = validateScene({
      elements: [shape('a'), shape('b', { type: 'image', fileId: 'f1' })],
      files: {
        f1: {
          attachmentId: '0193c7a0-0000-7000-8000-0000000000a1',
          mimeType: 'image/png',
        },
      },
    });
    const doc = seedYdoc(snap);
    expect(buildSnapshot('whiteboard', doc)).toEqual(snap);
  });

  it('remapAttachments rewrites every attachment id in files', () => {
    const doc = new Y.Doc();
    setFile(doc, 'f1', {
      attachmentId: '0193c7a0-0000-7000-8000-0000000000b1',
      mimeType: 'image/png',
    });
    setFile(doc, 'f2', {
      attachmentId: '0193c7a0-0000-7000-8000-0000000000b2',
      mimeType: 'image/jpeg',
    });
    setFile(doc, 'f3', {
      attachmentId: '0193c7a0-0000-7000-8000-0000000000d0',
      mimeType: 'image/jpeg',
    });
    const def = kindDefinition('whiteboard');
    expect(def.attachmentIds(doc).sort()).toEqual([
      '0193c7a0-0000-7000-8000-0000000000b1',
      '0193c7a0-0000-7000-8000-0000000000b2',
      '0193c7a0-0000-7000-8000-0000000000d0',
    ]);
    def.remapAttachments(
      doc,
      new Map([
        [
          '0193c7a0-0000-7000-8000-0000000000b1',
          '0193c7a0-0000-7000-8000-0000000000c1',
        ],
        [
          '0193c7a0-0000-7000-8000-0000000000b2',
          '0193c7a0-0000-7000-8000-0000000000c2',
        ],
      ]),
    );
    expect(readFiles(doc)).toEqual({
      f1: {
        attachmentId: '0193c7a0-0000-7000-8000-0000000000c1',
        mimeType: 'image/png',
      },
      f2: {
        attachmentId: '0193c7a0-0000-7000-8000-0000000000c2',
        mimeType: 'image/jpeg',
      },
      f3: {
        attachmentId: '0193c7a0-0000-7000-8000-0000000000d0',
        mimeType: 'image/jpeg',
      },
    });
  });

  it('static nodes: the preview image, or a titled link without one', () => {
    const snap = kindDefinition('whiteboard').empty();
    expect(
      renderStaticNodes(snap, { title: 'Plan', previewSrc: '/files/p.svg' }),
    ).toEqual([{ type: 'image', attrs: { src: '/files/p.svg', alt: 'Plan' } }]);
    expect(
      renderStaticNodes(snap, {
        title: 'Plan',
        openUrl: 'https://x/p?block=1',
      }),
    ).toEqual([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Whiteboard: Plan',
            marks: [{ type: 'link', attrs: { href: 'https://x/p?block=1' } }],
          },
        ],
      },
    ]);
  });
});
