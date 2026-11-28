import { describe, expect, it } from 'vitest';
import { connect, docWithClientId } from './sync';

describe('connect', () => {
  it('connect syncs two docs; disconnect stops it; reconnect merges what each missed', () => {
    const a = docWithClientId(1);
    const b = docWithClientId(2);
    expect(a.clientID).toBe(1);
    a.getMap('m').set('before', 1);
    const link = connect(a, b);
    expect(b.getMap('m').get('before')).toBe(1);

    b.getMap('m').set('live', 2);
    expect(a.getMap('m').get('live')).toBe(2);

    link.disconnect();
    a.getMap('m').set('fromA', 3);
    b.getMap('m').set('fromB', 4);
    expect(b.getMap('m').has('fromA')).toBe(false);
    expect(a.getMap('m').has('fromB')).toBe(false);

    link.reconnect();
    expect(a.getMap('m').toJSON()).toEqual(b.getMap('m').toJSON());
    expect(a.getMap('m').get('fromB')).toBe(4);
    expect(b.getMap('m').get('fromA')).toBe(3);

    a.getMap('m').set('after', 5);
    expect(b.getMap('m').get('after')).toBe(5);
  });
});
