jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { CollaborationHandler } from './collaboration.handler';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';

const p = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const block = (type: string, blockId: string) => ({
  type,
  attrs: { blockId, title: `${type} ${blockId}`, height: 320 },
});

// An in-memory stand-in for Hocuspocus: one document, direct connections only.
function fakeHocuspocus(doc: Y.Doc) {
  return {
    documents: new Map(),
    debouncer: { executeNow: jest.fn() },
    openDirectConnection: async () => ({
      transact: async (fn: (d: Y.Doc) => void) => doc.transact(() => fn(doc)),
      disconnect: async () => undefined,
    }),
  } as any;
}

function seed(...nodes: any[]) {
  const doc = new Y.Doc();
  doc.getXmlFragment('default').insert(0, nodes.map(prosemirrorNodeToYElement));
  return doc;
}

// the plain text inside a node, without its markup
const textOf = (node: Y.XmlElement | Y.XmlText): string =>
  node instanceof Y.XmlText
    ? node
        .toDelta()
        .map((op: { insert?: unknown }) =>
          typeof op.insert === 'string' ? op.insert : '',
        )
        .join('')
    : node
        .toArray()
        .map((child) =>
          child instanceof Y.XmlElement || child instanceof Y.XmlText
            ? textOf(child)
            : '',
        )
        .join('');

const read = (doc: Y.Doc) => {
  const out: { type: string; attrs?: any; text?: string }[] = [];
  doc.getXmlFragment('default').forEach((n) => {
    if (n instanceof Y.XmlElement) {
      out.push({
        type: n.nodeName,
        attrs: n.getAttributes(),
        text: textOf(n),
      });
    }
  });
  return out;
};

