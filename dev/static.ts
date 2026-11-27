import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const root = new URL('../public/', import.meta.url);
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Vercel이 public/에서 제공하는 화면과 글꼴을 로컬에서도 같은 주소로 연다.
export async function serveWorkspace(request: Request, api: (request: Request) => Promise<Response>) {
  const { pathname } = new URL(request.url);
  if (pathname === '/api' || pathname.startsWith('/api/')) return api(request);
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (
    !/^(?:[\w-]+\/)*[\w.-]+$/.test(name) ||
    name.split('/').some((part) => part.startsWith('.')) ||
    !mime[extname(name)]
  ) {
    return new Response(null, { status: 404 });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  try {
    const file = await readFile(new URL(name, root));
    return new Response(request.method === 'HEAD' ? null : file, {
      headers: {
        'Content-Type': mime[extname(name)]!,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 });
    throw error;
  }
}
