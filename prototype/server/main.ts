/**
 * Transport: one HTTP server that serves the built client and accepts the
 * WebSocket on the same port.
 *
 * One port matters more than it looks. Two services means two URLs, two TLS
 * certificates and a CORS/mixed-content problem the moment anything is served
 * over HTTPS — and a phone is *always* over HTTPS, because a browser will not
 * open a plain `ws://` from a secure page. Serving the client from the process
 * that owns the socket means the page and its server are same-origin by
 * construction: `wss://` works because the host's TLS already terminates in
 * front of this, and there is exactly one thing to deploy.
 *
 * Node 22 runs this file directly — no build step for the server.
 *
 * The rules live in `world.ts`; what a packet means lives in `session.ts`.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { TICK_MS, TICK_RATE } from '../shared/constants.ts';
import { Session } from './session.ts';
import type { Transport } from './session.ts';

const PORT = Number(process.env.PORT ?? 8080);
const BOTS = Number(process.env.BOTS ?? 0);

const ROOT = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const bootTime = Date.now();
/** ms since boot — the only clock the protocol speaks. */
const uptime = (): number => Date.now() - bootTime;

/* ---------------------------------------------------------------------- */
/* Static files                                                            */
/* ---------------------------------------------------------------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(ROOT)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('No build found. Run "npm run build" first, or "npm run dev" for the Vite server.');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  // normalize() collapses "..", and the prefix check catches anything that
  // still tries to climb out of the build directory.
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, requested);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (!existsSync(file) || statSync(file).isDirectory()) file = join(ROOT, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  // The hashed asset filenames Vite emits are safe to cache forever; the entry
  // document is not, or a deploy never reaches anyone.
  const cache = file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable';

  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  createReadStream(file).pipe(res);
}

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ ok: true, players: session.population, uptime: uptime() })
    );
    return;
  }
  serveStatic(req, res);
});

/* ---------------------------------------------------------------------- */
/* Sockets                                                                 */
/* ---------------------------------------------------------------------- */

const sockets = new Map<number, WebSocket>();

const transport: Transport = {
  send(connectionId, bytes) {
    const socket = sockets.get(connectionId);
    if (socket && socket.readyState === socket.OPEN) socket.send(bytes);
  },
  close(connectionId, reason) {
    sockets.get(connectionId)?.close(1002, reason);
  }
};

const session = new Session(transport, { bots: BOTS });

const wss = new WebSocketServer({ server: http });
let nextConnectionId = 1;

wss.on('connection', (socket) => {
  const connectionId = nextConnectionId++;
  socket.binaryType = 'nodebuffer';
  sockets.set(connectionId, socket);

  socket.on('message', (raw: Buffer) => {
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

    if (!session.isConnected(connectionId)) {
      const name = session.greet(connectionId, bytes, uptime());
      if (name) console.log(`[+] ${name} — ${session.population} in world`);
      return;
    }

    try {
      session.message(connectionId, bytes, uptime());
    } catch (error) {
      // A malformed packet is a client problem; it must not become a server one.
      console.warn(`[!] bad packet on #${connectionId}:`, (error as Error).message);
    }
  });

  socket.on('close', () => {
    const player = session.drop(connectionId);
    sockets.delete(connectionId);
    if (player) console.log(`[-] ${player.name} left — ${session.population} in world`);
  });

  socket.on('error', () => socket.terminate());
});

/* ---------------------------------------------------------------------- */
/* The loop                                                                */
/* ---------------------------------------------------------------------- */

let last = uptime();

setInterval(() => {
  const now = uptime();
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  session.tick(now, dt);
}, TICK_MS);

http.listen(PORT, () => {
  console.log(`slice on http://localhost:${PORT} — ${TICK_RATE} Hz, ${BOTS} bot(s)`);
  console.log(existsSync(ROOT) ? `serving ${ROOT}` : 'no build yet — use "npm run dev" for Vite');
});