describe('replacePageContentKeepingLiveBlocks', () => {
  const user = { id: 'u1' } as any;
  const handlers = (doc: Y.Doc) =>
    new CollaborationHandler().getHandlers(fakeHocuspocus(doc));
  const replacement = (...paragraphs: string[]) => ({
    type: 'doc',
    content: paragraphs.map(p),
  });

  it('replaces the text and keeps every live block, in order', async () => {
    const doc = seed(
      p('old one'),
      block('whiteboard', 'w1'),
      p('old two'),
      block('todoBoard', 't1'),
      block('sheet', 's1'),
    );
    const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
      'page.x',
      {
        prosemirrorJson: replacement('new one', 'new two'),
        user,
      },
    );

    // none was in the incoming content, so all three are added at the end
    expect(res).toEqual({
      keptBlocks: 0,
      appendedBlocks: 3,
      removedBlocks: 0,
      removedBlockIds: [],
      refusedLossy: [],
    });
    const nodes = read(doc);
    expect(nodes.map((n) => n.type)).toEqual([
      'paragraph',
      'paragraph',
      'whiteboard',
      'todoBoard',
      'sheet',
    ]);
    expect(nodes.slice(0, 2).map((n) => n.text)).toEqual([
      'new one',
      'new two',
    ]);
    expect(nodes[2].attrs).toEqual({
      blockId: 'w1',
      title: 'whiteboard w1',
      height: 320,
    });
    expect(nodes.map((n) => n.text).join('')).not.toContain('old');
  });

  it('keeps a block that exists only in the open document, not in any stored copy', async () => {
    // the stored page knows nothing of this block: it lives only in the Yjs doc
    const stored = { type: 'doc', content: [p('saved text')] };
    const live = TiptapTransformer.toYdoc(stored, 'default', tiptapExtensions);
    live
      .getXmlFragment('default')
      .insert(1, [prosemirrorNodeToYElement(block('whiteboard', 'fresh'))]);

    const res = await handlers(live).replacePageContentKeepingLiveBlocks(
      'page.x',
      {
        prosemirrorJson: replacement('rewritten'),
        user,
      },
    );

    expect(res.appendedBlocks).toBe(1);
    expect(
      read(live)
        .map((n) => n.attrs?.blockId)
        .filter(Boolean),
    ).toEqual(['fresh']);
  });

  it('finds a block nested inside another node', async () => {
    const doc = seed({
      type: 'blockquote',
      content: [p('quoted'), block('sheet', 'inner')],
    });
    const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
      'page.x',
      {
        prosemirrorJson: replacement('after'),
        user,
      },
    );
    expect(res.appendedBlocks).toBe(1);
    expect(read(doc).map((n) => n.type)).toEqual(['paragraph', 'sheet']);
  });

  it('is a plain replace on a page with no live blocks', async () => {
    const doc = seed(p('a'), p('b'));
    const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
      'page.x',
      {
        prosemirrorJson: replacement('only'),
        user,
      },
    );
    expect(res).toEqual({
      keptBlocks: 0,
      appendedBlocks: 0,
      removedBlocks: 0,
      removedBlockIds: [],
      refusedLossy: [],
    });
    expect(read(doc).map((n) => n.text)).toEqual(['only']);
  });

  it('does not duplicate a live block that arrives in the incoming content', async () => {
    const doc = seed(p('old'), block('whiteboard', 'w1'));
    const incoming = {
      type: 'doc',
      content: [
        p('new'),
        block('whiteboard', 'w1'),
        { type: 'blockquote', content: [block('sheet', 'copy')] },
      ],
    };
    const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
      'page.x',
      {
        prosemirrorJson: incoming,
        user,
      },
    );
    expect(res.keptBlocks).toBe(1);
    expect(
      read(doc)
        .filter((n) => n.attrs?.blockId)
        .map((n) => n.attrs.blockId),
    ).toEqual(['w1']);
  });

  describe('blocks placed by the incoming content', () => {
    // what an agent sends back: its own attrs, possibly stale or edited
    const placeholder = (type: string, blockId: string) => ({
      type,
      attrs: { blockId, title: 'edited by the agent' },
    });
    const ids = (doc: Y.Doc) =>
      read(doc).map((n) => n.attrs?.blockId ?? n.text);

    it('keeps each kind in place, with the attributes of the live copy', async () => {
      const doc = seed(
        p('Intro'),
        block('whiteboard', 'w1'),
        block('todoBoard', 't1'),
        block('sheet', 's1'),
        p('End'),
      );
      const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
        'page.x',
        {
          prosemirrorJson: {
            type: 'doc',
            content: [
              p('Intro, rewritten'),
              placeholder('sheet', 's1'),
              p('Middle'),
              placeholder('whiteboard', 'w1'),
              placeholder('todoBoard', 't1'),
              p('End, rewritten'),
            ],
          },
          user,
        },
      );
      expect(res).toEqual({
        keptBlocks: 3,
        appendedBlocks: 0,
        removedBlocks: 0,
        removedBlockIds: [],
        refusedLossy: [],
      });
      expect(ids(doc)).toEqual([
        'Intro, rewritten',
        's1',
        'Middle',
        'w1',
        't1',
        'End, rewritten',
      ]);
      const nodes = read(doc);
      expect(nodes[1]).toEqual(
        expect.objectContaining({
          type: 'sheet',
          attrs: { blockId: 's1', title: 'sheet s1', height: 320 },
        }),
      );
      expect(nodes[3].attrs.title).toBe('whiteboard w1');
      expect(nodes[4].attrs.title).toBe('todoBoard t1');
    });

    it('keeps the first of two placeholders for one block and drops the rest', async () => {
      const doc = seed(p('a'), block('sheet', 's1'));
      const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
        'page.x',
        {
          prosemirrorJson: {
            type: 'doc',
            content: [
              placeholder('sheet', 's1'),
              p('between'),
              placeholder('sheet', 's1'),
            ],
          },
          user,
        },
      );
      expect(res.keptBlocks).toBe(1);
      expect(ids(doc)).toEqual(['s1', 'between']);
    });

    it('drops a block id that is not in the open document, and one whose kind differs', async () => {
      const doc = seed(p('a'), block('sheet', 's1'));
      await handlers(doc).replacePageContentKeepingLiveBlocks('page.x', {
        prosemirrorJson: {
          type: 'doc',
          content: [
            placeholder('whiteboard', 'foreign'),
            p('text'),
            placeholder('whiteboard', 's1'),
            placeholder('sheet', 's1'),
          ],
        },
        user,
      });
      expect(ids(doc)).toEqual(['text', 's1']);
      expect(read(doc)[1].type).toBe('sheet');
    });

    it('appends a block missing from the incoming content, by default', async () => {
      const doc = seed(block('whiteboard', 'w1'), p('a'), block('sheet', 's1'));
      const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
        'page.x',
        {
          prosemirrorJson: {
            type: 'doc',
            content: [p('new'), placeholder('sheet', 's1')],
          },
          user,
        },
      );
      expect(res).toEqual(
        expect.objectContaining({
          keptBlocks: 1,
          appendedBlocks: 1,
          removedBlocks: 0,
        }),
      );
      expect(ids(doc)).toEqual(['new', 's1', 'w1']);
    });

    it('removes a missing block only when it is named', async () => {
      const doc = seed(
        block('whiteboard', 'w1'),
        p('a'),
        block('todoBoard', 't1'),
        block('sheet', 's1'),
      );
      const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
        'page.x',
        {
          prosemirrorJson: {
            type: 'doc',
            content: [p('new'), placeholder('sheet', 's1')],
          },
          user,
          removeBlockIds: ['w1'],
        },
      );
      expect(res).toEqual(
        expect.objectContaining({
          keptBlocks: 1,
          appendedBlocks: 1,
          removedBlocks: 1,
          removedBlockIds: ['w1'],
        }),
      );
      // t1 was missing too, but not named: it is kept, at the end
      expect(ids(doc)).toEqual(['new', 's1', 't1']);
    });

    it('never removes a named block whose placeholder is still there', async () => {
      const doc = seed(p('a'), block('sheet', 's1'));
      const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
        'page.x',
        {
          prosemirrorJson: {
            type: 'doc',
            content: [p('new'), placeholder('sheet', 's1')],
          },
          user,
          removeBlockIds: ['s1'],
        },
      );
      expect(res.removedBlocks).toBe(0);
      expect(ids(doc)).toEqual(['new', 's1']);
    });

    it('never removes a block a person added after the read, even with other ids named', async () => {
      const doc = seed(p('a'), block('sheet', 's1'), block('todoBoard', 't1'));
      doc
        .getXmlFragment('default')
        .insert(0, [prosemirrorNodeToYElement(block('whiteboard', 'late'))]);
      const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
        'page.x',
        {
          prosemirrorJson: {
            type: 'doc',
            content: [p('new'), placeholder('sheet', 's1')],
          },
          user,
          removeBlockIds: ['t1'],
        },
      );
      expect(res.removedBlockIds).toEqual(['t1']);
      expect(ids(doc)).toEqual(['new', 's1', 'late']);
    });

    it('appends a block added to the open document after the agent read the page', async () => {
      const doc = seed(p('a'), block('sheet', 's1'));
      // someone inserts a board after the agent's read; its placeholder cannot be there
      doc
        .getXmlFragment('default')
        .insert(0, [prosemirrorNodeToYElement(block('todoBoard', 'late'))]);
      const res = await handlers(doc).replacePageContentKeepingLiveBlocks(
        'page.x',
        {
          prosemirrorJson: {
            type: 'doc',
            content: [p('new'), placeholder('sheet', 's1')],
          },
          user,
        },
      );
      expect(res.keptBlocks).toBe(1);
      expect(res.appendedBlocks).toBe(1);
      expect(ids(doc)).toEqual(['new', 's1', 'late']);
    });
  });

  it('refuses lossy content found in the live document, and writes nothing', async () => {
    const doc = seed(p('hi'), {
      type: 'paragraph',
      content: [{ type: 'mention', attrs: { id: 'm', label: 'Bob' } }],
    });
    const h = handlers(doc);
    const refused = await h.replacePageContentKeepingLiveBlocks('page.x', {
      prosemirrorJson: replacement('new'),
      user,
    });
    expect(refused.refusedLossy).toEqual(['mention']);
    expect(
      read(doc)
        .map((n) => n.text)
        .join(''),
    ).toContain('hi');

    const forced = await h.replacePageContentKeepingLiveBlocks('page.x', {
      prosemirrorJson: replacement('new'),
      user,
      allowLossy: true,
    });
    expect(forced.refusedLossy).toEqual([]);
    expect(read(doc).map((n) => n.text)).toEqual(['new']);
  });
});
