import { z } from 'zod';
import { SheetSetCellsOp } from '@docmost/live-blocks';
import { McpTool } from '../tool.types';
import { McpDeps } from '../mcp-deps';
import { blockCall, loadBlock } from './block-access';
import { MAX_CELLS_PER_CALL, sheetOutput } from './sheet-output';

const input = z.object({
  block_id: z.guid(),
  cells: z
    .array(z.object({ a1: z.string().min(1).max(40), value: z.string() }))
    .min(1)
    .max(MAX_CELLS_PER_CALL),
  sheet_id: z.string().min(1).optional(),
  sheet_name: z.string().min(1).max(200).optional(),
  create_sheet: z.boolean().optional(),
});

export function setSheetCellsTool(
  deps: McpDeps,
): McpTool<z.infer<typeof input>> {
  return {
    name: 'set_sheet_cells',
    description: `Write cells of a live spreadsheet; people with it open see them change. cells is a list of { a1, value } (up to ${MAX_CELLS_PER_CALL}); a value starting with = is a formula, an empty value clears the cell. The tab is sheet_id, else sheet_name (any case), else the first tab; an a1 like "Budget!B2" names its own tab. create_sheet adds a tab named sheet_name (or by an a1 prefix) when there is none. Returns the sheet as get_sheet does.`,
    scope: 'write',
    input,
    async run(args, ctx) {
      const { row } = await loadBlock(
        deps,
        ctx,
        args.block_id,
        'sheet',
        'edit',
      );
      const op: SheetSetCellsOp = {
        type: 'sheet.setCells',
        sheetId: args.sheet_id,
        sheetName: args.sheet_name,
        createSheet: args.create_sheet,
        cells: args.cells.map((c) => ({ a1: c.a1, value: c.value })),
      };
      await blockCall(() => deps.liveBlocks.applyOps(row.id, [op], ctx.user));
      const snapshot = await blockCall(() => deps.liveBlocks.readFresh(row.id));
      return { block_id: args.block_id, ...sheetOutput(snapshot) };
    },
  };
}
