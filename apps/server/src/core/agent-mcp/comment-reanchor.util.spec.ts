import { AnchorHint, reanchorComments } from './comment-reanchor.util';

const t = (text: string, marks?: any[]) => ({
  type: 'text',
  text,
  ...(marks ? { marks } : {}),
});
const p = (...content: any[]) => ({ type: 'paragraph', content });
const doc = (...content: any[]) => ({ type: 'doc', content });
const hint = (
  commentId: string,
  quote: string,
  extra: Partial<AnchorHint> = {},
): AnchorHint => ({
  commentId,
  quote,
  resolved: false,
  ...extra,
});

// all text carrying a comment mark, joined, per comment id
function marked(d: any): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (n: any) => {
    for (const m of n.marks ?? []) {
      if (m.type === 'comment')
        out[m.attrs.commentId] = (out[m.attrs.commentId] ?? '') + n.text;
    }
    (n.content ?? []).forEach(walk);
  };
  walk(d);
  return out;
}

const plainText = (d: any): string => {
  let s = '';
  const walk = (n: any) => {
    if (n.type === 'text') s += n.text;
    (n.content ?? []).forEach(walk);
  };
  walk(d);
  return s;
};

describe('reanchorComments', () => {
  it('marks a quote that occurs once', () => {
    const input = doc(p(t('Hello brave new world')));
    const out = reanchorComments(input, [hint('c1', 'brave new')]);
    expect(out.anchored).toEqual(['c1']);
    expect(out.orphaned).toEqual([]);
    expect(marked(out.doc)).toEqual({ c1: 'brave new' });
    expect(plainText(out.doc)).toBe('Hello brave new world');
    expect((out.doc as any).content[0].content.map((n: any) => n.text)).toEqual(
      ['Hello ', 'brave new', ' world'],
    );
  });

  it('carries the resolved flag onto the mark', () => {
    const out = reanchorComments(doc(p(t('abc def'))), [
      hint('c1', 'def', { resolved: true }),
    ]);
    const mark = (out.doc as any).content[0].content[1].marks[0];
    expect(mark).toEqual({
      type: 'comment',
      attrs: { commentId: 'c1', resolved: true },
    });
  });

  it('uses prefix and suffix to pick one of several matches', () => {
    const input = doc(p(t('the cat sat')), p(t('a cat ran')));
    const out = reanchorComments(input, [
      hint('c1', 'cat', { prefix: 'a ', suffix: ' ran' }),
    ]);
    expect(out.anchored).toEqual(['c1']);
    const second = (out.doc as any).content[1].content;
    expect(second.map((n: any) => n.text)).toEqual(['a ', 'cat', ' ran']);
    expect((out.doc as any).content[0].content).toHaveLength(1);
  });

  it('orphans a quote that occurs twice with no prefix or suffix', () => {
    const input = doc(p(t('one cat')), p(t('two cat')));
    const out = reanchorComments(input, [hint('c1', 'cat')]);
    expect(out.anchored).toEqual([]);
    expect(out.orphaned).toEqual(['c1']);
    expect(marked(out.doc)).toEqual({}); // not even the first match
  });

  it('orphans a quote that still occurs twice when its context does not disambiguate', () => {
    const input = doc(p(t('x cat y')), p(t('x cat y')));
    const out = reanchorComments(input, [
      hint('c1', 'cat', { prefix: 'x ', suffix: ' y' }),
    ]);
    expect(out.orphaned).toEqual(['c1']);
  });

  it('orphans a comment whose text is gone', () => {
    const out = reanchorComments(doc(p(t('something else'))), [
      hint('c1', 'vanished'),
    ]);
    expect(out.orphaned).toEqual(['c1']);
    expect(marked(out.doc)).toEqual({});
  });

  it('falls back to the quote alone when the context no longer matches', () => {
    const out = reanchorComments(doc(p(t('new surroundings: target here'))), [
      hint('c1', 'target', { prefix: 'old ', suffix: ' text' }),
    ]);
    expect(out.anchored).toEqual(['c1']);
  });

  it('handles a quote that spans two text nodes with different marks', () => {
    const input = doc(
      p(t('say '), t('hello', [{ type: 'bold' }]), t(' world now')),
    );
    const out = reanchorComments(input, [hint('c1', 'say hello wor')]);
    expect(out.anchored).toEqual(['c1']);
    expect(marked(out.doc)).toEqual({ c1: 'say hello wor' });
    const nodes = (out.doc as any).content[0].content;
    expect(nodes.map((n: any) => n.text)).toEqual([
      'say ',
      'hello',
      ' wor',
      'ld now',
    ]);
    expect(nodes[1].marks.map((m: any) => m.type)).toEqual(['bold', 'comment']);
    expect(nodes[3].marks).toBeUndefined();
  });

  it('does not match across paragraphs, inline nodes or code blocks', () => {
    const across = reanchorComments(
      doc(p(t('end of one')), p(t('start of two'))),
      [hint('c1', 'one start'), hint('c2', 'one\nstart')],
    );
    expect(across.orphaned).toEqual(['c1', 'c2']);

    const withMention = doc(
      p(t('see '), { type: 'mention', attrs: { label: 'A' } }, t(' now')),
    );
    expect(
      reanchorComments(withMention, [hint('c1', 'see  now')]).orphaned,
    ).toEqual(['c1']);

    const code = doc({ type: 'codeBlock', content: [t('let x = 1')] });
    expect(reanchorComments(code, [hint('c1', 'let x')]).orphaned).toEqual([
      'c1',
    ]);
  });

  it('orphans the second of two comments that want the same text', () => {
    const out = reanchorComments(doc(p(t('alpha beta gamma'))), [
      hint('c1', 'alpha beta'),
      hint('c2', 'beta gamma'),
    ]);
    expect(out.anchored).toEqual(['c1']);
    expect(out.orphaned).toEqual(['c2']);
  });

  it('anchors several separate comments in one block', () => {
    const out = reanchorComments(doc(p(t('red green blue'))), [
      hint('c1', 'red'),
      hint('c2', 'blue'),
    ]);
    expect(out.anchored).toEqual(['c1', 'c2']);
    expect(marked(out.doc)).toEqual({ c1: 'red', c2: 'blue' });
  });

  it('does not mutate its input', () => {
    const input = doc(p(t('Hello brave world')));
    const before = JSON.stringify(input);
    const out = reanchorComments(input, [hint('c1', 'brave')]);
    expect(JSON.stringify(input)).toBe(before);
    expect(out.doc).not.toBe(input);
  });
});
