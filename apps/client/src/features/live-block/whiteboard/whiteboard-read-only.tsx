import { lazy, Suspense, useEffect, useState } from "react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Loader, Text, useComputedColorScheme } from "@mantine/core";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import {
  isSafeEmbedLink,
  sanitizeElements,
  type LiveBlockSnapshot,
  type WhiteboardSnapshot,
} from "@docmost/live-blocks";
import { getFileUrl } from "@/lib/config.ts";
import { lightboxRequestAtom } from "@/features/editor/atoms/editor-atoms";
import { useLiveBlockHost } from "../live-block-host";
import { loadBoardImage } from "./whiteboard-files";
import { previewUrl, usePreviewSavedAt } from "./whiteboard-preview";

// only loaded for a board that has no preview yet; the stylesheet loads
// with it so pages without such a board don't pay for it
const SnapshotScene = lazy(() =>
  Promise.all([
    import("@excalidraw/excalidraw"),
    import("@excalidraw/excalidraw/index.css"),
  ]).then(([m]) => ({
    default: function Scene(props: {
      snapshot: WhiteboardSnapshot;
      files: any;
    }) {
      const scheme = useComputedColorScheme();
      return (
        <m.Excalidraw
          viewModeEnabled
          validateEmbeddable={isSafeEmbedLink}
          zenModeEnabled
          theme={scheme}
          initialData={{
            // a stored snapshot may predate the checks: only what a viewer may see
            elements: sanitizeElements(props.snapshot.elements) as any,
            files: props.files,
            scrollToContent: true,
          }}
        />
      );
    },
  })),
);

function sceneKey(elements: readonly { id: string; version?: number }[]) {
  let key = String(elements.length);
  for (const el of elements) key += `|${el.id}:${el.version ?? 0}`;
  return key;
}

function useSnapshotFiles(
  snapshot: WhiteboardSnapshot | undefined,
  enabled: boolean,
) {
  const [files, setFiles] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    if (!snapshot || !enabled) {
      setFiles({});
      return;
    }
    let cancelled = false;
    Promise.all(
      Object.entries(snapshot.files ?? {}).map(async ([id, ref]) => {
        try {
          const dataURL = await loadBoardImage(ref.attachmentId);
          return [
            id,
            { id, mimeType: ref.mimeType, dataURL, created: Date.now() },
          ];
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setFiles(Object.fromEntries(entries.filter(Boolean)));
    });
    return () => {
      cancelled = true;
    };
  }, [snapshot, enabled]);
  return files;
}

export default function WhiteboardReadOnly({
  node,
  snapshot,
  updatedAt,
  local = false,
}: {
  node: PMNode;
  snapshot?: LiveBlockSnapshot;
  /** when the block was last stored; versions the preview URL */
  updatedAt?: string;
  /** the snapshot is this tab's own copy with unsaved edits: the saved preview is behind it */
  local?: boolean;
}) {
  const { t } = useTranslation();
  const host = useLiveBlockHost();
  const setLightbox = useSetAtom(lightboxRequestAtom);
  const src: string | null = local ? null : node.attrs.src || null;
  const board = snapshot as WhiteboardSnapshot | undefined;
  // signed-out visitors cannot read board images by id; they see the preview instead
  const files = useSnapshotFiles(board, !src && host.mode !== "share");
  const savedHere = usePreviewSavedAt(node.attrs.attachmentId ?? null);

  if (src) {
    const url = previewUrl(getFileUrl(src), [updatedAt, savedHere]);
    return (
      <img
        src={url}
        alt={node.attrs.title || t("Whiteboard")}
        data-whiteboard-preview
        style={{
          display: "block",
          maxWidth: "100%",
          maxHeight: 480,
          margin: "0 auto",
          objectFit: "contain",
          cursor: "zoom-in",
        }}
        onClick={() => setLightbox({ src: url, type: "image" } as any)}
      />
    );
  }

  if (!board?.elements?.length) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="lg">
        {t("Empty whiteboard")}
      </Text>
    );
  }

  return (
    <div style={{ height: 400 }}>
      {files && (
        <Suspense fallback={<Loader size="sm" />}>
          {/* Excalidraw reads initialData once: a changed scene is a new scene */}
          <SnapshotScene
            key={sceneKey(board.elements)}
            snapshot={board}
            files={files}
          />
        </Suspense>
      )}
    </div>
  );
}
