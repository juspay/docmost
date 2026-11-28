import { Logger } from '@nestjs/common';
import { isRegisteredKind } from '@docmost/live-blocks';
import { inlineLiveBlocks } from './live-block-export.util';

// every kind may be registered; the "not registered" case is made explicitly
jest.mock('@docmost/live-blocks', () => {
  const actual = jest.requireActual('@docmost/live-blocks');
  return { ...actual, isRegisteredKind: jest.fn(actual.isRegisteredKind) };
});
import { LiveBlockService } from './live-block.service';

const A = '0193c7a0-1111-7abc-8def-00000000000a';
const B = '0193c7a0-1111-7abc-8def-00000000000b';
const empty = { kind: 'whiteboard', elements: [], files: {} } as any;

const page = (content: any[]) => ({ type: 'doc', content });
const board = (blockId: string, attrs: any = {}) => ({
  type: 'whiteboard',
  attrs: { blockId, title: 'Plan', src: null, ...attrs },
});

describe('inlineLiveBlocks', () => {
  it('inlineLiveBlocks replaces a whiteboard node with its preview image', () => {
    const input = page([
      { type: 'paragraph' },
      {
        type: 'columns',
        content: [
          {
            type: 'column',
            content: [board(A, { src: '/api/files/p1/preview.svg' })],
          },
        ],
      },
    ]);
    const out: any = inlineLiveBlocks(
      input,
      new Map([[A, empty]]),
      (_id, attrs: any) => ({
        title: attrs.title,
        previewSrc: attrs.src ?? undefined,
      }),
    );
    expect(out.content[1].content[0].content).toEqual([
      {
        type: 'image',
        attrs: { src: '/api/files/p1/preview.svg', alt: 'Plan' },
      },
    ]);
    expect(input.content[1].content[0].content[0].type).toBe('whiteboard');
  });

  it('inlineLiveBlocks falls back to a titled link when there is no preview', () => {
    const out: any = inlineLiveBlocks(
      page([board(B)]),
      new Map([[B, empty]]),
      (id) => ({
        title: 'Plan',
        openUrl: `https://docs.example/p/slug?block=${id}`,
      }),
    );
    expect(out.content).toEqual([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Whiteboard: Plan',
            marks: [
              {
                type: 'link',
                attrs: { href: `https://docs.example/p/slug?block=${B}` },
              },
            ],
          },
        ],
      },
    ]);
  });

  it('a block of a kind that is not registered becomes a titled paragraph', () => {
    (isRegisteredKind as unknown as jest.Mock).mockReturnValueOnce(false);
    const out: any = inlineLiveBlocks(
      page([{ type: 'sheet', attrs: { blockId: A, title: 'Budget' } }]),
      new Map(),
      () => ({ title: 'Budget' }),
    );
    expect(out.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Budget' }] },
    ]);
  });

  it('inlineLiveBlocks leaves pages without live blocks unchanged', () => {
    const input = page([
      { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
      { type: 'image', attrs: { src: '/x.png' } },
    ]);
    expect(inlineLiveBlocks(input, new Map(), () => ({ title: '' }))).toEqual(
      input,
    );
  });
});

describe('LiveBlockService.inlineForExport', () => {
  function makeService(flush: jest.Mock) {
    const liveBlockRepo = {
      findByPageIds: jest.fn(async () => [
        { id: A, kind: 'whiteboard', pageId: 'page-1', snapshot: null },
      ]),
    };
    const service = new LiveBlockService(
      liveBlockRepo as any,
      {} as any,
      {} as any,
      {} as any,
      { flush } as any,
      {} as any,
      {} as any,
      {} as any, // WhiteboardFilesService
      {} as any, // ModuleRef
    );
    return { service, liveBlockRepo };
  }

  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  it('flushes the page blocks, then renders them', async () => {
    const flush = jest.fn(async (ids: string[]) => ({
      flushed: ids,
      unreachable: [],
    }));
    const { service, liveBlockRepo } = makeService(flush);
    const out: any = await service.inlineForExport(
      page([board(A, { src: '/api/files/p/preview.svg' })]),
      { id: 'page-1', slugId: 'slug' } as any,
      'https://docs.example',
    );
    expect(flush).toHaveBeenCalledWith([A]);
    expect(liveBlockRepo.findByPageIds).toHaveBeenCalledWith(['page-1'], {
      includeSnapshot: true,
    });
    expect(out.content[0]).toEqual({
      type: 'image',
      attrs: { src: '/api/files/p/preview.svg', alt: 'Plan' },
    });
  });

  it('export still succeeds when a block cannot be flushed', async () => {
    for (const flush of [
      jest.fn(async (ids: string[]) => ({ flushed: [], unreachable: ids })),
      jest.fn(async () => {
        throw new Error('redis down');
      }),
    ]) {
      const { service } = makeService(flush);
      const out: any = await service.inlineForExport(
        page([board(A)]),
        { id: 'page-1', slugId: 'slug' } as any,
        'https://docs.example',
      );
      expect(out.content[0].content[0].marks[0].attrs.href).toBe(
        `https://docs.example/p/slug?block=${A}`,
      );
    }
  });
});
