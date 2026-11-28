jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (s: string) => s,
}));

import * as Y from 'yjs';
import { ForbiddenException } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { buildTools } from '../tool-registry';
import { McpToolError, NOT_FOUND } from '../tool.types';
import {
  ALICE,
  buildWorld,
  COMMENTS,
  PAGES,
  SPACE_MINE,
  SPACE_OTHER,
} from '../testing/tool-fixtures';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from '../../../collaboration/collaboration.util';

const t = (text: string, marks?: any[]) => ({
  type: 'text',
  text,
  ...(marks ? { marks } : {}),
});
const p = (...content: any[]) => ({ type: 'paragraph', content });
const doc = (...content: any[]) => ({ type: 'doc', content });
const commentMark = (commentId: string) => ({
  type: 'comment',
  attrs: { commentId, resolved: false },
});
const readerKey = `${ALICE.id}:${SPACE_MINE}`;

let world: ReturnType<typeof buildWorld>;
let tools: Record<string, any>;
const run = (name: string, args: any) =>
  tools[name].run(
    tools[name].input.parse(args),
    world.ctx('write'),
  ) as Promise<any>;
const page = (id: string) => world.pages.find((x) => x.id === id)!;

beforeEach(() => {
  world = buildWorld();
  tools = Object.fromEntries(buildTools(world.deps).map((x) => [x.name, x]));
});

