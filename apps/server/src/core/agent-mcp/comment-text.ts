// Plain text to comment content: blank lines split paragraphs, a single line
// break becomes a hard break.
export function plainTextToCommentDoc(text: string) {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: 'doc',
    content: paragraphs.map((para) => ({
      type: 'paragraph',
      content: para
        .split('\n')
        .flatMap((line, i) => [
          ...(i > 0 ? [{ type: 'hardBreak' }] : []),
          ...(line ? [{ type: 'text', text: line }] : []),
        ]),
    })),
  };
}
