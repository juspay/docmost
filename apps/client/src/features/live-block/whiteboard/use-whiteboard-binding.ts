import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type {
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  SocketId,
} from "@excalidraw/excalidraw/types";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  pushElements,
  readElements,
  readFiles,
  reconcileElements,
  setFile,
  type WhiteboardElement,
  canonicalEmbedLink,
} from "@docmost/live-blocks";
import { LOCAL_ORIGIN } from "../hooks/use-block-undo";
import { dataUrlToFile, isAttachmentId } from "./whiteboard-files";
import { safePeerColor } from "../components/peer-color";

// mindspace's scene throttle
const PUSH_THROTTLE_MS = 120;
const POINTER_THROTTLE_MS = 50;

/** The scene with every embed link in canonical form, or null when nothing changed. */
function canonicalizeEmbeds(
  elements: readonly WhiteboardElement[],
): WhiteboardElement[] | null {
  let changed = false;
  const out = elements.map((el) => {
    if (el.type !== "embeddable" || el.isDeleted) return el;
    const canonical = canonicalEmbedLink(el.link);
    if (canonical === null || canonical === el.link) return el;
    changed = true;
    return {
      ...el,
      link: canonical,
      version: (typeof el.version === "number" ? el.version : 0) + 1,
    };
  });
  return changed ? out : null;
}
const MAX_DOWNLOAD_TRIES = 5;
// CaptureUpdateAction.NEVER: a remote change must not enter this person's undo stack
const CAPTURE_NEVER = "NEVER";

type Restore = (elements: WhiteboardElement[]) => readonly WhiteboardElement[];

export type WhiteboardBindingArgs = {
  doc: Y.Doc;
  provider: Pick<HocuspocusProvider, "awareness" | "setAwarenessField">;
  api: ExcalidrawImperativeAPI | null;
  readOnly: boolean;
  /** stores the image and resolves to its attachment id */
  uploadImage: (file: File) => Promise<string>;
  /** resolves to a data URL */
  loadImage: (attachmentId: string) => Promise<string>;
  /** Excalidraw's restoreElements; the view passes it once Excalidraw is loaded */
  restore?: Restore;
  /** holds the board's document until an upload has written its reference */
  keepAlive?: (work: Promise<unknown>) => void;
};

function byIndex(a: WhiteboardElement, b: WhiteboardElement) {
  const ia = typeof a.index === "string" ? a.index : null;
  const ib = typeof b.index === "string" ? b.index : null;
  if (ia === ib) return 0;
  if (ia === null) return 1;
  if (ib === null) return -1;
  return ia < ib ? -1 : 1;
}

