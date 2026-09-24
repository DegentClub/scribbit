/**
 * Tiny static server for the conformance directory (harness.html + dist/). Used by the Playwright tests
 * (random port) and by `pnpm --filter @bsh/wallet-kit conformance:serve` for manual runs with real
 * extensions. Module scripts and extensions behave differently on `file://`, so always serve over http.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFORMANCE_DIR } from './build.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

export interface ConformanceServer {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

export function startConformanceServer(port = 0, host = '127.0.0.1'): Promise<ConformanceServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = url.pathname === '/' ? '/harness.html' : url.pathname;
    const file = path.normalize(path.join(CONFORMANCE_DIR, rel));
    if (!file.startsWith(CONFORMANCE_DIR + path.sep) && file !== CONFORMANCE_DIR) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${rel}`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `http://${host}:${p}`,
        port: p,
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const port = Number(process.env.PORT ?? 4173);
  const s = await startConformanceServer(port, process.env.HOST ?? '127.0.0.1');
  console.log(`wallet-kit conformance harness: ${s.url}/harness.html?network=signet  (Ctrl-C to stop)`);
}
