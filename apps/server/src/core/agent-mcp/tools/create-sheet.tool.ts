import { z } from 'zod';
import { McpTool } from '../tool.types';
import { McpDeps } from '../mcp-deps';
import {
  blockCall,
  blockTargetShape,
  createdBlockOutput,
  refineTarget,
  TARGET_RULE,
  targetOf,
} from './block-access';

const input = z.object({ ...blockTargetShape }).superRefine(refineTarget);

export function createSheetTool(deps: McpDeps): McpTool<z.infer<typeof input>> {
  return {
    name: 'create_sheet',
    description: `Create a live spreadsheet with one empty tab, which people can edit together. ${TARGET_RULE} Returns page_id, block_id and url; fill it with set_sheet_cells.`,
    scope: 'write',
    input,
    async run(args, ctx) {
      // no input: the kind's empty workbook is one empty tab
      const out = await blockCall(() =>
        deps.liveBlocks.createOnPage({
          kind: 'sheet',
          title: args.title,
          user: ctx.user,
          target: targetOf(args),
          baseUrl: deps.domainService.getWorkspaceUrl(ctx.workspace),
        }),
      );
      return createdBlockOutput(deps, ctx, args.title, args.space_id, out);
    },
  };
}
