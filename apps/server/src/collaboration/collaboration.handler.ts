import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import { setYjsMark, updateYjsMarkAttribute, YjsSelection } from './yjs.util';
import * as Y from 'yjs';
import { User } from '@docmost/db/types/entity.types';
import { isLiveBlockNodeType } from '../core/live-block/page-content.util';
import { lossyNodeTypes } from '../core/agent-mcp/markdown-loss';
import {
  applyOps,
  LiveBlockInputError,
  LiveBlockKind,
  LiveBlockOp,
  parseDocumentName,
} from '@docmost/live-blocks';

export type CollabEventHandlers = ReturnType<
  CollaborationHandler['getHandlers']
>;

// Live blocks in document order. A block nested in another node is still
// found; it is re-added at the end of the page.
function collectLiveBlocks(
  parent: Y.XmlFragment | Y.XmlElement,
): Y.XmlElement[] {
  const found: Y.XmlElement[] = [];
  parent.forEach((child) => {
    if (!(child instanceof Y.XmlElement)) return;
    if (isLiveBlockNodeType(child.nodeName)) {
      found.push(child);
    } else {
      found.push(...collectLiveBlocks(child));
    }
  });
  return found;
}

// Keeps an incoming block node only where it names a live block of the same
// kind, and only the first time; every other block node is dropped. `placed`
// collects the ids that stay.
function keepKnownLiveBlocks(
  node: any,
  live: Map<string, Y.XmlElement>,
  placed: Set<string>,
): any {
  if (!node || typeof node !== 'object' || !Array.isArray(node.content)) {
    return node;
  }
  const content: any[] = [];
  for (const child of node.content) {
    if (isLiveBlockNodeType(child?.type)) {
      const id = child.attrs?.blockId;
      if (
        typeof id === 'string' &&
        live.get(id)?.nodeName === child.type &&
        !placed.has(id)
      ) {
        placed.add(id);
        content.push(child);
      }
      continue;
    }
    content.push(keepKnownLiveBlocks(child, live, placed));
  }
  return { ...node, content };
}

// Swaps each block node built from the incoming content for the live copy,
// so every attribute (and anything the schema does not know) comes from it.
function swapInLiveCopies(
  parent: Y.XmlFragment | Y.XmlElement,
  copies: Map<string, Y.XmlElement>,
): void {
  parent.toArray().forEach((child, index) => {
    if (!(child instanceof Y.XmlElement)) return;
    if (isLiveBlockNodeType(child.nodeName)) {
      const copy = copies.get(child.getAttribute('blockId') as string);
      if (copy) {
        parent.delete(index, 1);
        parent.insert(index, [copy]);
      }
      return;
    }
    swapInLiveCopies(child, copies);
  });
}

// Node and mark names only, enough to ask which types a page holds. Works for
// node types the editor schema does not know.
function fragmentToJson(parent: Y.XmlFragment | Y.XmlElement): any {
  const content: any[] = [];
  parent.forEach((child) => {
    if (child instanceof Y.XmlText) {
      for (const d of child.toDelta()) {
        content.push({
          type: 'text',
          text: String(d.insert ?? ''),
          marks: Object.keys(d.attributes ?? {}).map((type) => ({ type })),
        });
      }
    } else if (child instanceof Y.XmlElement) {
      content.push(fragmentToJson(child));
    }
  });
  return parent instanceof Y.XmlElement
    ? { type: parent.nodeName, content }
    : { type: 'doc', content };
}

@Injectable()
export class CollaborationHandler {
  private readonly logger = new Logger(CollaborationHandler.name);

  constructor() {}

