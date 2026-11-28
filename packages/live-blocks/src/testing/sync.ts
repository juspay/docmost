import * as Y from 'yjs';

/** A doc with a fixed client id, so a test can decide which concurrent write Yjs keeps. */
export function docWithClientId(id: number): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = id;
  return doc;
}

function exchange(a: Y.Doc, b: Y.Doc, origin: unknown) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), origin);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), origin);
}

/** Joins two docs in memory, as two clients of one sync server would be. */
export function connect(
  a: Y.Doc,
  b: Y.Doc,
): { disconnect(): void; reconnect(): void } {
  const origin = Symbol('live-blocks-test-sync');
  let live = false;
  const forward = (to: Y.Doc) => (update: Uint8Array, from: unknown) => {
    if (live && from !== origin) Y.applyUpdate(to, update, origin);
  };
  const toB = forward(b);
  const toA = forward(a);
  a.on('update', toB);
  b.on('update', toA);

  const reconnect = () => {
    live = true;
    exchange(a, b, origin);
  };
  reconnect();

  return {
    disconnect() {
      live = false;
    },
    reconnect,
  };
}
