import {
  findLiveBlocks,
  isLiveBlockNodeType,
  pageContainsBlock,
  replaceLiveBlockIds,
} from './page-content.util';

const A = '0193c7a0-1111-7abc-8def-00000000000a';
const B = '0193c7a0-1111-7abc-8def-00000000000b';
const C = '0193c7a0-1111-7abc-8def-00000000000c';

const content = {
  type: 'doc',
  content: [
    { type: 'whiteboard', attrs: { blockId: A, title: 'Plan', height: 400 } },
    {
      type: 'columns',
      content: [
        {
          type: 'column',
          content: [{ type: 'todoBoard', attrs: { blockId: B, title: null } }],
        },
      ],
    },
    {
      type: 'tabs',
      content: [
        {
          type: 'tabItem',
          content: [
            { type: 'sheet', attrs: { blockId: C, title: 'Budget' } },
            { type: 'whiteboard', attrs: { blockId: null } },
            { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
          ],
        },
      ],
    },
  ],
};

describe('page-content.util', () => {
  it('findLiveBlocks finds blocks nested in columns and tabs', () => {
    expect(findLiveBlocks(content)).toEqual([
      { blockId: A, kind: 'whiteboard', title: 'Plan' },
      { blockId: B, kind: 'todo', title: null },
      { blockId: C, kind: 'sheet', title: 'Budget' },
    ]);
  });

  it('findLiveBlocks tolerates junk', () => {
    expect(findLiveBlocks(null)).toEqual([]);
    expect(findLiveBlocks('x')).toEqual([]);
    expect(
      findLiveBlocks({ content: [null, 5, { type: 'whiteboard' }] }),
    ).toEqual([]);
  });

  it('pageContainsBlock', () => {
    expect(pageContainsBlock(content, B)).toBe(true);
    expect(
      pageContainsBlock(content, '0193c7a0-1111-7abc-8def-0000000000ff'),
    ).toBe(false);
  });

  it('replaceLiveBlockIds rewrites blockId and leaves the input untouched', () => {
    const before = JSON.stringify(content);
    const out: any = replaceLiveBlockIds(
      content,
      new Map([
        [A, 'new-a'],
        [C, 'new-c'],
      ]),
    );
    expect(JSON.stringify(content)).toBe(before);
    expect(findLiveBlocks(out).map((b) => b.blockId)).toEqual([
      'new-a',
      B,
      'new-c',
    ]);
    expect(out.content[0].attrs).toEqual({
      blockId: 'new-a',
      title: 'Plan',
      height: 400,
    });
  });

  it('isLiveBlockNodeType knows the three block nodes and nothing inherited', () => {
    expect(
      ['whiteboard', 'todoBoard', 'sheet'].map(isLiveBlockNodeType),
    ).toEqual([true, true, true]);
    for (const name of ['paragraph', 'toString', 'constructor', undefined]) {
      expect(isLiveBlockNodeType(name)).toBe(false);
    }
    expect(
      findLiveBlocks({
        type: 'doc',
        content: [{ type: 'toString', attrs: { blockId: A } }],
      }),
    ).toEqual([]);
  });
});
