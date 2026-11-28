export type AnchorHint = {
  commentId: string;
  quote: string;
  prefix?: string;
  suffix?: string;
  resolved: boolean;
};

type PmNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PmNode[];
};

type Block = { node: PmNode; text: string };
type Range = { block: number; start: number; end: number; hint: AnchorHint };

// Characters standing in for inline nodes that are not text. Distinct from
// anything a person quotes, so a match never runs across one.
const HARD_BREAK = '\u0001';
const OTHER_INLINE = '￼';

const SKIP_BLOCKS = new Set(['codeBlock']); // the comment mark is not applied in code

function isTextblock(node: PmNode): boolean {
  return (
    node.type !== 'text' &&
    Array.isArray(node.content) &&
    node.content.some((c) => c.type === 'text')
  );
}

function collectBlocks(node: PmNode, out: Block[]) {
  if (isTextblock(node)) {
    if (!SKIP_BLOCKS.has(node.type)) {
      const text = node
        .content!.map((c) =>
          c.type === 'text'
            ? (c.text ?? '')
            : c.type === 'hardBreak'
              ? HARD_BREAK
              : OTHER_INLINE,
        )
        .join('');
      out.push({ node, text });
    }
    return;
  }
  node.content?.forEach((c) => collectBlocks(c, out));
}

function occurrences(haystacks: string[], needle: string) {
  const found: { block: number; start: number }[] = [];
  if (!needle) return found;
  haystacks.forEach((h, block) => {
    for (let i = h.indexOf(needle); i !== -1; i = h.indexOf(needle, i + 1)) {
      found.push({ block, start: i });
    }
  });
  return found;
}

// Each match is a start index of the full needle; the quote begins `lead` in.
function locate(blocks: Block[], hint: AnchorHint) {
  if (!hint.quote) return null;
  const texts = blocks.map((b) => b.text);
  const prefix = hint.prefix ?? '';
  const suffix = hint.suffix ?? '';

  if (prefix || suffix) {
    const full = occurrences(texts, prefix + hint.quote + suffix);
    if (full.length === 1) {
      return {
        block: full[0].block,
        start: full[0].start + prefix.length,
        end: full[0].start + prefix.length + hint.quote.length,
      };
    }
  }
  const alone = occurrences(texts, hint.quote);
  if (alone.length === 1) {
    return {
      block: alone[0].block,
      start: alone[0].start,
      end: alone[0].start + hint.quote.length,
    };
  }
  return null; // none or several: never guess
}

const sameMarks = (a: PmNode, b: PmNode) =>
  JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);

function applyToBlock(block: Block, ranges: Range[]) {
  const out: PmNode[] = [];
  let offset = 0;
  for (const child of block.node.content!) {
    const length = child.type === 'text' ? (child.text ?? '').length : 1;
    if (child.type !== 'text') {
      out.push(child);
      offset += length;
      continue;
    }
    // cut points inside this text node, from every range that touches it
    const cuts = new Set<number>([0, length]);
    for (const r of ranges) {
      if (r.end > offset && r.start < offset + length) {
        cuts.add(Math.max(0, r.start - offset));
        cuts.add(Math.min(length, r.end - offset));
      }
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i];
      const to = points[i + 1];
      const piece: PmNode = { ...child, text: child.text!.slice(from, to) };
      const hit = ranges.find(
        (r) => r.start <= offset + from && r.end >= offset + to,
      );
      if (hit) {
        piece.marks = [
          ...(child.marks ?? []),
          {
            type: 'comment',
            attrs: {
              commentId: hit.hint.commentId,
              resolved: hit.hint.resolved,
            },
          },
        ];
      }
      out.push(piece);
    }
    offset += length;
  }

  const merged: PmNode[] = [];
  for (const n of out) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.type === 'text' &&
      n.type === 'text' &&
      sameMarks(last, n)
    ) {
      last.text += n.text;
    } else {
      merged.push(n);
    }
  }
  block.node.content = merged;
}

/**
 * Puts comment highlights back on a document that was rebuilt from markdown.
 * A quote is marked only where it can be found exactly once; otherwise the
 * comment is orphaned and no mark is added. The input is not mutated.
 */
export function reanchorComments(
  doc: unknown,
  hints: AnchorHint[],
): { doc: unknown; anchored: string[]; orphaned: string[] } {
  const copy = structuredClone(doc) as PmNode;
  const blocks: Block[] = [];
  collectBlocks(copy, blocks);

  const anchored: string[] = [];
  const orphaned: string[] = [];
  const ranges: Range[] = [];

  for (const hint of hints) {
    const at = locate(blocks, hint);
    // Two highlights cannot share text: the second would replace the first.
    const clash =
      at &&
      ranges.some(
        (r) => r.block === at.block && r.start < at.end && at.start < r.end,
      );
    if (!at || clash) {
      orphaned.push(hint.commentId);
      continue;
    }
    ranges.push({ ...at, hint });
    anchored.push(hint.commentId);
  }

  const byBlock = new Map<number, Range[]>();
  for (const r of ranges) {
    byBlock.set(r.block, [...(byBlock.get(r.block) ?? []), r]);
  }
  for (const [i, rs] of byBlock) applyToBlock(blocks[i], rs);

  return { doc: copy, anchored, orphaned };
}
