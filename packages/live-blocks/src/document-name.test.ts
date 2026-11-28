import { describe, expect, it } from 'vitest';
import { blockDocumentName, parseDocumentName } from './document-name';

describe('parseDocumentName', () => {
  it('parses a lower-case block name', () =>
    expect(
      parseDocumentName('block.0193c7a0-1111-7abc-8def-000000000001'),
    ).toEqual({ type: 'block', id: '0193c7a0-1111-7abc-8def-000000000001' }));

  it('refuses block names that are not exactly block.<uuid>', () => {
    for (const n of [
      'block.x',
      'block.0193C7A0-1111-7ABC-8DEF-000000000001',
      'block.0193c7a0-1111-7abc-8def-000000000001.x',
      'block.',
      'block..x',
    ])
      expect(parseDocumentName(n)).toEqual({ type: 'invalid' });
  });

  it('treats every other name exactly as getPageId does today', () => {
    expect(parseDocumentName('page.0193-bb')).toEqual({
      type: 'page',
      id: '0193-bb',
    });
    expect(parseDocumentName('anything.x.y')).toEqual({
      type: 'page',
      id: 'x',
    });
  });

  it('blockDocumentName lower-cases the id', () =>
    expect(blockDocumentName('0193C7A0-1111-7ABC-8DEF-000000000001')).toBe(
      'block.0193c7a0-1111-7abc-8def-000000000001',
    ));
});
