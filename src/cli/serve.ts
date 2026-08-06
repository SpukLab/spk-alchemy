import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

/**
 * Static server for the web app during development.
 *
 * getUserMedia requires a secure context, so on a phone this must be reached
 * over HTTPS or through a tunnel — plain http:// works only on localhost. The
 * README explains the options.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.wav': 'audio/wav', '.css': 'text/css; charset=utf-8',
};

export function serve(root = 'web', port = 8788): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/' || path.endsWith('/')) path += 'index.html';
    // Contain path traversal: never resolve outside the served root.
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, safe);
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        // Needed for any future SharedArrayBuffer/OPFS work; harmless today.
        'cross-origin-opener-policy': 'same-origin',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Alchemy web app: http://localhost:${port}/`);
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log(`  on this network: http://${a.address}:${port}/  (${name})`);
        }
      }
    }
    console.log('\nNote: microphone capture requires a secure context.');
    console.log('On a phone, reach this through HTTPS or a tunnel — plain http');
    console.log('works only on localhost.');
  });
}
