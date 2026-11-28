export const LIVE_BLOCK_KINDS = ['whiteboard', 'todo', 'sheet'] as const;

export type LiveBlockKind = (typeof LIVE_BLOCK_KINDS)[number];