/** leading call now, then at most one trailing call per window */
function throttle(fn: () => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    last = Date.now();
    fn();
  };
  return {
    call() {
      if (timer) return;
      const wait = last + ms - Date.now();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    },
    flush() {
      if (!timer) return;
      clearTimeout(timer);
      run();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function useWhiteboardBinding(args: WhiteboardBindingArgs) {
  const { t } = useTranslation();
  const { doc, provider, api, readOnly } = args;
  const argsRef = useRef(args);
  argsRef.current = args;

  const pending = useRef<{
    elements: readonly WhiteboardElement[];
    files: BinaryFiles;
  } | null>(null);
  const uploading = useRef(new Set<string>());
  const loading = useRef(new Set<string>());
  const failedUploads = useRef(new Set<string>());
  // per image: attempts so far and when the next one may start
  const uploadBackoff = useRef(
    new Map<string, { attempts: number; next: number }>(),
  );
  const downloadAttempts = useRef(new Map<string, number>());
  const given = useRef(new Set<string>());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      // a notice about this board's uploads means nothing once it is closed
      for (const fileId of failedUploads.current) {
        notifications.hide(`whiteboard-upload-${fileId}`);
      }
    },
    [],
  );

  const uploadNewFiles = useCallback(
    (files: BinaryFiles) => {
      const shared = readFiles(doc);
      for (const [fileId, file] of Object.entries(files ?? {})) {
        if (shared[fileId] || uploading.current.has(fileId) || !file?.dataURL)
          continue;
        const waiting = uploadBackoff.current.get(fileId);
        if (waiting && Date.now() < waiting.next) continue;
        uploading.current.add(fileId);
        const mimeType = file.mimeType;
        const ext = mimeType.split("/")[1] ?? "bin";
        const work = argsRef.current
          .uploadImage(
            dataUrlToFile(file.dataURL, `whiteboard-image.${ext}`, mimeType),
          )
          .then((attachmentId) => {
            setFile(doc, fileId, { attachmentId, mimeType }, LOCAL_ORIGIN);
            uploadBackoff.current.delete(fileId);
            if (failedUploads.current.delete(fileId)) {
              notifications.hide(`whiteboard-upload-${fileId}`);
            }
          })
          .catch(() => {
            // retried on a later change after 5 s, doubling to 5 min; one notice per image
            const attempts =
              (uploadBackoff.current.get(fileId)?.attempts ?? 0) + 1;
            uploadBackoff.current.set(fileId, {
              attempts,
              next: Date.now() + Math.min(300_000, 5_000 * 2 ** (attempts - 1)),
            });
            if (failedUploads.current.has(fileId)) return;
            failedUploads.current.add(fileId);
            notifications.show({
              id: `whiteboard-upload-${fileId}`,
              color: "red",
              autoClose: false,
              message: t(
                "An image could not be added to the whiteboard. It will be retried.",
              ),
            });
          })
          .finally(() => {
            // a failure is retried on the next change
            uploading.current.delete(fileId);
          });
        // closing the board must not lose the reference the upload will write
        argsRef.current.keepAlive?.(work);
      }
    },
    [doc, t],
  );

  const pusher = useMemo(
    () =>
      throttle(() => {
        const next = pending.current;
        pending.current = null;
        if (!next || argsRef.current.readOnly) return;
        pushElements(doc, next.elements as WhiteboardElement[], LOCAL_ORIGIN);
        uploadNewFiles(next.files);
      }, PUSH_THROTTLE_MS),
    [doc, uploadNewFiles],
  );
  useEffect(() => () => pusher.cancel(), [pusher]);

  const onChange = useCallback<NonNullable<ExcalidrawProps["onChange"]>>(
    (elements, _appState, files) => {
      if (argsRef.current.readOnly) return;
      // a pasted share link (watch?v=, youtu.be, vimeo.com/1, a Figma file)
      // becomes the canonical embed link before Excalidraw renders or we store
      // it, so the author sees what everyone else sees
      const rewritten = canonicalizeEmbeds(
        elements as unknown as readonly WhiteboardElement[],
      );
      if (rewritten) {
        argsRef.current.api?.updateScene({
          elements: rewritten as any,
          captureUpdate: CAPTURE_NEVER as any,
        });
        elements = rewritten as any;
      }
      pending.current = {
        elements: elements as unknown as readonly WhiteboardElement[],
        files,
      };
      pusher.call();
    },
    [pusher],
  );

  const flush = useCallback(() => pusher.flush(), [pusher]);

  const applyRemote = useCallback(() => {
    const canvas = argsRef.current.api;
    if (!canvas) return;
    const restore =
      argsRef.current.restore ?? ((els: WhiteboardElement[]) => els);
    const remote = restore(readElements(doc)) as WhiteboardElement[];
    const current =
      canvas.getSceneElementsIncludingDeleted() as unknown as WhiteboardElement[];
    const merged = reconcileElements(current, remote).sort(byIndex);
    canvas.updateScene({
      elements: merged as any,
      captureUpdate: CAPTURE_NEVER as any,
    });
    // a local copy that beats what landed is written again, so it settles on the higher version
    if (!argsRef.current.readOnly) pushElements(doc, current, LOCAL_ORIGIN);
  }, [doc]);

  const loadMissingRef = useRef(() => undefined as void);
  const loadMissingFiles = useCallback(() => {
    const canvas = argsRef.current.api;
    if (!canvas) return;
    const have = canvas.getFiles() ?? {};
    for (const [fileId, ref] of Object.entries(readFiles(doc))) {
      if (
        have[fileId] ||
        loading.current.has(fileId) ||
        given.current.has(fileId)
      )
        continue;
      // written by any editor: never let anything but an attachment id near a URL
      if (!isAttachmentId(ref.attachmentId)) continue;
      loading.current.add(fileId);
      argsRef.current
        .loadImage(ref.attachmentId)
        .then((dataURL) => {
          argsRef.current.api?.addFiles([
            {
              id: fileId,
              mimeType: ref.mimeType,
              dataURL,
              created: Date.now(),
            } as any,
          ]);
        })
        .catch((err) => {
          loading.current.delete(fileId);
          // retried with a growing delay, so a passing network failure does not
          // leave a hole; a missing or non-image file, or 5 failures, is final
          const attempt = (downloadAttempts.current.get(fileId) ?? 0) + 1;
          downloadAttempts.current.set(fileId, attempt);
          const status = (err as { status?: number })?.status;
          if (
            status === 404 ||
            status === 415 ||
            attempt >= MAX_DOWNLOAD_TRIES
          ) {
            given.current.add(fileId);
            return;
          }
          if (retryTimer.current) return;
          const delay = Math.min(60_000, 2000 * 2 ** (attempt - 1));
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            loadMissingRef.current();
          }, delay);
        });
    }
  }, [doc]);
  loadMissingRef.current = loadMissingFiles;

  useEffect(() => {
    const elements = doc.getMap("elements");
    const files = doc.getMap("files");
    const onElements = (_e: unknown, tr: Y.Transaction) => {
      if (tr.origin !== LOCAL_ORIGIN) applyRemote();
    };
    const onFiles = () => loadMissingFiles();
    elements.observe(onElements);
    files.observe(onFiles);
    return () => {
      elements.unobserve(onElements);
      files.unobserve(onFiles);
    };
  }, [doc, applyRemote, loadMissingFiles]);

  // the canvas starts from what is already in the document
  useEffect(() => {
    if (!api) return;
    if (readElements(doc).length > 0) applyRemote();
    loadMissingFiles();
  }, [api, doc, applyRemote, loadMissingFiles]);

  // presence
  const pointerState = useRef<{ pointer: unknown; button: unknown } | null>(
    null,
  );
  const pointerSender = useMemo(
    () =>
      throttle(() => {
        const state = pointerState.current;
        if (!state) return;
        provider.setAwarenessField("pointer", state.pointer);
        provider.setAwarenessField("button", state.button);
      }, POINTER_THROTTLE_MS),
    [provider],
  );
  useEffect(() => () => pointerSender.cancel(), [pointerSender]);

  const onPointerUpdate = useCallback<
    NonNullable<ExcalidrawProps["onPointerUpdate"]>
  >(
    (payload) => {
      pointerState.current = {
        pointer: payload.pointer,
        button: payload.button,
      };
      pointerSender.call();
    },
    [pointerSender],
  );

  const [collaborators, setCollaborators] = useState<
    Map<SocketId, Collaborator>
  >(new Map());
  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    const update = () => {
      const next = new Map<SocketId, Collaborator>();
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID || !state?.user) return;
        const color = safePeerColor(state.user.color);
        next.set(String(clientId) as SocketId, {
          id: state.user.id,
          username: state.user.name,
          pointer: state.pointer ?? undefined,
          button: state.button ?? undefined,
          color: { background: color, stroke: color },
          socketId: String(clientId) as SocketId,
        });
      });
      setCollaborators(next);
    };
    update();
    awareness.on("change", update);
    return () => awareness.off("change", update);
  }, [provider]);

  return { onChange, onPointerUpdate, collaborators, flush, readOnly };
}
