import { z } from 'zod';
import { McpTool } from '../tool.types';
import { McpDeps } from '../mcp-deps';
import { blockCall, loadBlock } from './block-access';
import { sheetOutput } from './sheet-output';

const input = z.object({ block_id: z.guid() });

export function getSheetTool(deps: McpDeps): McpTool<z.infer<typeof input>> {
  return {
    name: 'get_sheet',
    description:
      'Read a live spreadsheet, including edits made seconds ago. Returns each tab (sheet_id, name, rows, cols) with its filled cells: a1 address, input (what was typed, e.g. a formula) and display (what the grid shows). truncated is true when the display values stop early on a very large sheet.',
    scope: 'read',
    input,
    async run(args, ctx) {
      const { row } = await loadBlock(
        deps,
        ctx,
        args.block_id,
        'sheet',
        'view',
      );
      const snapshot = await blockCall(() => deps.liveBlocks.readFresh(row.id));
      return { block_id: args.block_id, ...sheetOutput(snapshot) };
    },
  };
}
