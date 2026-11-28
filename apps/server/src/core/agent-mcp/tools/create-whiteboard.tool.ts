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

const fileInput = z.looseObject({
  dataURL: z.string(),
  mimeType: z.string().optional(),
});

export const MAX_FILES_PER_CALL = 50;

const input = z
  .object({
    ...blockTargetShape,
    scene: z
      .object({
        elements: z.array(z.unknown()),
        files: z.record(z.string(), fileInput).optional(),
      })
      .optional(),
  })
  .superRefine(refineTarget);

export function createWhiteboardTool(
  deps: McpDeps,
): McpTool<z.infer<typeof input>> {
  return {
    name: 'create_whiteboard',
    description: `Create a live whiteboard (an Excalidraw board people can edit together). ${TARGET_RULE} scene is optional: { elements, files } as Excalidraw saves them; each file is { dataURL, mimeType } with a base64 data URL, and only PNG, JPEG, GIF and WebP images are stored (the type is read from the bytes; SVG is refused), at most ${MAX_FILES_PER_CALL} images per call. The whole request is limited to 1 MiB. Returns page_id, block_id, url and skipped_files (each { fileId, reason }).`,
    scope: 'write',
    input,
    async run(args, ctx) {
      // each file is an upload and an attachment row, so a call takes a bounded number
      const entries = Object.entries(args.scene?.files ?? {});
      const files = Object.fromEntries(
        entries.slice(0, MAX_FILES_PER_CALL),
      ) as Record<string, { dataURL: string; mimeType?: string }>;
      const overflow = entries.slice(MAX_FILES_PER_CALL).map(([fileId]) => ({
        fileId,
        reason: `At most ${MAX_FILES_PER_CALL} images are stored per call`,
      }));
      const out = await blockCall(() =>
        deps.liveBlocks.createOnPage({
          kind: 'whiteboard',
          title: args.title,
          user: ctx.user,
          target: targetOf(args),
          input: args.scene ? { elements: args.scene.elements } : undefined,
          files: args.scene?.files ? files : undefined,
          baseUrl: deps.domainService.getWorkspaceUrl(ctx.workspace),
        }),
      );
      return {
        ...createdBlockOutput(deps, ctx, args.title, args.space_id, out),
        skipped_files: [...out.skippedFiles, ...overflow],
      };
    },
  };
}
