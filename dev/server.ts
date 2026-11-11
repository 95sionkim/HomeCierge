// 화면 팀의 로컬 연동용 서버. 배포와 동일한 요청 처리기를 사용한다.
import { createServer } from 'node:http';
import { createHandler } from '../src/server/handler.js';
import { createBackend } from '../src/server/supabase.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
const handle = createHandler({ env: process.env, createBackend });
const server = createServer(async (incoming, outgoing) => {
  incoming.resume(); // 현재 API는 본문을 받지 않는다.
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else if (value) for (const item of value) headers.append(name, item);
    }
    const request = new Request(new URL(incoming.url ?? '/', `http://127.0.0.1:${port}`), {
      method: incoming.method, headers,
    });
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    outgoing.end('{"error":"internal_error"}');
  }
});
server.listen(port, '127.0.0.1', () => console.info(`HomeCierge API: http://127.0.0.1:${port}`));
