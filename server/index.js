'use strict';
/**
 * UNO ARENA — HTTP + Server-Sent Events server (zero dependencies).
 *
 *   GET  /                       static client (public/)
 *   GET  /healthz                liveness probe
 *   GET  /api/stats              { online, rooms, playing } — live counts only
 *   GET  /api/events?code&pid&token   SSE stream with per-player filtered state
 *   POST /api/rooms              create a room        { name, avatar, frame }
 *   POST /api/rooms/join         join a room          { code, name, avatar, frame }
 *   POST /api/rooms/resume       validate a session   { code, pid, token }
 *   POST /api/action             game / host action   { code, pid, token, type, ... }
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { RoomManager, MESSAGES, configFromEnv } = require('./rooms');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const STATUS_FOR_ERROR = {
  ROOM_NOT_FOUND: 404,
  AUTH: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  SERVER_BUSY: 503,
};

const MAX_BODY = 10 * 1024;
const MAX_SSE_PER_IP = 12;

class Bucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refill = refillPerSec;
    this.tokens = capacity;
    this.at = Date.now();
  }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) / 1000) * this.refill);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function createServer(options = {}) {
  const env = options.env || process.env;
  const config = { ...configFromEnv(env), ...(options.config || {}) };
  const manager = options.manager || new RoomManager({ config });
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, '..', 'public'));
  const trustProxy = env.TRUST_PROXY === '1' || options.trustProxy === true;
  const tickMs = Number(env.UNO_TICK_MS) > 0 ? Number(env.UNO_TICK_MS) : (options.tickMs || 250);
  const rate = options.rate || {};

  const buckets = new Map(); // `${kind}:${ip}` -> Bucket
  const sseByIp = new Map();
  const sseConns = new Set();

  function clientIp(req) {
    if (trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function allow(kind, ip) {
    const [cap, per] = ({
      action: [rate.action || 40, 20],
      lobby: [rate.lobby || 10, 0.5],
      read: [rate.read || 30, 10],
    })[kind];
    const key = kind + ':' + ip;
    let b = buckets.get(key);
    if (!b) { b = new Bucket(cap, per); buckets.set(key, b); }
    return b.take();
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - 120000;
    for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
  }, 60000);
  sweep.unref();

  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...headers,
    });
    res.end(data);
  }

  function sendResult(res, result) {
    if (result && result.ok) return send(res, 200, result);
    const status = STATUS_FOR_ERROR[result && result.error] || 400;
    return send(res, status, result || { ok: false, error: 'BAD_REQUEST', message: MESSAGES.BAD_REQUEST });
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers['content-type'] || '');
      if (!type.toLowerCase().startsWith('application/json')) return reject(new Error('type'));
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch (_) { return reject(new Error('origin')); }
        if (host !== req.headers.host) return reject(new Error('origin'));
      }
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { if (size - c.length <= MAX_BODY) reject(new Error('size')); return; } // stop buffering, keep draining
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new Error('json'));
          resolve(parsed);
        } catch (_) { reject(new Error('json')); }
      });
      req.on('error', () => reject(new Error('io')));
    });
  }

  // ---------------------------------------------------------------- static files

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (_) { return send(res, 400, 'Bad Request'); }
    if (rel.includes('\0')) return send(res, 400, 'Bad Request');
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(publicDir, '.' + path.posix.normalize(rel));
    if (file !== publicDir && !file.startsWith(publicDir + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        // Unknown extensionless route → app shell (deep links like /?room=ABC123 use the query string anyway)
        if (!path.extname(rel) && !rel.startsWith('/api/')) return serveFile(req, res, path.join(publicDir, 'index.html'));
        return send(res, 404, 'Not Found');
      }
      return serveFile(req, res, file, st);
    });
  }

  function serveFile(req, res, file, knownStat) {
    const finish = (st) => {
      const ext = path.extname(file).toLowerCase();
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ETag: etag,
        'Last-Modified': st.mtime.toUTCString(),
        ...SECURITY_HEADERS,
      };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    };
    if (knownStat) return finish(knownStat);
    return fs.stat(file, (err, st) => (err ? send(res, 404, 'Not Found') : finish(st)));
  }

  // ---------------------------------------------------------------- SSE

  function handleEvents(req, res, url) {
    const ip = clientIp(req);
    if ((sseByIp.get(ip) || 0) >= MAX_SSE_PER_IP) {
      return send(res, 429, { ok: false, error: 'RATE_LIMITED', message: MESSAGES.RATE_LIMITED });
    }
    const q = url.searchParams;
    const queue = []; // messages produced by subscribe() before the response headers are written
    let ready = false;
    const write = (text) => {
      if (res.writableLength > 1_000_000) { conn.close(); return; } // client is not reading: drop it
      res.write(text);
    };
    const conn = {
      alive: true,
      send(obj) {
        if (!this.alive) return;
        if (!ready) { queue.push(obj); return; }
        write(`data: ${JSON.stringify(obj)}\n\n`);
      },
      ping() { if (this.alive && ready) write(': ping\n\n'); },
      close() { this.alive = false; try { res.end(); } catch (_) { /* ignore */ } },
    };
    const sub = manager.subscribe({ code: q.get('code'), pid: q.get('pid'), token: q.get('token') }, conn);
    if (!sub.ok) return sendResult(res, sub);
    sseByIp.set(ip, (sseByIp.get(ip) || 0) + 1);
    sseConns.add(conn);
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...SECURITY_HEADERS,
    });
    res.write('retry: 1500\n\n');
    ready = true;
    for (const obj of queue.splice(0)) conn.send(obj);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      conn.alive = false;
      sseConns.delete(conn);
      const left = (sseByIp.get(ip) || 1) - 1;
      if (left <= 0) sseByIp.delete(ip); else sseByIp.set(ip, left);
      sub.unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  // ---------------------------------------------------------------- router

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { return send(res, 400, 'Bad Request'); }
    const p = url.pathname;
    const ip = clientIp(req);

    if (p === '/healthz') return send(res, 200, { ok: true, uptime: Math.round(process.uptime()) });

    if (p.startsWith('/api/')) {
      if (p === '/api/stats' && req.method === 'GET') {
        if (!allow('read', ip)) return sendResult(res, { ok: false, error: 'RATE_LIMITED', message: MESSAGES.RATE_LIMITED });
        return send(res, 200, { ok: true, ...manager.stats() });
      }
      if (p === '/api/events' && req.method === 'GET') {
        if (!allow('read', ip)) return sendResult(res, { ok: false, error: 'RATE_LIMITED', message: MESSAGES.RATE_LIMITED });
        return handleEvents(req, res, url);
      }
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'BAD_REQUEST', message: MESSAGES.BAD_REQUEST }, { Allow: 'POST' });

      const kind = (p === '/api/rooms' || p === '/api/rooms/join') ? 'lobby' : 'action';
      if (!allow(kind, ip)) return sendResult(res, { ok: false, error: 'RATE_LIMITED', message: MESSAGES.RATE_LIMITED });
      let body;
      try { body = await readJson(req); } catch (err) {
        if (err && err.message === 'size') {
          res.on('finish', () => req.destroy()); // stop reading an oversized upload as soon as we have answered
          return send(res, 413, { ok: false, error: 'BAD_REQUEST', message: MESSAGES.BAD_REQUEST }, { Connection: 'close' });
        }
        return sendResult(res, { ok: false, error: 'BAD_REQUEST', message: MESSAGES.BAD_REQUEST });
      }
      if (p === '/api/rooms') return sendResult(res, manager.createRoom(body));
      if (p === '/api/rooms/join') return sendResult(res, manager.joinRoom(body));
      if (p === '/api/rooms/resume') return sendResult(res, manager.resume(body));
      if (p === '/api/action') {
        if (typeof body.type !== 'string') return sendResult(res, { ok: false, error: 'BAD_REQUEST', message: MESSAGES.BAD_REQUEST });
        return sendResult(res, manager.action(body));
      }
      return send(res, 404, { ok: false, error: 'BAD_REQUEST', message: MESSAGES.BAD_REQUEST });
    }

    return serveStatic(req, res, p);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[http] unhandled', err && err.stack || err);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'SERVER_ERROR', message: 'SOMETHING WENT WRONG.' });
      else res.destroy();
    });
  });
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;

  let ticker = null;
  let heartbeat = null;

  function start(port = Number(env.PORT) || 3000, host = env.HOST || '0.0.0.0') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        ticker = setInterval(() => manager.tick(), tickMs);
        heartbeat = setInterval(() => {
          for (const c of sseConns) { try { c.ping(); } catch (_) { /* ignore */ } }
        }, 15000);
        resolve(server.address());
      });
    });
  }

  function stop() {
    clearInterval(ticker);
    clearInterval(heartbeat);
    clearInterval(sweep);
    for (const c of sseConns) c.close();
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  return { server, manager, start, stop };
}

if (require.main === module) {
  const app = createServer();
  app.start().then((addr) => {
    console.log(`UNO ARENA is running on http://${addr.address === '0.0.0.0' ? 'localhost' : addr.address}:${addr.port}`);
  }).catch((err) => {
    console.error('Could not start server:', err.message);
    process.exit(1);
  });
  const shutdown = (sig) => {
    console.log(`\n${sig} received — shutting down…`);
    app.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createServer };
