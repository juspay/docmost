jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

import { getSchema } from '@tiptap/core';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { lossyNodeTypes, MARKDOWN_SAFE_NODE_TYPES } from './markdown-loss';
import { LIVE_BLOCK_NODE_KIND } from '../live-block/page-content.util';
import { canonical, roundTrip, SAMPLES } from './testing/markdown-samples';

describe('markdown loss', () => {
  it.each([...MARKDOWN_SAFE_NODE_TYPES])(
    '%s survives export to markdown and import back',
    async (type) => {
      const sample = SAMPLES[type];
      expect(sample).toBeDefined();
      const { doc } = await roundTrip(sample);
      expect(canonical(doc)).toEqual(canonical(sample));
    },
  );

  it('types known to be damaged by the round trip are not in the safe set', async () => {
    for (const type of [
      'mention',
      'image',
      'attachment',
      'underline',
      'highlight',
      'mathInline',
      'mathBlock',
      'youtube',
      'columns',
    ]) {
      const { doc } = await roundTrip(SAMPLES[type]);
      expect(canonical(doc)).not.toEqual(canonical(SAMPLES[type]));
      expect(MARKDOWN_SAFE_NODE_TYPES.has(type)).toBe(false);
    }
  });

  it('every node and mark type in tiptapExtensions is either in the safe set or reported by lossyNodeTypes', () => {
    const schema = getSchema(tiptapExtensions);
    const exempt = new Set([
      'doc',
      'text',
      'comment',
      ...Object.keys(LIVE_BLOCK_NODE_KIND),
    ]);
    const unaccounted: string[] = [];

    for (const name of Object.keys(schema.nodes)) {
      if (exempt.has(name) || MARKDOWN_SAFE_NODE_TYPES.has(name)) continue;
      const reported = lossyNodeTypes({
        type: 'doc',
        content: [{ type: name }],
      });
      if (!reported.includes(name)) unaccounted.push(name);
    }
    for (const name of Object.keys(schema.marks)) {
      if (exempt.has(name) || MARKDOWN_SAFE_NODE_TYPES.has(name)) continue;
      const reported = lossyNodeTypes({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', marks: [{ type: name }] }],
          },
        ],
      });
      if (!reported.includes(name)) unaccounted.push(name);
    }
    expect(unaccounted).toEqual([]);
    // every safe type is a real schema type
    const all = new Set([
      ...Object.keys(schema.nodes),
      ...Object.keys(schema.marks),
    ]);
    expect([...MARKDOWN_SAFE_NODE_TYPES].filter((t) => !all.has(t))).toEqual(
      [],
    );
  });

  describe('lossyNodeTypes', () => {
    const p = (...c: any[]) => ({ type: 'paragraph', content: c });
    const text = (t: string, marks?: any[]) => ({
      type: 'text',
      text: t,
      ...(marks ? { marks } : {}),
    });

    it('is empty for plain content', () => {
      expect(
        lossyNodeTypes({
          type: 'doc',
          content: [p(text('hi', [{ type: 'bold' }]))],
        }),
      ).toEqual([]);
    });

    it('names mentions, attachments and marks that markdown cannot carry', () => {
      const content = {
        type: 'doc',
        content: [
          p({ type: 'mention', attrs: {} }, text('u', [{ type: 'underline' }])),
          { type: 'attachment', attrs: {} },
        ],
      };
      expect(lossyNodeTypes(content)).toEqual([
        'attachment',
        'mention',
        'underline',
      ]);
    });

    it('does not count live blocks or comment marks', () => {
      const content = {
        type: 'doc',
        content: [
          { type: 'whiteboard', attrs: { blockId: 'b' } },
          { type: 'todoBoard', attrs: { blockId: 'c' } },
          { type: 'sheet', attrs: { blockId: 'd' } },
          p(text('x', [{ type: 'comment', attrs: { commentId: 'z' } }])),
        ],
      };
      expect(lossyNodeTypes(content)).toEqual([]);
    });

    it('copes with empty and malformed input', () => {
      expect(lossyNodeTypes(null)).toEqual([]);
      expect(lossyNodeTypes({})).toEqual([]);
    });
  });
});
