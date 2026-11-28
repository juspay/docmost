import { Extension } from '@tiptap/core';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import {
  defaultNewId,
  LIVE_BLOCK_NODE_NAMES,
  type LiveBlockOrigin,
  withNewBlockId,
} from './origin';

export { liveBlockOrigin, type LiveBlockOrigin } from './origin';

export type LiveBlockIdentityOptions = { newId: () => string };

const isLiveBlock = (node: PMNode) =>
  LIVE_BLOCK_NODE_NAMES.includes(node.type.name);

function countIds(doc: PMNode): Map<string, number> {
  const counts = new Map<string, number>();
  doc.descendants((node) => {
    if (isLiveBlock(node) && node.attrs.blockId) {
      counts.set(node.attrs.blockId, (counts.get(node.attrs.blockId) ?? 0) + 1);
    }
    return !isLiveBlock(node);
  });
  return counts;
}

/**
 * No two live blocks in a document share an id. The first occurrence keeps
 * it; a later one that this person just made (paste, drag-copy, template) is
 * recorded as a copy of it, and one that came from merging two people's edits
 * becomes a new, empty block.
 */
export const LiveBlockIdentity = Extension.create<
  LiveBlockIdentityOptions,
  { origin: LiveBlockOrigin }
>({
  name: 'liveBlockIdentity',

  addOptions() {
    return { newId: defaultNewId };
  },

  addStorage() {
    return { origin: { created: new Set<string>(), copies: new Map() } };
  },

  addProseMirrorPlugins() {
    const { newId } = this.options;
    const origin = this.storage.origin;

    return [
      new Plugin({
        key: new PluginKey('liveBlockIdentity'),
        props: {
          transformPasted(slice: Slice) {
            slice.content.descendants((node) => {
              if (isLiveBlock(node) && node.attrs.blockId) {
                origin.copies.set(node.attrs.blockId, node.attrs.blockId);
              }
              return !isLiveBlock(node);
            });
            return slice;
          },
        },
        appendTransaction(transactions, oldState, newState) {
          const local = transactions.some(
            (tr) => tr.docChanged && !isChangeOrigin(tr),
          );
          if (!local) return null;

          const before = countIds(oldState.doc);
          const seen = new Map<string, number>();
          const tr = newState.tr;
          let changed = false;

          newState.doc.descendants((node, pos) => {
            if (!isLiveBlock(node)) return true;
            const id = node.attrs.blockId;
            if (!id) {
              const fresh = newId();
              origin.created.add(fresh);
              tr.setNodeMarkup(
                pos,
                undefined,
                withNewBlockId(node.attrs, fresh),
              );
              changed = true;
              return false;
            }
            const occurrence = seen.get(id) ?? 0;
            seen.set(id, occurrence + 1);
            if (occurrence === 0) return false;

            const fresh = newId();
            if (occurrence >= (before.get(id) ?? 0)) {
              origin.copies.set(fresh, id);
            } else {
              origin.created.add(fresh);
            }
            tr.setNodeMarkup(pos, undefined, withNewBlockId(node.attrs, fresh));
            changed = true;
            return false;
          });

          return changed ? tr : null;
        },
      }),
    ];
  },
});
