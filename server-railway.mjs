/**
 * Railway production server
 *
 * Wraps the Vercel edge-style API handlers (they speak the Web Fetch API) and
 * serves the compiled Vite `dist/` for every other route.
 *
 * Run with:  node server-railway.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, 'dist');
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── Lazy-load API route handlers ──────────────────────────────────────────────
// We import them dynamically so startup failures in one handler don't crash the
// whole server.

async function loadHandler(relPath) {
    try {
        const mod = await import(relPath);
        return mod.default ?? mod.handler ?? null;
    } catch (err) {
        console.error(`[server] Failed to load handler ${relPath}:`, err.message);
        return null;
    }
}

// Route table: URL pathname prefix → handler module path
const API_ROUTES = [
    ['/api/rss-proxy', './api/rss-proxy.js'],
    ['/api/bootstrap', './api/bootstrap.js'],
    ['/api/version', './api/version.js'],
    ['/api/story', './api/story.js'],
    ['/api/fwdstart', './api/fwdstart.js'],
    ['/api/geo', './api/geo.js'],
    ['/api/gpsjam', './api/gpsjam.js'],
    ['/api/opensky', './api/opensky.js'],
    ['/api/oref-alerts', './api/oref-alerts.js'],
    ['/api/polymarket', './api/polymarket.js'],
    ['/api/download', './api/download.js'],
    ['/api/og-story', './api/og-story.js'],
];

// Pre-load all handlers once at startup
const handlers = new Map();
await Promise.all(
    API_ROUTES.map(async ([route, modPath]) => {
        const fn = await loadHandler(modPath);
        if (fn) handlers.set(route, fn);
    }),
);

console.log(`[server] Loaded ${handlers.size}/${API_ROUTES.length} API handlers`);

// ── MIME types for static file serving ───────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.webp': 'image/webp',
    '.webmanifest': 'application/manifest+json',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
};

// ── Node IncomingMessage → Web Request adapter ────────────────────────────────
function nodeToWebRequest(req, bodyBuf) {
    const proto = req.headers['x-forwarded-proto'] ?? 'https';
    const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
    const url = new URL(req.url, `${proto}://${host}`);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach(vi => headers.append(k, vi));
        else if (v != null) headers.set(k, v);
    }

    const init = { method: req.method, headers };
    if (bodyBuf?.length && !['GET', 'HEAD'].includes(req.method)) {
        init.body = bodyBuf;
    }
    return new Request(url.toString(), init);
}

// ── Web Response → Node ServerResponse adapter ────────────────────────────────
async function webToNodeResponse(webRes, res) {
    res.statusCode = webRes.status;
    webRes.headers.forEach((value, key) => res.setHeader(key, value));
    const buf = await webRes.arrayBuffer();
    res.end(Buffer.from(buf));
}

// ── Static file server ────────────────────────────────────────────────────────
function serveStatic(urlPath, res) {
    // Normalise path and prevent directory traversal
    const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(DIST_DIR, safe);

    // Try exact file first, then index.html for SPA fallback
    const tryPaths = [filePath, path.join(DIST_DIR, 'index.html')];

    for (const fp of tryPaths) {
        if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
            const ext = path.extname(fp).toLowerCase();
            const mime = MIME[ext] ?? 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            fs.createReadStream(fp).pipe(res);
            return;
        }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
}

// ── Main HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // Match API route (exact or prefix)
    let handler = null;
    for (const [route, fn] of handlers) {
        if (pathname === route || pathname.startsWith(route + '/') || pathname.startsWith(route + '?')) {
            handler = fn;
            break;
        }
    }

    if (handler) {
        // Collect body
        const chunks = [];
        req.on('data', c => chunks.push(c));
        await new Promise(resolve => req.on('end', resolve));
        const bodyBuf = chunks.length ? Buffer.concat(chunks) : null;

        try {
            const webReq = nodeToWebRequest(req, bodyBuf);
            const webRes = await handler(webReq);
            await webToNodeResponse(webRes, res);
        } catch (err) {
            console.error(`[server] Handler error for ${pathname}:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // Static file / SPA fallback
    serveStatic(pathname, res);
});

server.listen(PORT, () => {
    console.log(`INFO  Accepting connections at http://localhost:${PORT}`);
});
