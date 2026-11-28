import { registerKind } from '../registry';
import type { WhiteboardSnapshot } from '../snapshot';
import { validateScene } from './schema';
import { pushElements, readElements, readFiles, setFile } from './ydoc';

registerKind<WhiteboardSnapshot>({
  kind: 'whiteboard',
  empty: () => ({ kind: 'whiteboard', elements: [], files: {} }),
  build: (doc) => ({
    kind: 'whiteboard',
    elements: readElements(doc).filter((el) => el.isDeleted !== true),
    files: readFiles(doc),
  }),
  seed: (doc, snapshot) => {
    doc.transact(() => {
      pushElements(doc, snapshot.elements);
      for (const [fileId, ref] of Object.entries(snapshot.files ?? {})) {
        setFile(doc, fileId, ref);
      }
    });
  },
  validate: validateScene,
  staticNodes: (_snapshot, ctx) => {
    if (ctx.previewSrc) {
      return [
        { type: 'image', attrs: { src: ctx.previewSrc, alt: ctx.title } },
      ];
    }
    const text: Record<string, unknown> = {
      type: 'text',
      text: `Whiteboard: ${ctx.title}`,
    };
    if (ctx.openUrl) {
      text.marks = [{ type: 'link', attrs: { href: ctx.openUrl } }];
    }
    return [{ type: 'paragraph', content: [text] }];
  },
  attachmentIds: (doc) =>
    Object.values(readFiles(doc)).map((ref) => ref.attachmentId),
  remapAttachments: (doc, map) => {
    doc.transact(() => {
      for (const [fileId, ref] of Object.entries(readFiles(doc))) {
        const next = map.get(ref.attachmentId);
        if (next) setFile(doc, fileId, { ...ref, attachmentId: next });
      }
    });
  },
});
