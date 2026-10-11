/**
 * demo/src/server.mjs — zero-dependency HTTP API + static frontend.
 *
 * Routes:
 *   GET  /api/health          → { ok: true }
 *   GET  /api/tasks           → [ { id, title, done, createdAt } ]
 *   POST /api/tasks           → { title } creates a task (201)
 *   POST /api/tasks/:id/done  → { done } toggles completion
 *   GET  /                    → the single-page frontend
 *
 * No framework, no build step for the server itself: `node src/server.mjs`.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll, createTask, setDone } from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PUBLIC = join(ROOT, 'public');

export function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function readBody(req, { limit = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp({ root = ROOT } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        json(res, 200, loadAll(root));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await readBody(req);
        try {
          const task = createTask(root, { title: body.title });
          json(res, 201, task);
        } catch (err) {
          json(res, 400, { error: err.message });
        }
        return;
      }
      const doneMatch = /^\/api\/tasks\/([^/]+)\/done$/.exec(url.pathname);
      if (req.method === 'POST' && doneMatch) {
        const body = await readBody(req);
        const task = setDone(root, decodeURIComponent(doneMatch[1]), body.done ?? true);
        if (!task) { json(res, 404, { error: 'no such task' }); return; }
        json(res, 200, task);
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/app.js') {
        const js = existsSync(join(PUBLIC, 'app.js')) ? readFileSync(join(PUBLIC, 'app.js'), 'utf8') : '';
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(js);
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err.message ?? 'internal error' });
    }
  });
}

export function startServer({ root = ROOT, port = 4100 } = {}) {
  const server = createApp({ root });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const RUN_DIRECTLY = process.argv[1] === fileURLToPath(import.meta.url);
if (RUN_DIRECTLY) {
  const port = Number(process.env.PORT ?? 4100);
  await startServer({ port });
  process.stdout.write(`demo API listening on http://127.0.0.1:${port}\n`);
}
