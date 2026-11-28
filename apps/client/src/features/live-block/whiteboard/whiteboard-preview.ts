import { useSyncExternalStore } from "react";
import type * as Y from "yjs";

/** An editor saves the preview when the scene differs from the one the stored preview shows. */
export function shouldSavePreview(args: {
  isEditor: boolean;
  sceneDiffers: boolean;
}): boolean {
  return args.isEditor && args.sceneDiffers;
}

type SceneElement = {
  id: string;
  version?: number;
  versionNonce?: number;
  isDeleted?: boolean;
};

/** Identifies what the scene looks like: every live element's id and version. */
export function sceneFingerprint(elements: readonly SceneElement[]): string {
  const parts = elements
    .filter((e) => !e.isDeleted)
    .map((e) => `${e.id}:${e.version ?? 0}:${e.versionNonce ?? 0}`)
    .sort();
  let hash = 5381;
  const text = parts.join("|");
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `${parts.length}-${(hash >>> 0).toString(36)}`;
}

// what the stored preview was made from, kept in the board's own document so
// every editor (not only the one who drew) knows whether it is stale
const PREVIEW_MAP = "preview";

export function readPreviewMeta(doc: Y.Doc): {
  scene: string | null;
  attachmentId: string | null;
} {
  const map = doc.getMap<unknown>(PREVIEW_MAP);
  const scene = map.get("scene");
  const attachmentId = map.get("attachmentId");
  return {
    scene: typeof scene === "string" ? scene : null,
    attachmentId: typeof attachmentId === "string" ? attachmentId : null,
  };
}

export function writePreviewMeta(
  doc: Y.Doc,
  scene: string,
  attachmentId: string,
) {
  doc.transact(() => {
    const map = doc.getMap<unknown>(PREVIEW_MAP);
    map.set("scene", scene);
    map.set("attachmentId", attachmentId);
  });
}

export function previewNeedsSaving(
  doc: Y.Doc,
  elements: readonly SceneElement[],
  nodeAttachmentId: string | null,
): boolean {
  const live = elements.filter((e) => !e.isDeleted);
  // an empty board with no preview has nothing to show
  if (live.length === 0 && !nodeAttachmentId) return false;
  const meta = readPreviewMeta(doc);
  return (
    !nodeAttachmentId ||
    meta.attachmentId !== nodeAttachmentId ||
    meta.scene !== sceneFingerprint(live)
  );
}

// When this tab last replaced a preview file. The page keeps one src for the
// preview, so the image URL is versioned at render time instead.
const savedAt = new Map<string, number>();
const listeners = new Set<() => void>();

export function markPreviewSaved(attachmentId: string, at = Date.now()) {
  savedAt.set(attachmentId, at);
  listeners.forEach((listener) => listener());
}

export function usePreviewSavedAt(attachmentId: string | null): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (attachmentId ? (savedAt.get(attachmentId) ?? 0) : 0),
  );
}

/** The preview URL with a version, so a replaced file is not served from cache. */
export function previewUrl(
  src: string,
  versions: (number | string | undefined)[],
) {
  const version = Math.max(
    0,
    ...versions.map((v) =>
      typeof v === "string" ? Date.parse(v) || 0 : (v ?? 0),
    ),
  );
  if (!version) return src;
  return `${src}${src.includes("?") ? "&" : "?"}v=${version}`;
}
