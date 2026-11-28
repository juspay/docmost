// the real export path imports an ESM-only package
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

import * as Y from 'yjs';
import { ServiceUnavailableException } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from '../../../collaboration/collaboration.util';
import { buildTools } from '../tool-registry';
import { ALICE, buildWorld, PAGES } from '../testing/tool-fixtures';

const SHEET = '0193c7a0-4444-7abc-8def-000000000001';

let world: ReturnType<typeof buildWorld>;
let tools: Record<string, ReturnType<typeof buildTools>[number]>;

beforeEach(() => {
  world = buildWorld();
  tools = Object.fromEntries(buildTools(world.deps).map((t) => [t.name, t]));
});

const run = (name: string, args: any) =>
  tools[name].run(
    tools[name].input.parse(args),
    world.ctx('write', ALICE),
  ) as Promise<any>;

const para = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

function pageWithSheet() {
  world.blocks.add({
    id: SHEET,
    kind: 'sheet',
    pageId: PAGES.open,
    inContent: false,
  });
  world.pages.find((p) => p.id === PAGES.open)!.content = {
    type: 'doc',
    content: [
      para('Intro'),
      { type: 'sheet', attrs: { blockId: SHEET, title: 'Costs', height: 320 } },
      para('Analysis'),
    ],
  };
}

describe('get_page_markdown and live blocks', () => {
  it('writes each live block as one placeholder line in its place, not a static copy', async () => {
    pageWithSheet();
    const out = await run('get_page_markdown', { page_id: PAGES.open });
    const lines = out.markdown.split('\n').filter((l: string) => l.trim());
    expect(lines).toEqual([
      'Intro',
      `<div data-type="sheet" data-block-id="${SHEET}" data-title="Costs">Spreadsheet: a live block, kept as it is. Move or delete this line; do not edit it.</div>`,
      'Analysis',
    ]);
    // no table, no "Spreadsheet: Costs" text from the static export
    expect(out.markdown).not.toMatch(/\|/);
  });

  it('the placeholder parses back into the same block node', async () => {
    pageWithSheet();
    const { markdown } = await run('get_page_markdown', {
      page_id: PAGES.open,
    });
    const json = await (world.deps.pageService as any).parseProsemirrorContent(
      markdown,
      'markdown',
    );
    expect(json.content.map((n: any) => n.type)).toEqual([
      'paragraph',
      'sheet',
      'paragraph',
    ]);
    expect(json.content[1].attrs).toEqual(
      expect.objectContaining({ blockId: SHEET, title: 'Costs' }),
    );
  });
});

