import { z } from 'zod';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PatScope } from '../access-token/access-token.service';

export type McpContext = {
  user: User;
  workspace: Workspace;
  scope: PatScope;
  tokenId: string;
};

export type McpTool<A = any> = {
  name: string;
  description: string;
  scope: PatScope;
  input: z.ZodType<A>;
  run(args: A, ctx: McpContext): Promise<unknown>;
};

// The message is safe to show to the caller.
export class McpToolError extends Error {}

// One message for "does not exist" and "no access", so a tool cannot probe ids.
export const NOT_FOUND = 'Not found, or you do not have access';