  getHandlers(hocuspocus: Hocuspocus) {
    return {
      getConnectedUserIds: async (documentName: string) => {
        const document = hocuspocus.documents.get(documentName);
        if (!document) return [];

        const userIds = new Set<string>();
        for (const state of document.awareness.getStates().values()) {
          const userId = state?.user?.id;
          if (typeof userId === 'string') userIds.add(userId);
        }
        return [...userIds];
      },
      flushDocument: async (documentName: string, _payload: object = {}) => {
        await this.flushPendingStore(hocuspocus, documentName);
      },
      // both live block handlers return true: the gateway answers undefined when no handler ran
      flushLiveBlock: async (documentName: string, _payload: object = {}) => {
        if (parseDocumentName(documentName).type !== 'block') {
          throw new Error(`Not a live block document: ${documentName}`);
        }
        await this.flushPendingStore(hocuspocus, documentName);
        return true;
      },
      applyLiveBlockOps: async (
        documentName: string,
        payload: { kind: LiveBlockKind; ops: LiveBlockOp[]; user: User },
      ) => {
        if (parseDocumentName(documentName).type !== 'block') {
          throw new Error(`Not a live block document: ${documentName}`);
        }
        const { kind, ops, user } = payload;
        try {
          await this.withYdocConnection(
            hocuspocus,
            documentName,
            { user },
            (doc) => applyOps(kind, doc, ops),
          );
        } catch (err) {
          // an HttpException travels back to a caller on another server
          if (err instanceof LiveBlockInputError) {
            throw new BadRequestException(err.message);
          }
          throw err;
        }
        return true;
      },
      alterState: async (documentName: string, payload: { pageId: string }) => {
        // dummy
        // this.logger.log('Processing', documentName, payload);
        // await this.withYdocConnection(hocuspocus, documentName, {}, (doc) => {
        //   const fragment = doc.getXmlFragment('default');
        //});
      },
      setCommentMark: async (
        documentName: string,
        payload: {
          yjsSelection: YjsSelection;
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { yjsSelection, commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            setYjsMark(doc, fragment, yjsSelection, 'comment', {
              commentId,
              resolved,
            });
          },
        );
      },
      resolveCommentMark: async (
        documentName: string,
        payload: {
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            updateYjsMarkAttribute(
              fragment,
              'comment',
              { name: 'commentId', value: commentId },
              { resolved },
            );
          },
        );
      },
      updatePageContent: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          operation: string;
          user: User;
        },
      ) => {
        const { prosemirrorJson, operation, user } = payload;
        this.logger.debug('Updating page content via yjs', documentName);
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');

            if (operation === 'replace') {
              if (fragment.length > 0) {
                fragment.delete(0, fragment.length);
              }

              const newDoc = TiptapTransformer.toYdoc(
                prosemirrorJson,
                'default',
                tiptapExtensions,
              );
              Y.applyUpdate(doc, Y.encodeStateAsUpdate(newDoc));
            } else {
              const newContent = prosemirrorJson.content || [];
              const yElements = newContent.map(prosemirrorNodeToYElement);
              const position = operation === 'prepend' ? 0 : fragment.length;
              fragment.insert(position, yElements);
            }
          },
        );
      },
      // Replaces the page body but carries the live blocks (whiteboard, todo
      // board, sheet) over from the open document. The blocks are copied as Yjs
      // elements, so this works for any node type, schema-known or not, and a
      // block added seconds ago (not yet stored) is kept.
      // A block node in the incoming content whose id is a live block of the
      // open document keeps that block in that place; any other block node is
      // dropped. Live blocks the content leaves out are added at the end, or
      // removed only when named in `removeBlockIds`.
      replacePageContentKeepingLiveBlocks: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          user: User;
          allowLossy?: boolean;
          removeBlockIds?: string[];
        },
      ): Promise<{
        keptBlocks: number;
        appendedBlocks: number;
        removedBlocks: number;
        removedBlockIds: string[];
        refusedLossy: string[];
      }> => {
        const { prosemirrorJson, user, allowLossy } = payload;
        const named = new Set(payload.removeBlockIds ?? []);
        const result = {
          keptBlocks: 0,
          appendedBlocks: 0,
          removedBlocks: 0,
          removedBlockIds: [] as string[],
          refusedLossy: [] as string[],
        };
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');

            // Checked on the live fragment, in this same transaction, so what is
            // judged is exactly what is about to be replaced. Nothing is written
            // when it is refused.
            if (!allowLossy) {
              result.refusedLossy = lossyNodeTypes(fragmentToJson(fragment));
              if (result.refusedLossy.length > 0) return;
            }

            // clone before the delete: a deleted element cannot be copied
            const copies = new Map<string, Y.XmlElement>();
            const unnamed: Y.XmlElement[] = [];
            for (const block of collectLiveBlocks(fragment)) {
              const id = block.getAttribute('blockId');
              if (typeof id === 'string' && id && !copies.has(id)) {
                copies.set(id, block.clone());
              } else {
                unnamed.push(block.clone());
              }
            }

            const placed = new Set<string>();
            const incoming = keepKnownLiveBlocks(
              prosemirrorJson,
              copies,
              placed,
            );

            if (fragment.length > 0) {
              fragment.delete(0, fragment.length);
            }
            const newDoc = TiptapTransformer.toYdoc(
              incoming,
              'default',
              tiptapExtensions,
            );
            Y.applyUpdate(doc, Y.encodeStateAsUpdate(newDoc));
            swapInLiveCopies(fragment, copies);

            // a block is removed only when it is missing AND named; anything
            // else missing (a block added after the agent's read, say) is kept
            const toRemove = [...copies.keys()].filter(
              (id) => !placed.has(id) && named.has(id),
            );
            const missing = [
              ...[...copies]
                .filter(([id]) => !placed.has(id) && !named.has(id))
                .map(([, b]) => b),
              ...unnamed,
            ];
            result.keptBlocks = placed.size;
            result.removedBlocks = toRemove.length;
            result.removedBlockIds = toRemove;
            if (missing.length > 0) {
              fragment.insert(fragment.length, missing);
              result.appendedBlocks = missing.length;
            }
          },
        );
        return result;
      },
    };
  }

  async withYdocConnection(
    hocuspocus: Hocuspocus,
    documentName: string,
    context: any = {},
    fn: (doc: Document) => void,
  ): Promise<void> {
    // store pending edits first so they are not saved under this connection's user
    await this.flushPendingStore(hocuspocus, documentName);
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      context,
    );
    try {
      await connection.transact(fn);
    } finally {
      await connection.disconnect();
    }
  }

  private async flushPendingStore(
    hocuspocus: Hocuspocus,
    documentName: string,
  ): Promise<void> {
    const document = hocuspocus.documents.get(documentName);
    if (!document || document.isLoading) return;
    await hocuspocus.debouncer.executeNow(`onStoreDocument-${documentName}`);
  }
}
