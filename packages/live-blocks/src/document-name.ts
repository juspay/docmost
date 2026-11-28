export type ParsedDocumentName =
  | { type: 'page'; id: string }
  | { type: 'block'; id: string }
  | { type: 'invalid' };

const BLOCK_PREFIX = 'block.';
export const LOWER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function blockDocumentName(blockId: string): string {
  return `${BLOCK_PREFIX}${blockId.toLowerCase()}`;
}

export function parseDocumentName(name: string): ParsedDocumentName {
  if (name.startsWith(BLOCK_PREFIX)) {
    const id = name.slice(BLOCK_PREFIX.length);
    return LOWER_UUID.test(id) ? { type: 'block', id } : { type: 'invalid' };
  }
  // Same result as getPageId in the server's collaboration.util.ts.
  return { type: 'page', id: name.split('.')[1] };
}
