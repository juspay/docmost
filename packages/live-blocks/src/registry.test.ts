import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  isRegisteredKind,
  kindDefinition,
  registerKind,
  registeredKinds,
  KindDefinition,
} from './registry';
import { LiveBlockInputError } from './snapshot';
import { applyOps } from './ops';

const fakeSheet: KindDefinition = {
  kind: 'sheet',
  empty: () => ({ kind: 'sheet' }),
  build: () => ({ kind: 'sheet' }),
  seed: () => {},
  validate: () => ({ kind: 'sheet' }),
  staticNodes: () => [],
  applyOp: (doc, op) => {
    doc.getMap('m').set(op.type, true);
  },
};

describe('registry', () => {
  it('kindDefinition throws LiveBlockInputError for an unregistered kind', () => {
    expect(() => kindDefinition('todo')).toThrow(LiveBlockInputError);
    expect(() => kindDefinition('nope' as any)).toThrow(LiveBlockInputError);
  });

  it('registerKind refuses a second registration of the same kind', () => {
    registerKind(fakeSheet);
    expect(kindDefinition('sheet')).toBe(fakeSheet);
    expect(registeredKinds()).toContain('sheet');
    expect(isRegisteredKind('sheet')).toBe(true);
    expect(isRegisteredKind('todo')).toBe(false);
    expect(isRegisteredKind(42)).toBe(false);
    expect(() => registerKind(fakeSheet)).toThrow();
  });

  it('applyOps applies every op in one transaction', () => {
    const doc = new Y.Doc();
    let transactions = 0;
    doc.on('afterTransaction', () => transactions++);
    applyOps('sheet', doc, [{ type: 'a' }, { type: 'b' }]);
    expect(transactions).toBe(1);
    expect(doc.getMap('m').toJSON()).toEqual({ a: true, b: true });
  });
});
