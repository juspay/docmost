import { getSchema } from '@tiptap/core';
import {
  parseDocumentJson,
  tiptapExtensions,
} from '../../../collaboration/collaboration.util';
import { ExportService } from '../../../integrations/export/export.service';
import { PageService } from '../../page/services/page.service';

// Sample documents used to prove which types survive export to markdown and
// import back. Each sample names the type it exercises.

const text = (t: string, marks?: any[]) => ({
  type: 'text',
  text: t,
  ...(marks ? { marks } : {}),
});
const p = (...content: any[]) => ({ type: 'paragraph', content });
const doc = (...content: any[]) => ({ type: 'doc', content });
const li = (...c: any[]) => ({ type: 'listItem', content: [p(...c)] });

export const SAMPLES: Record<string, any> = {
  paragraph: doc(p(text('plain text'))),
  heading: doc({
    type: 'heading',
    attrs: { level: 2 },
    content: [text('A title')],
  }),
  bulletList: doc({
    type: 'bulletList',
    content: [li(text('one')), li(text('two'))],
  }),
  orderedList: doc({
    type: 'orderedList',
    attrs: { start: 1 },
    content: [li(text('one')), li(text('two'))],
  }),
  listItem: doc({ type: 'bulletList', content: [li(text('item'))] }),
  taskList: doc({
    type: 'taskList',
    content: [
      {
        type: 'taskItem',
        attrs: { checked: false },
        content: [p(text('todo'))],
      },
    ],
  }),
  taskItem: doc({
    type: 'taskList',
    content: [
      {
        type: 'taskItem',
        attrs: { checked: true },
        content: [p(text('done'))],
      },
    ],
  }),
  blockquote: doc({ type: 'blockquote', content: [p(text('quoted'))] }),
  codeBlock: doc({
    type: 'codeBlock',
    attrs: { language: 'ts' },
    content: [text('const a = 1;')],
  }),
  horizontalRule: doc(
    p(text('above')),
    { type: 'horizontalRule' },
    p(text('below')),
  ),
  hardBreak: doc(p(text('line one'), { type: 'hardBreak' }, text('line two'))),
  table: doc({
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1 },
            content: [p(text('H1'))],
          },
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1 },
            content: [p(text('H2'))],
          },
        ],
      },
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1 },
            content: [p(text('a'))],
          },
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1 },
            content: [p(text('b'))],
          },
        ],
      },
    ],
  }),
  tableRow: doc({
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1 },
            content: [p(text('H'))],
          },
        ],
      },
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1 },
            content: [p(text('c'))],
          },
        ],
      },
    ],
  }),
  tableHeader: doc({
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1 },
            content: [p(text('H'))],
          },
        ],
      },
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1 },
            content: [p(text('c'))],
          },
        ],
      },
    ],
  }),
  tableCell: doc({
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1 },
            content: [p(text('H'))],
          },
        ],
      },
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1 },
            content: [p(text('c'))],
          },
        ],
      },
    ],
  }),
  bold: doc(p(text('strong', [{ type: 'bold' }]))),
  italic: doc(p(text('slanted', [{ type: 'italic' }]))),
  strike: doc(p(text('gone', [{ type: 'strike' }]))),
  code: doc(p(text('x = 1', [{ type: 'code' }]))),
  link: doc(
    p(
      text('site', [
        {
          type: 'link',
          attrs: {
            href: 'https://example.com/a',
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
            class: null,
          },
        },
      ]),
    ),
  ),
  underline: doc(p(text('under', [{ type: 'underline' }]))),
  superscript: doc(p(text('sup', [{ type: 'superscript' }]))),
  subscript: doc(p(text('sub', [{ type: 'subscript' }]))),
  highlight: doc(
    p(text('marked', [{ type: 'highlight', attrs: { color: null } }])),
  ),
  mathInline: doc(p({ type: 'mathInline', attrs: { text: 'x^2' } })),
  mathBlock: doc({ type: 'mathBlock', attrs: { text: 'x^2 + y^2' } }),
  callout: doc({
    type: 'callout',
    attrs: { type: 'info' },
    content: [p(text('note'))],
  }),
  details: doc({
    type: 'details',
    attrs: { open: false },
    content: [
      { type: 'detailsSummary', content: [text('Summary')] },
      { type: 'detailsContent', content: [p(text('Hidden'))] },
    ],
  }),
  detailsSummary: undefined as any,
  detailsContent: undefined as any,
  mention: doc(
    p({
      type: 'mention',
      attrs: {
        id: 'm1',
        label: 'Alice',
        entityType: 'user',
        entityId: 'u1',
        creatorId: 'u2',
      },
    }),
  ),
  image: doc({
    type: 'image',
    attrs: { src: '/api/files/a/b.png', attachmentId: 'a1', alt: 'pic' },
  }),
  attachment: doc({
    type: 'attachment',
    attrs: {
      url: '/api/files/a/b.pdf',
      name: 'b.pdf',
      mime: 'application/pdf',
      size: 10,
      attachmentId: 'a2',
    },
  }),
  youtube: doc({
    type: 'youtube',
    attrs: { src: 'https://www.youtube.com/watch?v=abc' },
  }),
  columns: doc({
    type: 'columns',
    content: [
      { type: 'column', content: [p(text('left'))] },
      { type: 'column', content: [p(text('right'))] },
    ],
  }),
};

SAMPLES.detailsSummary = SAMPLES.details;
SAMPLES.detailsContent = SAMPLES.details;

const strip = (n: any): any => {
  if (Array.isArray(n)) return n.map(strip);
  if (n && typeof n === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'attrs' && v && typeof v === 'object') {
        // generated ids differ between runs and say nothing about content
        const { id: _id, ...rest } = v as any;
        out.attrs = strip(rest);
      } else out[k] = strip(v);
    }
    return out;
  }
  return n;
};

export const canonical = (d: any) =>
  strip(parseDocumentJson(d, tiptapExtensions).node.toJSON());

export async function roundTrip(d: any): Promise<any> {
  const exporter: any = new (ExportService as any)();
  const markdown: string = await exporter.exportPage('markdown', {
    title: '',
    content: d,
  });
  const imported = await (
    PageService.prototype as any
  ).parseProsemirrorContent.call({}, markdown, 'markdown');
  return { markdown, doc: imported };
}

export const schemaTypes = () => {
  const schema = getSchema(tiptapExtensions);
  return {
    nodes: Object.keys(schema.nodes),
    marks: Object.keys(schema.marks),
  };
};
