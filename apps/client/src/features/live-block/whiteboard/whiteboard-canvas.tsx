import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { NodeViewProps } from "@tiptap/react";
import type * as Y from "yjs";
import { Loader, useComputedColorScheme } from "@mantine/core";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { canonicalEmbedLink, isSafeEmbedLink } from "@docmost/live-blocks";
import "@excalidraw/excalidraw/index.css";
import { restoreElements } from "@excalidraw/excalidraw";
import { uploadFile } from "@/features/page/services/page-service.ts";
import { svgStringToFile } from "@/lib";
import type { LiveBlockRenderContext } from "../live-block.types";
import { useWhiteboardBinding } from "./use-whiteboard-binding";
import { setAttrsQuietly } from "../hooks/set-attrs-quietly";
import { loadBoardImage, uploadBoardImage } from "./whiteboard-files";
import {
  markPreviewSaved,
  previewNeedsSaving,
  sceneFingerprint,
  shouldSavePreview,
  writePreviewMeta,
} from "./whiteboard-preview";

const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw })),
);

async function savePreview(args: {
  doc: Y.Doc;
  elements: readonly any[];
  files: any;
  pageId: string;
  attachmentId: string | null;
  nodeProps: NodeViewProps;
}) {
  const scene = sceneFingerprint(args.elements);
  const { exportScene } = await import("@excalidraw/excalidraw");
  const svg = await exportScene({
    type: "svg",
    data: { elements: args.elements as any, files: args.files },
    config: { theme: "light" },
  });
  const svgString = new XMLSerializer().serializeToString(svg);
  const file = await svgStringToFile(svgString, "whiteboard.svg");
  // replaces the attachment in place after the first preview
  const attachment = await uploadFile(
    file,
    { pageId: args.pageId },
    args.attachmentId ?? undefined,
  );
  markPreviewSaved(attachment.id);
  // records what this preview shows; storing it also moves the block's
  // updatedAt past the upload, which changes every reader's image URL
  writePreviewMeta(args.doc, scene, attachment.id);
  // the page changes only for the first preview; later ones replace the file in place
  if (!args.attachmentId) {
    setAttrsQuietly(args.nodeProps, {
      attachmentId: attachment.id,
      src: `/api/files/${attachment.id}/${attachment.fileName}`,
    });
  }
}

/**
 * A pasted share link (youtube.com/watch?v=…, youtu.be, vimeo.com/1, a Figma
 * file) is pasted again as its canonical embed link: that is the only form the
 * strict validator lets Excalidraw embed. Returns false to cancel the original.
 */
function pasteShareLinkAsEmbed(data: { text?: string }): boolean {
  const text = data.text?.trim();
  if (!text || /\s/.test(text)) return true;
  const canonical = canonicalEmbedLink(text);
  if (!canonical || canonical === text) return true;
  const transfer = new DataTransfer();
  transfer.setData("text/plain", canonical);
  queueMicrotask(() =>
    document.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }),
    ),
  );
  return false;
}

export default function WhiteboardCanvas({
  ctx,
  nodeProps,
}: {
  ctx: LiveBlockRenderContext;
  nodeProps: NodeViewProps;
}) {
  const colorScheme = useComputedColorScheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const binding = useWhiteboardBinding({
    doc: ctx.doc,
    provider: ctx.provider,
    api,
    readOnly: ctx.readOnly,
    uploadImage: (file) => uploadBoardImage(file, ctx.pageId),
    loadImage: loadBoardImage,
    restore: (elements) => restoreElements(elements as any, null) as any,
    keepAlive: ctx.keepAlive,
  });

  // the last view's flushes run before the provider is let go: the pending
  // scene is pushed, then the preview is saved and holds the provider until
  // its record and the stored-time bump have been written
  useEffect(
    () =>
      ctx.registerFlush(() => {
        binding.flush();
        saveIfStale.current();
      }),
    [ctx.registerFlush, binding.flush],
  );

  useEffect(() => {
    api?.updateScene({ collaborators: binding.collaborators });
  }, [api, binding.collaborators]);

  // what the unmount needs, kept current
  const latest = useRef({ api, ctx, nodeProps });
  latest.current = { api, ctx, nodeProps };
  // Excalidraw empties its scene while unmounting, so keep the last one it reported
  const lastScene = useRef<{ elements: readonly any[]; files: any }>({
    elements: [],
    files: {},
  });
  const saving = useRef<Promise<unknown> | null>(null);
  // a scene from before the first sync is empty or partial: never a preview
  const syncedOnce = useRef(false);
  if (ctx.synced) syncedOnce.current = true;

  // saved whenever the scene differs from the one the stored preview shows,
  // whoever drew it; on close, and (best effort) when the tab is hidden or closed
  const saveIfStale = useRef(() => {
    const { api: canvas, ctx: room, nodeProps: props } = latest.current;
    if (!canvas || saving.current || !syncedOnce.current) return;
    const elements = lastScene.current.elements.filter((e) => !e.isDeleted);
    const attachmentId = props.node.attrs.attachmentId ?? null;
    if (
      !shouldSavePreview({
        isEditor: !room.readOnly,
        sceneDiffers: previewNeedsSaving(room.doc, elements, attachmentId),
      })
    ) {
      return;
    }
    const work = savePreview({
      doc: room.doc,
      elements,
      files: lastScene.current.files,
      pageId: room.pageId,
      attachmentId,
      nodeProps: props,
    })
      .catch(() => undefined)
      .finally(() => {
        saving.current = null;
      });
    saving.current = work;
    room.keepAlive(work);
  });

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        binding.flush();
        saveIfStale.current();
      }
    };
    const onPageHide = () => {
      binding.flush();
      saveIfStale.current();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [binding.flush]);

  return (
    <div
      style={{ flex: 1, minHeight: 0, height: "100%" }}
      data-testid="whiteboard-canvas"
    >
      <Suspense
        fallback={
          <div
            style={{ display: "flex", justifyContent: "center", padding: 24 }}
          >
            <Loader size="sm" />
          </div>
        }
      >
        <Excalidraw
          // after Excalidraw has loaded its initial scene, which would otherwise replace ours
          onInitialize={(next) => setApi(next)}
          onPaste={pasteShareLinkAsEmbed}
          onChange={(elements, appState, files) => {
            lastScene.current = { elements, files };
            binding.onChange(elements, appState, files);
          }}
          onPointerUpdate={binding.onPointerUpdate}
          isCollaborating
          validateEmbeddable={isSafeEmbedLink}
          viewModeEnabled={ctx.readOnly}
          theme={colorScheme}
          initialData={{ scrollToContent: true }}
        />
      </Suspense>
    </div>
  );
}
