import { z } from 'zod';
import { McpTool } from '../tool.types';
import { McpDeps } from '../mcp-deps';

const input = z.object({});

export function listSpacesTool(deps: McpDeps): McpTool<z.infer<typeof input>> {
  return {
    name: 'list_spaces',
    description:
      'List the spaces you belong to: id, name, slug and your role. Start here to find a space_id.',
    scope: 'read',
    input,
    async run(_args, ctx) {
      const spaces = await deps.queries.listUserSpaces(
        ctx.user.id,
        ctx.workspace.id,
      );
      return { spaces };
    },
  };
}