describe('get_page_markdown then update_page_markdown', () => {
  const WB = '0193c7a0-4444-7abc-8def-000000000002';
  const TODO = '0193c7a0-4444-7abc-8def-000000000003';

  // the open document starts as the stored page; after a write the stored
  // page follows the document, as the sync server's store does
  const openDoc = () => {
    const page = world.pages.find((p) => p.id === PAGES.open)!;
    const doc = world.ydocFor(`page.${PAGES.open}`);
    Y.applyUpdate(
      doc,
      Y.encodeStateAsUpdate(
        TiptapTransformer.toYdoc(page.content, 'default', tiptapExtensions),
      ),
    );
  };
  const store = () => {
    const page = world.pages.find((p) => p.id === PAGES.open)!;
    page.content = TiptapTransformer.fromYdoc(
      world.ydocFor(`page.${PAGES.open}`),
      'default',
    );
  };
  const shape = () =>
    world.pages
      .find((p) => p.id === PAGES.open)!
      .content.content.map((n: any) =>
        n.attrs?.blockId
          ? `${n.type}:${n.attrs.blockId}`
          : (n.content ?? []).map((t: any) => t.text).join(''),
      );

  it('three round trips of Intro / [sheet] / Analysis leave exactly one sheet between them', async () => {
    pageWithSheet();
    openDoc();
    for (let i = 1; i <= 3; i++) {
      const { markdown } = await run('get_page_markdown', {
        page_id: PAGES.open,
      });
      const out = await run('update_page_markdown', {
        page_id: PAGES.open,
        content: markdown.replace(/Intro[^\n]*/, `Intro, edit ${i}`),
      });
      expect(out.live_blocks).toEqual({
        kept_in_place: 1,
        appended_at_end: 0,
        removed: 0,
      });
      store();
    }
    expect(shape()).toEqual(['Intro, edit 3', `sheet:${SHEET}`, 'Analysis']);
  });

  it('keeps a whiteboard, a to-do board and a sheet live and in place after a text edit', async () => {
    world.blocks.add({
      id: WB,
      kind: 'whiteboard',
      pageId: PAGES.open,
      inContent: false,
    });
    world.blocks.add({
      id: TODO,
      kind: 'todo',
      pageId: PAGES.open,
      inContent: false,
    });
    world.blocks.add({
      id: SHEET,
      kind: 'sheet',
      pageId: PAGES.open,
      inContent: false,
    });
    world.pages.find((p) => p.id === PAGES.open)!.content = {
      type: 'doc',
      content: [
        para('One'),
        {
          type: 'whiteboard',
          attrs: {
            blockId: WB,
            title: 'Board',
            src: '/api/files/x/preview.png',
          },
        },
        para('Two'),
        {
          type: 'todoBoard',
          attrs: { blockId: TODO, title: 'Tasks', height: 480 },
        },
        para('Three'),
        { type: 'sheet', attrs: { blockId: SHEET, title: 'Costs' } },
      ],
    };
    openDoc();
    const { markdown } = await run('get_page_markdown', {
      page_id: PAGES.open,
    });
    await run('update_page_markdown', {
      page_id: PAGES.open,
      content: markdown.replace('Two', 'Two, edited'),
    });
    store();
    expect(shape()).toEqual([
      'One',
      `whiteboard:${WB}`,
      'Two, edited',
      `todoBoard:${TODO}`,
      'Three',
      `sheet:${SHEET}`,
    ]);
    // the attributes come from the live document, not from the placeholder
    const wb = world.pages
      .find((p) => p.id === PAGES.open)!
      .content.content.find((n: any) => n.type === 'whiteboard');
    expect(wb.attrs.src).toBe('/api/files/x/preview.png');
  });

  it('refuses a placeholder naming a block that is not on this page', async () => {
    pageWithSheet();
    openDoc();
    // a real block, but of another page
    world.blocks.add({
      id: WB,
      kind: 'whiteboard',
      pageId: PAGES.child,
      inContent: false,
    });
    for (const id of [WB, '0193c7a0-4444-7abc-8def-0000000000ff']) {
      await expect(
        run('update_page_markdown', {
          page_id: PAGES.open,
          content: `Intro\n\n<div data-type="whiteboard" data-block-id="${id}"></div>\n`,
        }),
      ).rejects.toThrow(new RegExp(`block ${id} .*not on this page`));
    }
    // nothing was written
    expect(
      world.ydocFor(`page.${PAGES.open}`).getXmlFragment('default').toString(),
    ).toContain(SHEET);
  });

  it('a deleted placeholder keeps the block at the end unless its id is named in remove_live_block_ids', async () => {
    pageWithSheet();
    openDoc();
    const kept = await run('update_page_markdown', {
      page_id: PAGES.open,
      content: 'Intro\n\nAnalysis',
    });
    expect(kept.live_blocks).toEqual({
      kept_in_place: 0,
      appended_at_end: 1,
      removed: 0,
    });
    expect(kept.live_blocks_note).toMatch(/1 live block .*added at the end/);
    store();
    expect(shape()).toEqual(['Intro', 'Analysis', `sheet:${SHEET}`]);

    const removed = await run('update_page_markdown', {
      page_id: PAGES.open,
      content: 'Intro\n\nAnalysis',
      remove_live_block_ids: [SHEET],
    });
    expect(removed.live_blocks).toEqual({
      kept_in_place: 0,
      appended_at_end: 0,
      removed: 1,
    });
    expect(removed.live_blocks_note).toContain(`removed: ${SHEET}`);
    store();
    expect(shape()).toEqual(['Intro', 'Analysis']);
  });

  it('refuses to remove a block whose placeholder is still in the content, or that is not on this page, and writes nothing', async () => {
    pageWithSheet();
    openDoc();
    const { markdown } = await run('get_page_markdown', {
      page_id: PAGES.open,
    });
    const before = world
      .ydocFor(`page.${PAGES.open}`)
      .getXmlFragment('default')
      .toString();
    await expect(
      run('update_page_markdown', {
        page_id: PAGES.open,
        content: markdown,
        remove_live_block_ids: [SHEET],
      }),
    ).rejects.toThrow(new RegExp(`${SHEET} is still in the content`));
    const other = '0193c7a0-4444-7abc-8def-0000000000ee';
    world.blocks.add({
      id: other,
      kind: 'sheet',
      pageId: PAGES.child,
      inContent: false,
    });
    for (const id of [other, '0193c7a0-4444-7abc-8def-0000000000ff']) {
      await expect(
        run('update_page_markdown', {
          page_id: PAGES.open,
          content: 'Intro',
          remove_live_block_ids: [id],
        }),
      ).rejects.toThrow(new RegExp(`${id} is not a live block of this page`));
    }
    expect(
      world.ydocFor(`page.${PAGES.open}`).getXmlFragment('default').toString(),
    ).toBe(before);
  });

  it('a block a person added after the read is appended, never removed, when other ids are named', async () => {
    pageWithSheet();
    openDoc();
    const { markdown } = await run('get_page_markdown', {
      page_id: PAGES.open,
    });
    // a person adds a to-do board after the agent's read
    const LATE = '0193c7a0-4444-7abc-8def-0000000000aa';
    world.blocks.add({
      id: LATE,
      kind: 'todo',
      pageId: PAGES.open,
      inContent: false,
    });
    world
      .ydocFor(`page.${PAGES.open}`)
      .getXmlFragment('default')
      .insert(0, [
        prosemirrorNodeToYElement({
          type: 'todoBoard',
          attrs: { blockId: LATE, title: 'Late' },
        }),
      ]);
    const out = await run('update_page_markdown', {
      page_id: PAGES.open,
      content: markdown.replace(/<div[^\n]*\n?/, ''),
      remove_live_block_ids: [SHEET],
    });
    expect(out.live_blocks).toEqual({
      kept_in_place: 0,
      appended_at_end: 1,
      removed: 1,
    });
    store();
    expect(shape()).toEqual(['Intro', 'Analysis', `todoBoard:${LATE}`]);
  });

  it('get_page_markdown stores the open document first, so it reads what the write will compare against', async () => {
    pageWithSheet();
    await run('get_page_markdown', { page_id: PAGES.open });
    expect(world.calls.flushed).toContain(`page.${PAGES.open}`);
  });
});

