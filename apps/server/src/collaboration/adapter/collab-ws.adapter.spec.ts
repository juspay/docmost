import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { CollabWsAdapter } from './collab-ws.adapter';

const LIMIT = 64 * 1024;

describe('CollabWsAdapter message size limit', () => {
  let server: Server;
  let adapter: CollabWsAdapter;
  let url: string;
  const received: number[] = [];

  beforeEach(async () => {
    received.length = 0;
    server = createServer();
    adapter = new CollabWsAdapter({ maxPayload: LIMIT });
    const wss = adapter.handleUpgrade('/collab', server);
    wss.on('connection', (ws) => {
      ws.on('message', (data: Buffer) => received.push(data.length));
      ws.on('error', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  });

  afterEach(async () => {
    adapter.destroy();
    await new Promise((r) => server.close(r));
  });

  async function send(size: number): Promise<{ closeCode?: number }> {
    const client = new WebSocket(url);
    await new Promise((r) => client.once('open', r));
    const closed = new Promise<number>((r) =>
      client.once('close', (code) => r(code)),
    );
    client.on('error', () => undefined);
    client.send(Buffer.alloc(size));
    // a message within the limit leaves the socket open; close it ourselves
    const timer = setTimeout(() => client.close(1000), 300);
    const closeCode = await closed;
    clearTimeout(timer);
    return { closeCode };
  }

  it('accepts a message at the limit', async () => {
    const { closeCode } = await send(LIMIT);
    expect(closeCode).toBe(1000);
    expect(received).toEqual([LIMIT]);
  });

  it('closes the socket with 1009 for a message over the limit', async () => {
    const { closeCode } = await send(LIMIT + 1);
    expect(closeCode).toBe(1009);
    expect(received).toEqual([]);
  });
});
