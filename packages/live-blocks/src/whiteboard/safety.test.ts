import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { LiveBlockInputError } from '../snapshot';
import { validateScene } from './schema';
import { readElements } from './ydoc';
import { isSafeEmbedLink, isSafeLink, sanitizeElements } from './safety';

const shape = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  version: 1,
  versionNonce: 0,
  ...extra,
});

// the element Excalidraw 0.18 renders as <iframe srcDoc={html} sandbox="allow-scripts …">
const scriptFrame = shape('evil', {
  type: 'iframe',
  customData: {
    generationData: { status: 'done', html: '<script>alert(1)</script>' },
  },
});

describe('whiteboard elements that could run script for viewers', () => {
  it('validateScene refuses iframe and magicframe elements', () => {
    expect(() => validateScene({ elements: [scriptFrame] })).toThrow(
      LiveBlockInputError,
    );
    expect(() =>
      validateScene({ elements: [shape('m', { type: 'magicframe' })] }),
    ).toThrow(LiveBlockInputError);
  });

  it('validateScene refuses generated HTML in custom data on any element', () => {
    expect(() =>
      validateScene({
        elements: [
          shape('a', { customData: { generationData: { html: '<b>x</b>' } } }),
        ],
      }),
    ).toThrow(LiveBlockInputError);
  });

  it('validateScene refuses javascript: and data: links on any element', () => {
    for (const link of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'data:text/html,<script>',
      'vbscript:x',
    ]) {
      expect(() => validateScene({ elements: [shape('a', { link })] })).toThrow(
        LiveBlockInputError,
      );
    }
    expect(
      validateScene({
        elements: [shape('a', { link: 'https://example.com/x' })],
      }).elements[0].link,
    ).toBe('https://example.com/x');
  });

  it('an embeddable may only show an https page from the allow-list', () => {
    expect(() =>
      validateScene({
        elements: [
          shape('e', { type: 'embeddable', link: 'https://evil.example/page' }),
        ],
      }),
    ).toThrow(LiveBlockInputError);
    expect(() =>
      validateScene({
        elements: [
          shape('e', {
            type: 'embeddable',
            link: 'http://www.youtube.com/embed/x',
          }),
        ],
      }),
    ).toThrow(LiveBlockInputError);
    expect(
      validateScene({
        elements: [
          shape('e', {
            type: 'embeddable',
            link: 'https://youtu.be/dQw4w9WgXcQ?t=5&feature=share',
          }),
        ],
      }).elements[0].link,
    ).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=5');
    expect(isSafeEmbedLink('https://player.vimeo.com/video/1')).toBe(true);
    expect(isSafeEmbedLink('https://youtube.com.evil.example/x')).toBe(false);
  });

  it('an old or malicious stored document cannot bypass the check on read', () => {
    const doc = new Y.Doc();
    const map = doc.getMap<any>('elements');
    map.set('evil', scriptFrame);
    map.set(
      'embed',
      shape('embed', { type: 'embeddable', link: 'https://evil.example/' }),
    );
    map.set(
      'linked',
      shape('linked', {
        link: 'javascript:alert(1)',
        customData: { generationData: { html: 'x' } },
      }),
    );
    map.set('ok', shape('ok', { link: 'https://example.com' }));
    const read = readElements(doc);
    expect(read.map((e) => e.id).sort()).toEqual(['linked', 'ok']);
    const linked = read.find((e) => e.id === 'linked')!;
    expect(linked.link).toBeNull();
    expect(linked.customData).toBeUndefined();
    // the same check for a snapshot that reaches a viewer
    expect(
      sanitizeElements([scriptFrame as any, shape('ok') as any]).map(
        (e) => e.id,
      ),
    ).toEqual(['ok']);
  });
});

describe('links that look in-app but leave the site', () => {
  it('refuses //, /\\, \\\\, /%5c and tab tricks', () => {
    for (const link of [
      '//evil.com',
      '/\\evil.com',
      '\\\\evil.com',
      '\\/evil.com',
      '/%5cevil.com',
      '/%5Cevil.com',
      '/\t/evil.com',
      '/\n/evil.com',
      ' //evil.com',
    ]) {
      expect([link, isSafeLink(link)]).toEqual([link, false]);
    }
    for (const link of [
      '/s/general/p/abc',
      '?q=1',
      '#heading',
      '/files/x.png',
    ]) {
      expect([link, isSafeLink(link)]).toEqual([link, true]);
    }
  });
});