describe('update_page_markdown placeholder check', () => {
  it('loads the page’s blocks once, whatever the number of placeholders', async () => {
    pageWithSheet();
    const { markdown } = await run('get_page_markdown', {
      page_id: PAGES.open,
    });
    const line = markdown.split('\n').find((l: string) => l.startsWith('<div'));
    const repo = world.deps.liveBlockRepo as any;
    const byId = jest.spyOn(repo, 'findById');
    const byPage = jest.spyOn(repo, 'findByPageIds');
    await run('update_page_markdown', {
      page_id: PAGES.open,
      content: `Intro\n\n${Array(40).fill(line).join('\n\n')}`,
    });
    expect(byId).not.toHaveBeenCalled();
    expect(byPage).toHaveBeenCalledTimes(1);
  });

  it('refuses more than 500 distinct placeholders', async () => {
    pageWithSheet();
    const lines = Array.from(
      { length: 501 },
      (_, i) =>
        `<div data-type="sheet" data-block-id="0193c7a0-5555-7abc-8def-${String(i).padStart(12, '0')}"></div>`,
    );
    await expect(
      run('update_page_markdown', {
        page_id: PAGES.open,
        content: lines.join('\n\n'),
      }),
    ).rejects.toThrow(/at most 500 live block placeholders/);
  });
});