describe('update_page_markdown', () => {
  it('keeps a thread attached after the text around it changes', async () => {
    page(PAGES.open).content = doc(
      p(
        t('The '),
        t('hello world', [commentMark(COMMENTS.rootOpen)]),
        t(' text'),
      ),
    );
    const out = await run('update_page_markdown', {
      page_id: PAGES.open,
      content: 'Rewritten, and now hello world sits mid sentence.',
    });

    // the second thread quotes text that no longer exists
    expect(out).toEqual(
      expect.objectContaining({
        anchored: 1,
        orphaned: 1,
        live_blocks: { kept_in_place: 0, appended_at_end: 0, removed: 0 },
      }),
    );

    const written = TiptapTransformer.fromYdoc(
      world.ydocFor(`page.${PAGES.open}`),
      'default',
    ) as any;
    const marked = written.content[0].content.filter((n: any) =>
      n.marks?.some(
        (m: any) =>
          m.type === 'comment' && m.attrs.commentId === COMMENTS.rootOpen,
      ),
    );
    expect(marked.map((n: any) => n.text).join('')).toBe('hello world');
    expect(JSON.stringify(written)).toContain('Rewritten');
  });

  it('refuses a page with a mention unless allow_lossy', async () => {
    const mention = {
      type: 'mention',
      attrs: { id: 'm', label: 'Bob', entityType: 'user', entityId: 'u' },
    };
    world
      .ydocFor(`page.${PAGES.open}`)
      .getXmlFragment('default')
      .insert(0, [prosemirrorNodeToYElement(p(t('hi '), mention))]);
    const args = { page_id: PAGES.open, content: 'replaced' };

    await expect(run('update_page_markdown', args)).rejects.toThrow(
      'This page has mentions, which a markdown replace would delete. Pass allow_lossy to replace anyway.',
    );
    const live = () =>
      world.ydocFor(`page.${PAGES.open}`).getXmlFragment('default').toString();
    expect(live()).toContain('mention');
    expect(live()).not.toContain('replaced');

    await expect(
      run('update_page_markdown', { ...args, allow_lossy: true }),
    ).resolves.toEqual(expect.objectContaining({ page_id: PAGES.open }));
    expect(live()).toContain('replaced');
    expect(live()).not.toContain('mention');
  });

  it('keeps live blocks, including one inserted after the last save', async () => {
    // the stored page has no whiteboard; only the open document does
    page(PAGES.open).content = doc(p(t('saved')));
    const live = world.ydocFor(`page.${PAGES.open}`);
    live.getXmlFragment('default').insert(0, [
      prosemirrorNodeToYElement(p(t('saved'))),
      prosemirrorNodeToYElement({
        type: 'whiteboard',
        attrs: { blockId: 'fresh', title: 'Plan', height: 400 },
      }),
      prosemirrorNodeToYElement({
        type: 'sheet',
        attrs: { blockId: 'older', title: 'Costs', height: 300 },
      }),
    ]);

    const out = await run('update_page_markdown', {
      page_id: PAGES.open,
      content: 'all new text',
    });

    // content without placeholders: both are kept, added at the end
    expect(out.live_blocks).toEqual({
      kept_in_place: 0,
      appended_at_end: 2,
      removed: 0,
    });
    const nodes: any[] = [];
    live.getXmlFragment('default').forEach((n) => {
      if (n instanceof Y.XmlElement)
        nodes.push({ type: n.nodeName, attrs: n.getAttributes() });
    });
    expect(
      nodes
        .filter((n) => n.attrs.blockId)
        .map((n) => [n.type, n.attrs.blockId, n.attrs.title, n.attrs.height]),
    ).toEqual([
      ['whiteboard', 'fresh', 'Plan', 400],
      ['sheet', 'older', 'Costs', 300],
    ]);
    expect(nodes.some((n) => n.type === 'paragraph')).toBe(true);
  });

  it('judges the live document, not the stored page, for lossy content', async () => {
    // the stored page is clean; a mention was typed seconds ago and exists only live
    page(PAGES.open).content = doc(p(t('clean')));
    world
      .ydocFor(`page.${PAGES.open}`)
      .getXmlFragment('default')
      .insert(0, [
        prosemirrorNodeToYElement(
          p(t('hi '), {
            type: 'mention',
            attrs: { id: 'm', label: 'Bob', entityType: 'user', entityId: 'u' },
          }),
        ),
      ]);
    await expect(
      run('update_page_markdown', { page_id: PAGES.open, content: 'x' }),
    ).rejects.toThrow(/mentions/);
    expect(
      world.ydocFor(`page.${PAGES.open}`).getXmlFragment('default').toString(),
    ).toContain('mention');
  });

  it('changes only the title when no content is given', async () => {
    const out = await run('update_page_markdown', {
      page_id: PAGES.open,
      title: 'Renamed',
    });
    expect(world.calls.titles).toEqual([
      { pageId: PAGES.open, title: 'Renamed' },
    ]);
    expect(out.anchored).toBe(0);
  });

  it('a failed title change leaves the content alone', async () => {
    world.raw.pageService.update = async () => {
      throw new Error('title store failed');
    };
    await expect(
      run('update_page_markdown', {
        page_id: PAGES.open,
        title: 'New title',
        content: 'new body',
      }),
    ).rejects.toThrow('title store failed');
    expect(
      world.ydocFor(`page.${PAGES.open}`).getXmlFragment('default').length,
    ).toBe(0);
  });

  it('a refused content change puts the old title back', async () => {
    world
      .ydocFor(`page.${PAGES.open}`)
      .getXmlFragment('default')
      .insert(0, [
        prosemirrorNodeToYElement(
          p(t('hi '), {
            type: 'mention',
            attrs: { id: 'm', label: 'Bob', entityType: 'user', entityId: 'u' },
          }),
        ),
      ]);
    await expect(
      run('update_page_markdown', {
        page_id: PAGES.open,
        title: 'New title',
        content: 'new body',
      }),
    ).rejects.toThrow(/mentions.*The title change was undone\./s);
    expect(world.pages.find((x) => x.id === PAGES.open)!.title).toBe(
      'Open page',
    );
    // set through the page service, put back with one conditional update
    expect(world.calls.titles.map((c: any) => c.title)).toEqual(['New title']);
    expect(world.calls.titleRestores).toEqual([
      { pageId: PAGES.open, expected: 'New title', title: 'Open page' },
    ]);
  });

  describe('when the content fails after the title changed', () => {
    const mention = () =>
      world
        .ydocFor(`page.${PAGES.open}`)
        .getXmlFragment('default')
        .insert(0, [
          prosemirrorNodeToYElement(
            p(t('hi '), {
              type: 'mention',
              attrs: {
                id: 'm',
                label: 'Bob',
                entityType: 'user',
                entityId: 'u',
              },
            }),
          ),
        ]);
    const update = () =>
      run('update_page_markdown', {
        page_id: PAGES.open,
        title: 'New title',
        content: 'new body',
      });

    it('leaves a rename someone made meanwhile alone, and says so', async () => {
      mention();
      // a person renames the page while the content replace runs
      const replace = world.raw.collaboration.handleYjsEvent;
      world.raw.collaboration.handleYjsEvent = async (...a: any[]) => {
        world.pages.find((x) => x.id === PAGES.open)!.title = 'Renamed by Bob';
        return (replace as any)(...a);
      };
      await expect(update()).rejects.toThrow(
        /The title was not put back: it was changed again meanwhile and is now "Renamed by Bob"\./,
      );
      expect(world.pages.find((x) => x.id === PAGES.open)!.title).toBe(
        'Renamed by Bob',
      );
      expect(world.calls.titles.map((c: any) => c.title)).toEqual([
        'New title',
      ]);
      // the condition, not a separate read, decided it
      expect(world.calls.titleRestores).toEqual([
        { pageId: PAGES.open, expected: 'New title', title: 'Open page' },
      ]);
    });

    it('says the new title stayed when putting the old one back fails', async () => {
      mention();
      world.raw.queries.restoreTitleIfUnchanged = async () => {
        throw new Error('database down');
      };
      await expect(update()).rejects.toThrow(
        /The new title "New title" stayed: putting the old title back failed\./,
      );
    });
  });

  it('needs content or a title', async () => {
    await expect(
      run('update_page_markdown', { page_id: PAGES.open }),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  it('is refused without edit access', async () => {
    world.roles[readerKey] = 'reader';
    await expect(
      run('update_page_markdown', { page_id: PAGES.open, content: 'x' }),
    ).rejects.toThrow(NOT_FOUND);
    expect(
      world.ydocFor(`page.${PAGES.open}`).getXmlFragment('default').length,
    ).toBe(0);
  });
});

describe('create_page_from_markdown', () => {
  it("refuses live block placeholders: a new page cannot hold another page's blocks", async () => {
    await expect(
      run('create_page_from_markdown', {
        space_id: SPACE_MINE,
        title: 'Copy',
        content:
          'Intro\n\n<div data-type="sheet" data-block-id="0193c7a0-4444-7abc-8def-000000000001" data-title="Costs">x</div>\n',
      }),
    ).rejects.toThrow(/live block placeholder/);
    expect(world.calls.created).toEqual([]);
  });

  it('creates a page from markdown and returns its id and url', async () => {
    const out = await run('create_page_from_markdown', {
      space_id: SPACE_MINE,
      title: 'Notes',
      content: '# Hello',
    });
    expect(world.calls.created).toEqual([
      {
        spaceId: SPACE_MINE,
        title: 'Notes',
        parentPageId: undefined,
        content: '# Hello',
        format: 'markdown',
      },
    ]);
    expect(out.url).toMatch(/^http:\/\/docs\.test\/p\/slug/);
    expect(world.calls.audit).toEqual([
      {
        event: 'page.created',
        resourceType: 'page',
        resourceId: out.page_id,
        spaceId: SPACE_MINE,
        changes: { after: { title: 'Notes', spaceId: SPACE_MINE } },
        metadata: { source: 'mcp', tokenId: `tok-${ALICE.id}-write` },
      },
    ]);
    expect(out.page_id).toBeDefined();
  });

  it('creates under a parent the caller can edit', async () => {
    await run('create_page_from_markdown', {
      space_id: SPACE_MINE,
      title: 'Kid',
      content: 'x',
      parent_page_id: PAGES.open,
    });
    expect(world.calls.created[0].parentPageId).toBe(PAGES.open);
  });

  it('is refused without create permission in the space', async () => {
    world.roles[readerKey] = 'reader';
    await expect(
      run('create_page_from_markdown', {
        space_id: SPACE_MINE,
        title: 'x',
        content: 'x',
      }),
    ).rejects.toThrow(NOT_FOUND);
    await expect(
      run('create_page_from_markdown', {
        space_id: SPACE_OTHER,
        title: 'x',
        content: 'x',
      }),
    ).rejects.toThrow(NOT_FOUND);
    expect(world.calls.created).toEqual([]);
    expect(world.calls.audit).toEqual([]);
  });

  it('is refused when the parent page is not editable by the caller', async () => {
    world.roles[readerKey] = 'reader';
    await expect(
      run('create_page_from_markdown', {
        space_id: SPACE_MINE,
        title: 'x',
        content: 'x',
        parent_page_id: PAGES.open,
      }),
    ).rejects.toThrow(NOT_FOUND);
    expect(world.calls.created).toEqual([]);
  });

  it('needs create permission in the space even with edit on the parent', async () => {
    // e.g. a space reader granted edit on one page
    world.roles[readerKey] = 'reader';
    world.deps.pageAccess.validateCanEdit = async () => undefined;
    await expect(
      run('create_page_from_markdown', {
        space_id: SPACE_MINE,
        title: 'x',
        content: 'x',
        parent_page_id: PAGES.open,
      }),
    ).rejects.toThrow(NOT_FOUND);
    expect(world.calls.created).toEqual([]);
    expect(world.calls.audit).toEqual([]);
  });

  it('needs edit on the parent even with create permission in the space', async () => {
    world.deps.pageAccess.validateCanEdit = async () => {
      throw new ForbiddenException();
    };
    await expect(
      run('create_page_from_markdown', {
        space_id: SPACE_MINE,
        title: 'x',
        content: 'x',
        parent_page_id: PAGES.open,
      }),
    ).rejects.toThrow(NOT_FOUND);
    expect(world.calls.created).toEqual([]);
  });

  it('is refused when the parent lies in another space', async () => {
    await expect(
      run('create_page_from_markdown', {
        space_id: SPACE_OTHER,
        title: 'x',
        content: 'x',
        parent_page_id: PAGES.open,
      }),
    ).rejects.toThrow(NOT_FOUND);
  });
});

describe('comment tools', () => {
  it('reply_to_comment adds a reply under the thread root', async () => {
    const out = await run('reply_to_comment', {
      comment_id: COMMENTS.rootOpen,
      body: 'Fixed.\n\nSee below.',
    });
    expect(out.thread_id).toBe(COMMENTS.rootOpen);
    expect(world.calls.replies).toHaveLength(1);
    expect(world.calls.replies[0]).toEqual(
      expect.objectContaining({
        pageId: PAGES.open,
        parentCommentId: COMMENTS.rootOpen,
        userId: ALICE.id,
      }),
    );
    expect(world.calls.replies[0].content.content).toHaveLength(2);
    expect(world.calls.audit).toEqual([
      {
        event: 'comment.created',
        resourceType: 'comment',
        resourceId: out.comment_id,
        spaceId: SPACE_MINE,
        metadata: {
          pageId: PAGES.open,
          source: 'mcp',
          tokenId: `tok-${ALICE.id}-write`,
        },
      },
    ]);
  });

  it('reply_to_comment on a reply (not a root) is refused', async () => {
    await expect(
      run('reply_to_comment', { comment_id: COMMENTS.reply, body: 'x' }),
    ).rejects.toThrow(/is a reply/);
    expect(world.calls.replies).toEqual([]);
  });

  it('reply_to_comment and resolve_comment are refused without comment permission', async () => {
    world.roles[readerKey] = 'reader';
    await expect(
      run('reply_to_comment', { comment_id: COMMENTS.rootOpen, body: 'x' }),
    ).rejects.toThrow(NOT_FOUND);
    await expect(
      run('resolve_comment', { comment_id: COMMENTS.rootOpen }),
    ).rejects.toThrow(NOT_FOUND);
    expect(world.calls.replies).toEqual([]);
    expect(world.calls.resolves).toEqual([]);
  });

  it('resolve_comment resolves a thread and asks for the highlight to follow', async () => {
    const out = await run('resolve_comment', { comment_id: COMMENTS.rootOpen });
    expect(out).toEqual({ comment_id: COMMENTS.rootOpen, resolved: true });
    expect(world.calls.resolves).toEqual([
      { id: COMMENTS.rootOpen, resolved: true, opts: { updateYjsMark: true } },
    ]);
    expect(world.calls.audit).toEqual([
      {
        event: 'comment.resolved',
        resourceType: 'comment',
        resourceId: COMMENTS.rootOpen,
        spaceId: SPACE_MINE,
        metadata: {
          pageId: PAGES.open,
          source: 'mcp',
          tokenId: `tok-${ALICE.id}-write`,
        },
      },
    ]);
  });

  it('resolve_comment with resolved false reopens the thread', async () => {
    const out = await run('resolve_comment', {
      comment_id: COMMENTS.rootResolved,
      resolved: false,
    });
    expect(out).toEqual({ comment_id: COMMENTS.rootResolved, resolved: false });
    expect(world.calls.resolves[0].resolved).toBe(false);
    expect(world.calls.audit.map((a) => a.event)).toEqual(['comment.reopened']);
  });

  it('resolve_comment refuses a reply', async () => {
    await expect(
      run('resolve_comment', { comment_id: COMMENTS.reply }),
    ).rejects.toBeInstanceOf(McpToolError);
  });
});
