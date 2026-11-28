import type { WhiteboardSnapshot } from '@docmost/live-blocks';
import { todo } from '@docmost/live-blocks';
import {
  PNG_DATA_URL,
  tasksBoard,
  whiteboardScene,
  budgetBook,
} from '../testing/synthetic-mindspace';
import {
  SceneInvalidError,
  sceneToSnapshot,
  snapshotFingerprint,
  sourceFingerprint,
} from './scene.util';

describe('sceneToSnapshot', () => {
  it('a whiteboard keeps its live elements and hands back its inline images; appState is dropped', () => {
    const { snapshot, files } = sceneToSnapshot('whiteboard', whiteboardScene);
    expect(snapshot.kind).toBe('whiteboard');
    const wb = snapshot as WhiteboardSnapshot;
    expect(wb.elements.map((e) => e.id)).toEqual([
      'rect-1',
      'ellipse-1',
      'text-1',
      'image-1',
    ]);
    expect(wb.files).toEqual({});
    expect(files).toEqual({
      'file-png-1': { dataURL: PNG_DATA_URL, mimeType: 'image/png' },
    });
    expect(JSON.stringify(snapshot)).not.toContain('viewBackgroundColor');
  });

  it('accepts the scene as an object or as a JSON string (old rows)', () => {
    const fromString = sceneToSnapshot(
      'whiteboard',
      JSON.stringify(whiteboardScene),
    );
    expect(fromString.snapshot).toEqual(
      sceneToSnapshot('whiteboard', whiteboardScene).snapshot,
    );
  });

  it('drops a file no live image uses, with a warning', () => {
    const scene = {
      ...whiteboardScene,
      files: {
        ...whiteboardScene.files,
        orphan: { mimeType: 'image/png', id: 'orphan', dataURL: PNG_DATA_URL },
      },
    };
    const { files, warnings } = sceneToSnapshot('whiteboard', scene);
    expect(Object.keys(files)).toEqual(['file-png-1']);
    expect(warnings).toEqual([
      'file orphan is not used by any element and was dropped',
    ]);
  });

  it('a todo board goes through the ported parser', () => {
    const board = tasksBoard();
    const { snapshot } = sceneToSnapshot('todo', board);
    expect(snapshot).toEqual({
      kind: 'todo',
      board: todo.parseBoard(JSON.stringify(board)),
    });
  });

  it('null is an empty block with no warning', () => {
    expect(sceneToSnapshot('whiteboard', null)).toEqual({
      snapshot: { kind: 'whiteboard', elements: [], files: {} },
      files: {},
      warnings: [],
    });
    const empty = sceneToSnapshot('todo', null);
    expect(empty.snapshot).toMatchObject({
      kind: 'todo',
      board: { columns: [] },
    });
  });

  it('a scene that is not JSON or fails validation throws SceneInvalidError with the reason', () => {
    expect(() => sceneToSnapshot('whiteboard', '{"elements": [')).toThrow(
      SceneInvalidError,
    );
    expect(() =>
      sceneToSnapshot('whiteboard', {
        elements: [
          { id: 'x', type: 'rectangle', x: 'left', y: 0, width: 1, height: 1 },
        ],
      }),
    ).toThrow(SceneInvalidError);
    // the ported parser would quietly turn this into an empty board; that would be a silent loss
    expect(() => sceneToSnapshot('todo', { cards: [] })).toThrow(
      'A to-do board needs { columns: [...] }',
    );
    expect(() => sceneToSnapshot('whiteboard', 42)).toThrow(SceneInvalidError);
  });
});

describe('unsafe whiteboard elements', () => {
  const el = (id: string, type: string, extra: object = {}) => ({
    id,
    type,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    ...extra,
  });
  const scene = {
    elements: [
      el('a', 'rectangle'),
      el('f1', 'iframe'),
      el('f2', 'magicframe'),
      el('e1', 'embeddable', { link: 'https://evil.test/x' }),
      el('e2', 'embeddable', {
        link: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
      }),
      el('l1', 'text', { text: 'x', link: 'javascript:alert(1)' }),
      el('g1', 'rectangle', {
        customData: { generationData: { html: '<script>' } },
      }),
      el('a', 'ellipse'),
    ],
  };

  it('are cleaned, not refused: dropped or their unsafe part removed, the first of two ids kept', () => {
    const { snapshot, removed, altered } = sceneToSnapshot('whiteboard', scene);
    const wb = snapshot as WhiteboardSnapshot;
    expect(wb.elements.map((e) => [e.id, e.type])).toEqual([
      ['a', 'rectangle'],
      // a foreign embed is kept as a plain rectangle
      ['e1', 'rectangle'],
      ['e2', 'embeddable'],
      ['l1', 'text'],
      ['g1', 'rectangle'],
    ]);
    expect(wb.elements.find((e) => e.id === 'l1').link).toBeNull();
    expect(wb.elements.find((e) => e.id === 'e1').link).toBeNull();
    expect(wb.elements.find((e) => e.id === 'g1').customData).toBeUndefined();
    expect(removed).toEqual({ iframe: 1, magicframe: 1, 'duplicate-id': 1 });
    expect(altered).toEqual({ 'unsafe-embed': 1, 'unsafe-link': 1 });
  });

  it('the source fingerprint counts what the cleaned board can hold', () => {
    expect(sourceFingerprint('whiteboard', scene)).toMatchObject({
      elements: 5,
    });
  });
});

