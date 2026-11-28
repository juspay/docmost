import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { cleanElements, sanitizeElements } from './safety';
import { readElements } from './ydoc';

const el = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  version: 1,
  ...extra,
});

const board = () => [
  el('evil', {
    type: 'iframe',
    boundElements: [{ id: 'arrow', type: 'arrow' }],
  }),
  el('arrow', {
    type: 'arrow',
    startBinding: { elementId: 'evil', focus: 0, gap: 1 },
    endBinding: { elementId: 'box', focus: 0, gap: 1 },
  }),
  el('box', {
    boundElements: [
      { id: 'arrow', type: 'arrow' },
      { id: 'gone', type: 'arrow' },
    ],
  }),
  el('shape', {
    type: 'magicframe',
    boundElements: [{ id: 'label', type: 'text' }],
  }),
  el('label', { type: 'text', text: 'hi', containerId: 'shape' }),
  el('frame', { type: 'iframe' }),
  el('child', { frameId: 'frame' }),
];

function check(elements: any[]) {
  const by = Object.fromEntries(elements.map((e) => [e.id, e]));
  expect(Object.keys(by).sort()).toEqual(['arrow', 'box', 'child', 'label']);
  expect(by.arrow.startBinding).toBeNull();
  expect(by.arrow.endBinding).toEqual({ elementId: 'box', focus: 0, gap: 1 });
  // only references to removed elements go; the rest stay as they were
  expect(by.box.boundElements).toEqual([
    { id: 'arrow', type: 'arrow' },
    { id: 'gone', type: 'arrow' },
  ]);
  // bound text whose container was removed stays as free text
  expect(by.label.containerId).toBeNull();
  expect(by.label.text).toBe('hi');
  expect(by.child.frameId).toBeNull();
}

describe('references to removed elements', () => {
  it('cleanElements clears them and reports them as altered', () => {
    const { elements, altered } = cleanElements(board());
    check(elements);
    expect(altered).toEqual([
      { id: 'arrow', reason: 'binding to a removed element cleared' },
      { id: 'label', reason: 'container was removed; kept as free text' },
      { id: 'child', reason: 'frame was removed; kept outside it' },
    ]);
  });

  it('sanitizeElements and the read path clear them too', () => {
    check(sanitizeElements(board() as any));
    const doc = new Y.Doc();
    for (const e of board()) doc.getMap<any>('elements').set(e.id, e);
    check(readElements(doc));
  });
});
