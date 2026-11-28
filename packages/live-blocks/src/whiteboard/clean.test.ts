import { describe, expect, it } from 'vitest';
import { cleanElements, sanitizeElements } from './safety';

const shape = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  version: 1,
  ...extra,
});

describe('cleanElements', () => {
  it('drops or repairs offending elements and says what it removed and why', () => {
    const { elements, removed } = cleanElements([
      shape('ok'),
      shape('bare', { link: 'example.com/page' }),
      shape('js', { link: 'javascript:alert(1)' }),
      shape('frame', {
        type: 'iframe',
        customData: { generationData: { html: 'x' } },
      }),
      shape('magic', { type: 'magicframe' }),
      shape('embed', {
        type: 'embeddable',
        link: 'https://gist.github.com/a/b',
      }),
      shape('video', {
        type: 'embeddable',
        link: 'https://youtu.be/dQw4w9WgXcQ',
      }),
      shape('ok', { x: 5 }),
      shape('custom', { customData: { anything: 1 } }),
      { nope: true } as any,
    ]);
    expect(elements.map((e) => e.id)).toEqual([
      'ok',
      'bare',
      'js',
      'embed',
      'video',
      'custom',
    ]);
    const byId = Object.fromEntries(elements.map((e) => [e.id, e]));
    expect(byId.ok.x).toBe(0);
    expect(byId.bare.link).toBe('https://example.com/page');
    expect(byId.js.link).toBeNull();
    expect(byId.embed).toMatchObject({ type: 'rectangle', link: null });
    expect(byId.video.link).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(byId.custom.customData).toBeUndefined();
    expect(removed).toEqual([
      { id: 'js', reason: 'link removed: not http, https or mailto' },
      { id: 'frame', reason: 'dropped: element type iframe is not allowed' },
      {
        id: 'magic',
        reason: 'dropped: element type magicframe is not allowed',
      },
      {
        id: 'embed',
        reason:
          'embed replaced by a plain rectangle: not a YouTube, Vimeo or Figma link',
      },
      { id: 'ok', reason: 'dropped: repeated element id' },
      { id: null, reason: 'dropped: not an element with a string id' },
    ]);
  });

  it('sanitizeElements still returns only the elements', () => {
    expect(
      sanitizeElements([shape('a'), shape('b', { type: 'iframe' }) as any]).map(
        (e) => e.id,
      ),
    ).toEqual(['a']);
  });
});
