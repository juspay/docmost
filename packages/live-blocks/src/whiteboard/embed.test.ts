import { describe, expect, it } from 'vitest';
import { canonicalEmbedLink, isSafeEmbedLink } from './safety';

describe('canonicalEmbedLink', () => {
  it('rewrites accepted provider links to a canonical form built from the id', () => {
    const cases: [string, string][] = [
      [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
      ],
      [
        'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42',
        'https://www.youtube.com/embed/dQw4w9WgXcQ?start=42',
      ],
      [
        'https://youtu.be/dQw4w9WgXcQ?t=1m5s',
        'https://www.youtube.com/embed/dQw4w9WgXcQ?start=65',
      ],
      [
        'https://www.youtube.com/embed/dQw4w9WgXcQ?start=30&autoplay=1',
        'https://www.youtube.com/embed/dQw4w9WgXcQ?start=30',
      ],
      [
        'https://www.youtube.com/shorts/dQw4w9WgXcQ',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
      ],
      [
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
      ],
      [
        'https://www.youtube.com/playlist?list=PLabcdefghij123',
        'https://www.youtube.com/playlist?list=PLabcdefghij123',
      ],
      ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
      [
        'https://player.vimeo.com/video/76979871?h=x#t=5',
        'https://player.vimeo.com/video/76979871',
      ],
      [
        'https://www.figma.com/design/AbCdEfGhIj1234567890/My-file?node-id=1',
        'https://www.figma.com/design/AbCdEfGhIj1234567890',
      ],
      [
        'HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
      ],
    ];
    for (const [input, canonical] of cases) {
      expect([input, canonicalEmbedLink(input)]).toEqual([input, canonical]);
      expect(isSafeEmbedLink(canonical)).toBe(true);
    }
  });

  it('refuses everything else', () => {
    for (const link of [
      // the reviewer's link: Excalidraw would pick its Twitter srcdoc embed
      'https://www.youtube.com/?twitter.com/x/status/1',
      'https://youtu.be/?twitter.com/x/status/1',
      'https://vimeo.com/?twitter.com/x/status/1',
      'https://www.youtube.com/embed/dQw4w9WgXcQ/twitter.com/x/status/1',
      'https://www.youtube.com/embed/gist.github.com',
      'https://youtube.com@evil.com/embed/dQw4w9WgXcQ',
      'https://user:pass@www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com.evil.com/embed/dQw4w9WgXcQ',
      'https://evilyoutube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com:8443/embed/dQw4w9WgXcQ',
      'http://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXc%51',
      'https://www.youtube.com/embed%2FdQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ%22',
      'https://vimeo.com/76979871abc',
      'https://www.figma.com/file/short',
      'https://www.figma.com/embed?url=https://twitter.com/x/status/1',
      'https://gist.github.com/a/b',
      'https://twitter.com/x/status/1',
      'javascript:alert(1)',
      '',
      42,
    ]) {
      expect([link, canonicalEmbedLink(link)]).toEqual([link, null]);
      expect(isSafeEmbedLink(link)).toBe(false);
    }
  });

  it('a valid link with another provider in its fragment keeps only the id', () => {
    expect(
      canonicalEmbedLink(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ#twitter.com/x/status/1',
      ),
    ).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('only a link already in canonical form passes isSafeEmbedLink', () => {
    expect(isSafeEmbedLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      false,
    );
    expect(isSafeEmbedLink('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(
      true,
    );
  });
});

describe('share links people actually copy', () => {
  it('every common share form rewrites to the canonical embed link', () => {
    const cases: [string, string][] = [
      [
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
      ],
      [
        'https://youtube.com/shorts/dQw4w9WgXcQ?feature=share',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
      ],
      [
        'https://youtu.be/dQw4w9WgXcQ?si=abc&t=90',
        'https://www.youtube.com/embed/dQw4w9WgXcQ?start=90',
      ],
      ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
      [
        'https://www.figma.com/design/AbCdEfGhIj1234567890/Title?node-id=1-2&t=x',
        'https://www.figma.com/design/AbCdEfGhIj1234567890',
      ],
    ];
    for (const [input, canonical] of cases) {
      expect([input, canonicalEmbedLink(input)]).toEqual([input, canonical]);
      expect(isSafeEmbedLink(canonical)).toBe(true);
    }
  });

  it('a playlist keeps its list in the form Excalidraw understands', () => {
    expect(
      canonicalEmbedLink(
        'https://www.youtube.com/playlist?list=PLabcdefghij123',
      ),
    ).toBe('https://www.youtube.com/playlist?list=PLabcdefghij123');
    expect(
      canonicalEmbedLink(
        'https://www.youtube.com/embed/videoseries?list=PLabcdefghij123',
      ),
    ).toBe('https://www.youtube.com/playlist?list=PLabcdefghij123');
  });

  it('other providers named inside an m.youtube.com or nocookie link do not survive', () => {
    for (const link of [
      'https://m.youtube.com/?x.com/a/status/1',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&u=x.com/a/status/1',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?x.com/a/status/1',
    ]) {
      const c = canonicalEmbedLink(link);
      expect(c === null || !/x\.com|twitter/.test(c)).toBe(true);
    }
  });
});