describe('placeholders and page text', () => {
  const STORE = () => {
    const page = world.pages.find((p) => p.id === PAGES.open)!;
    page.content = TiptapTransformer.fromYdoc(
      world.ydocFor(`page.${PAGES.open}`),
      'default',
    );
    return page.content;
  };
  const OPEN = () => {
    const page = world.pages.find((p) => p.id === PAGES.open)!;
    Y.applyUpdate(
      world.ydocFor(`page.${PAGES.open}`),
      Y.encodeStateAsUpdate(
        TiptapTransformer.toYdoc(page.content, 'default', tiptapExtensions),
      ),
    );
  };

  it('typed text that looks like a placeholder stays text through a round trip', async () => {
    pageWithSheet();
    const typed = `<div data-type="sheet" data-block-id="${SHEET}">`;
    world.pages
      .find((p) => p.id === PAGES.open)!
      .content.content.unshift(para(typed));
    OPEN();
    const { markdown } = await run('get_page_markdown', {
      page_id: PAGES.open,
    });
    const out = await run('update_page_markdown', {
      page_id: PAGES.open,
      content: markdown,
    });
    expect(out.live_blocks.kept_in_place).toBe(1);
    const content = STORE();
    expect(content.content[0]).toEqual(
      expect.objectContaining({
        type: 'paragraph',
        content: [expect.objectContaining({ text: typed })],
      }),
    );
    expect(content.content.filter((n: any) => n.type === 'sheet').length).toBe(
      1,
    );
  });

  it('a title with blank lines or a pipe still gives a one-line placeholder', async () => {
    pageWithSheet();
    world.pages.find(
      (p) => p.id === PAGES.open,
    )!.content.content[1].attrs.title = 'Costs\n\nQ1 | Q2';
    OPEN();
    const { markdown } = await run('get_page_markdown', {
      page_id: PAGES.open,
    });
    const line = markdown
      .split('\n')
      .find((l: string) => l.includes(`data-block-id="${SHEET}"`));
    expect(line).toMatch(/^<div [^\n|]*<\/div>$/);
    expect(line).not.toContain('Q1 | Q2');
    await run('update_page_markdown', {
      page_id: PAGES.open,
      content: markdown,
    });
    const content = STORE();
    expect(content.content.map((n: any) => n.type)).toEqual([
      'paragraph',
      'sheet',
      'paragraph',
    ]);
  });

  it('a block inside a list item keeps a working placeholder', async () => {
    pageWithSheet();
    const page = world.pages.find((p) => p.id === PAGES.open)!;
    const sheet = page.content.content[1];
    page.content.content[1] = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [para('item'), sheet] }],
    };
    OPEN();
    const { markdown } = await run('get_page_markdown', {
      page_id: PAGES.open,
    });
    const out = await run('update_page_markdown', {
      page_id: PAGES.open,
      content: markdown,
    });
    expect(out.live_blocks.removed).toBe(0);
    const content = STORE();
    expect(JSON.stringify(content).match(new RegExp(SHEET, 'g'))).toHaveLength(
      1,
    );
  });

  it('a block inside a table cell keeps a working placeholder', async () => {
    pageWithSheet();
    const page = world.pages.find((p) => p.id === PAGES.open)!;
    const sheet = page.content.content[1];
    sheet.attrs.title = 'A | B';
    const cell = (...content: any[]) => ({ type: 'tableCell', content });
    page.content.content[1] = {
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell(para('left')), cell(sheet)] },
        { type: 'tableRow', content: [cell(para('x')), cell(para('y'))] },
      ],
    };
    OPEN();
    const { markdown } = await run('get_page_markdown', {
      page_id: PAGES.open,
    });
    const out = await run('update_page_markdown', {
      page_id: PAGES.open,
      content: markdown,
    });
    expect(out.live_blocks).toEqual({
      kept_in_place: 1,
      appended_at_end: 0,
      removed: 0,
    });
    const content = STORE();
    // the block stays in its cell, beside "left" (the markdown table export
    // itself adds an empty header row; that is upstream behaviour)
    const table = content.content.find((n: any) => n.type === 'table');
    const row = table.content.find((r: any) =>
      JSON.stringify(r).includes('"left"'),
    );
    expect(JSON.stringify(row)).toContain(SHEET);
    expect(JSON.stringify(content).match(new RegExp(SHEET, 'g'))).toHaveLength(
      1,
    );
  });
});

describe('get_page_markdown when the sync server cannot be reached', () => {
  it('flushes only a page that is open somewhere, and adds no note when that works', async () => {
    pageWithSheet();
    const out = await run('get_page_markdown', { page_id: PAGES.open });
    expect(world.calls.flushOnlyIfOpen).toEqual([true]);
    expect(out.note).toBeUndefined();
  });

  it.each([
    [
      'no Redis and a separate sync server (503)',
      new ServiceUnavailableException(
        'The collaboration server cannot be reached without Redis',
      ),
    ],
    ['the relay timing out (Redis)', new Error('TIMEOUT')],
  ])(
    'still returns the stored page with %s, and says it may be behind',
    async (_l, err) => {
      pageWithSheet();
      world.flags.flushFails = err;
      const out = await run('get_page_markdown', { page_id: PAGES.open });
      expect(out.markdown).toContain('Intro');
      expect(out.markdown).toContain(`data-block-id="${SHEET}"`);
      expect(out.note).toBe(
        'The page may have unsaved changes that are not shown: the live document could not be reached, so this is the last saved version.',
      );
    },
  );
});