describe('ordinary Excalidraw boards are never emptied (review Bwb, issue 3)', () => {
  const el = (id: string, type: string, extra: object = {}) => ({
    id,
    type,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    ...extra,
  });
  it.each([
    // a link without a scheme is given https:// and kept: nothing to report
    [
      'a link without a scheme',
      el('l', 'text', { text: 'x', link: 'example.com' }),
      null,
    ],
    [
      'a tel: link',
      el('l', 'text', { text: 'x', link: 'tel:+4912345' }),
      'unsafe-link',
    ],
    [
      'an embed Excalidraw allowed by default',
      el('l', 'embeddable', { link: 'https://drive.google.com/file/d/1' }),
      'unsafe-embed',
    ],
    ['a magicframe', el('l', 'magicframe'), 'magicframe'],
    ['a deleted iframe', el('l', 'iframe', { isDeleted: true }), null],
  ])('%s keeps the rest of the board', (_what, bad, reason) => {
    const { snapshot, removed, altered } = sceneToSnapshot('whiteboard', {
      elements: [el('a', 'rectangle'), bad, el('b', 'ellipse')],
    });
    const ids = (snapshot as WhiteboardSnapshot).elements.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['a', 'b']));
    if (reason)
      expect({ ...removed, ...altered }).toMatchObject({ [reason]: 1 });
  });

  it('a repeated id among deleted elements keeps the live one', () => {
    const { snapshot } = sceneToSnapshot('whiteboard', {
      elements: [
        el('a', 'rectangle', { isDeleted: true }),
        el('a', 'ellipse'),
        el('b', 'diamond'),
      ],
    });
    expect(
      (snapshot as WhiteboardSnapshot).elements.map((e) => [e.id, e.type]),
    ).toEqual([
      ['a', 'ellipse'],
      ['b', 'diamond'],
    ]);
  });
});

describe('references to removed elements', () => {
  // needs live-blocks 7e95dd93 (cleanElements clears references)
  it('no binding, frame or bound-element entry points at a removed element', () => {
    const el = (id: string, type: string, extra: object = {}) => ({
      id,
      type,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ...extra,
    });
    const { snapshot } = sceneToSnapshot('whiteboard', {
      elements: [
        el('f', 'iframe', { boundElements: [{ id: 'arr', type: 'arrow' }] }),
        el('box', 'rectangle', {
          frameId: 'f',
          boundElements: [{ id: 'arr', type: 'arrow' }],
        }),
        el('arr', 'arrow', {
          points: [
            [0, 0],
            [1, 1],
          ],
          startBinding: { elementId: 'f', focus: 0, gap: 1 },
          endBinding: { elementId: 'box', focus: 0, gap: 1 },
        }),
        el('child', 'text', { text: 'x', frameId: 'f' }),
      ],
    });
    const els = (snapshot as WhiteboardSnapshot).elements as any[];
    const ids = new Set(els.map((e) => e.id));
    for (const e of els) {
      if (e.frameId != null) expect(ids).toContain(e.frameId);
      for (const b of [e.startBinding, e.endBinding])
        if (b) expect(ids).toContain(b.elementId);
      for (const b of e.boundElements ?? []) expect(ids).toContain(b.id);
    }
    expect(els.find((e) => e.id === 'arr').endBinding).toMatchObject({
      elementId: 'box',
    });
    // each cleared reference is counted in the report
    const { altered } = sceneToSnapshot('whiteboard', {
      elements: [
        el('f', 'iframe'),
        el('child', 'text', { text: 'x', frameId: 'f' }),
      ],
    });
    expect(altered).toEqual({ 'frame-cleared': 1 });
  });
});

describe('sheet scenes', () => {
  it('a mindspace workbook (as a JSON string) becomes a sheet snapshot and the full book to seed', () => {
    const { snapshot, book } = sceneToSnapshot(
      'sheet',
      JSON.stringify(budgetBook()),
    );
    expect(snapshot.kind).toBe('sheet');
    expect(book.sheets.map((t: any) => t.name)).toEqual(['Budget', 'Rates']);
    expect(book.sheets[0].frozenRows).toBe(1);
  });

  it('a book that is not a workbook is refused with the reason, not emptied', () => {
    expect(() => sceneToSnapshot('sheet', { tabs: [] })).toThrow(
      'A spreadsheet needs a list of sheets',
    );
    expect(() =>
      sceneToSnapshot('sheet', { sheets: [{ cells: { x: { v: '1' } } }] }),
    ).toThrow('the cell key x is not "row:col"');
  });
});

describe('fingerprints', () => {
  it('counts live elements and images of a whiteboard, cards and items of a board', () => {
    expect(sourceFingerprint('whiteboard', whiteboardScene)).toEqual({
      kind: 'whiteboard',
      elements: 4,
      images: 1,
    });
    // three items in the first card (one nested), two in the second
    expect(sourceFingerprint('todo', tasksBoard())).toEqual({
      kind: 'todo',
      cards: 2,
      items: 5,
    });
    expect(sourceFingerprint('whiteboard', null)).toEqual({
      kind: 'whiteboard',
      elements: 0,
      images: 0,
    });
    expect(sourceFingerprint('whiteboard', '{"bad')).toEqual({
      kind: 'invalid',
      reason: expect.stringContaining('not valid JSON'),
    });
  });

  it('the stored snapshot of a converted scene has the same fingerprint', () => {
    const wb = sceneToSnapshot('whiteboard', whiteboardScene).snapshot as any;
    wb.files = { 'file-png-1': { attachmentId: 'a', mimeType: 'image/png' } };
    expect(snapshotFingerprint(wb)).toEqual(
      sourceFingerprint('whiteboard', whiteboardScene),
    );
    expect(
      snapshotFingerprint(sceneToSnapshot('todo', tasksBoard()).snapshot),
    ).toEqual(sourceFingerprint('todo', tasksBoard()));
  });
});
