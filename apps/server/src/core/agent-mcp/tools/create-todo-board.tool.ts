import { z } from 'zod';
import { todo } from '@docmost/live-blocks';
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

export function createTodoBoardTool(
  deps: McpDeps,
): McpTool<z.infer<typeof input>> {
  return {
    name: 'create_todo_board',
    description: `Create a live to-do board with one empty card, which people can edit together. ${TARGET_RULE} Returns page_id, block_id and url.`,
    scope: 'write',
    input,
    async run(args, ctx) {
      const out = await blockCall(() =>
        deps.liveBlocks.createOnPage({
          kind: 'todo',
          title: args.title,
          user: ctx.user,
          target: targetOf(args),
          input: todo.createEmptyBoard(),
          baseUrl: deps.domainService.getWorkspaceUrl(ctx.workspace),
        }),
      );
      return createdBlockOutput(deps, ctx, args.title, args.space_id, out);
    },
  };
}
