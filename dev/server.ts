// 화면 팀의 로컬 연동용 서버. 배포와 동일한 요청 처리기를 사용한다.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createHandler } from '../src/server/handler.js';
import { createBackend } from '../src/server/supabase.js';
import { serveWorkspace } from './static.js';

export function createDevServer(handle: (request: Request) => Promise<Response>) {
  return createServer(async (incoming, outgoing) => {
    const connection = new AbortController();
    incoming.once('error', () => connection.abort());
    outgoing.once('close', () => connection.abort());
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (value) for (const item of value) headers.append(name, item);
      }
      const port = incoming.socket.localPort;
      const hostname = incoming.headers.host === `localhost:${port}` ? 'localhost' : '127.0.0.1';
      const base = `http://${hostname}:${port}`;
      const init: RequestInit & { duplex?: 'half' } = {
        method: incoming.method, headers, signal: connection.signal,
      };
      if (incoming.method === 'POST' || incoming.method === 'PATCH') {
        // 크기 제한으로 읽기를 멈춰도 오류 응답을 보내기 전에는 소켓을 닫지 않는다.
        const body = NodeReadableStream.from<Uint8Array>(incoming.iterator({ destroyOnReturn: false }));
        init.body = body as unknown as ReadableStream<Uint8Array>;
        init.duplex = 'half';
      } else incoming.resume();

      const request = new Request(new URL(incoming.url ?? '/', base), init);
      const response = await handle(request);
      if (outgoing.destroyed) {
        await response.body?.cancel();
        return;
      }
      if (init.body && !incoming.readableEnded) outgoing.setHeader('Connection', 'close');
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        // Node의 Fetch 본문은 Web Stream이다. DOM과 Node의 타입 선언을 연결한다.
        const body = response.body as unknown as NodeReadableStream<Uint8Array>;
        await pipeline(Readable.fromWeb(body), outgoing);
      } else outgoing.end();
    } catch {
      if (outgoing.headersSent || outgoing.destroyed) {
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end('{"error":"internal_error"}');
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  const api = createHandler({ env: process.env, createBackend });
  const server = createDevServer(request => serveWorkspace(request, api));
  server.listen(port, '127.0.0.1', () => console.info(`HomeCierge http://127.0.0.1:${port}`));
}
