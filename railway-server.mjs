/**
 * railway-server.mjs
 *
 * Self-contained production server for Railway.
 *  - Serves the compiled Vite `dist/` as a Single-Page App.
 *  - Proxies RSS feeds via GET /api/rss-proxy?url=<encoded-url>
 *    (implements the same domain allowlist as api/rss-proxy.js).
 *  - No extra npm packages needed — only Node.js built-ins + the native fetch
 *    that ships with Node 18+.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
    /^https:\/\/(.*\.)?worldmonitor\.app$/,
    /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/,
    /^https:\/\/worldmonitor-[a-z0-9-]+\.vercel\.app$/,
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

function corsHeaders(origin) {
    const allow = ALLOWED_ORIGINS.some(r => r.test(origin ?? ''))
        ? origin
        : 'https://worldmonitor.app';
    return {
        'Access-Control-Allow-Origin': allow ?? 'https://worldmonitor.app',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

// ── Allowed RSS domains (mirrors api/rss-proxy.js) ───────────────────────────
const ALLOWED_RSS_DOMAINS = new Set([
    'feeds.bbci.co.uk', 'www.theguardian.com', 'feeds.npr.org', 'news.google.com',
    'www.aljazeera.com', 'www.aljazeera.net', 'rss.cnn.com', 'hnrss.org',
    'feeds.arstechnica.com', 'www.theverge.com', 'www.cnbc.com', 'www.defenseone.com',
    'breakingdefense.com', 'techcrunch.com', 'www.technologyreview.com',
    'export.arxiv.org', 'rss.arxiv.org', 'www.federalreserve.gov', 'www.sec.gov',
    'www.whitehouse.gov', 'www.state.gov', 'www.defense.gov', 'home.treasury.gov',
    'www.justice.gov', 'tools.cdc.gov', 'www.fema.gov', 'www.dhs.gov',
    'finance.yahoo.com', 'thediplomat.com', 'venturebeat.com', 'foreignpolicy.com',
    'www.ft.com', 'feeds.reuters.com', 'www.france24.com', 'www.euronews.com',
    'de.euronews.com', 'es.euronews.com', 'fr.euronews.com', 'it.euronews.com',
    'pt.euronews.com', 'ru.euronews.com', 'www.lemonde.fr', 'rss.dw.com',
    'www.bild.de', 'www.spiegel.de', 'www.tagesschau.de', 'newsfeed.zeit.de',
    'feeds.elpais.com', 'e00-elmundo.uecdn.es', 'www.ansa.it', 'www.repubblica.it',
    'feeds.nos.nl', 'www.nrc.nl', 'www.svt.se', 'www.dn.se', 'www.svd.se',
    'www.hurriyet.com.tr', 'rss.dw.com', 'tvn24.pl', 'www.polsatnews.pl', 'www.rp.pl',
    'meduza.io', 'novayagazeta.eu', 'www.rt.com', 'feeds.bbci.co.uk',
    'www.africanews.com', 'fr.africanews.com', 'www.premiumtimesng.com',
    'www.vanguardngr.com', 'www.channelstv.com', 'dailytrust.com', 'www.thisdaylive.com',
    'www.naftemporiki.gr', 'www.in.gr', 'www.iefimerida.gr', 'www.lasillavacia.com',
    'www.channelnewsasia.com', 'japantoday.com', 'www.thehindu.com', 'indianexpress.com',
    'feeds.feedburner.com', 'api.axios.com', 'www.engadget.com', 'news.mit.edu',
    'www.ycombinator.com', 'stratechery.com', 'www.lennysnewsletter.com',
    'warontherocks.com', 'www.aei.org', 'responsiblestatecraft.org', 'www.fpri.org',
    'jamestown.org', 'www.atlanticcouncil.org', 'www.foreignaffairs.com',
    'www.crisisgroup.org', 'www.iaea.org', 'www.who.int', 'news.un.org', 'www.cisa.gov',
    'www.scmp.com', 'www.abc.net.au', 'islandtimes.org', 'vnexpress.net',
    'www.yonhapnewstv.co.kr', 'www.chosun.com', 'www.asahi.com',
    'www.clarin.com', 'feeds.folha.uol.com.br', 'www.eltiempo.com', 'insightcrime.org',
    'mexiconewsdaily.com', 'inc42.com', 'yourstory.com', 'techcabal.com',
    'news.crunchbase.com', 'www.saastr.com', 'www.cbinsights.com', 'sifted.eu',
    'tech.eu', 'www.goodnewsnetwork.org', 'www.positive.news', 'reasonstobecheerful.world',
    'www.optimistdaily.com', 'www.brasilparalelo.com.br', 'www.jeuneafrique.com',
    'feeds.news24.com', 'asharqbusiness.com', 'asharq.com', 'www.omanobserver.om',
    'www.naftemporiki.gr', 'moxie.foxnews.com', 'feeds.nbcnews.com', 'www.cbsnews.com',
    'www.ftcom.rss', 'www.abc.net.au', 'tuoitrenews.vn', 'www.bangkokpost.com',
    'www.thenationalnews.com', 'www.birmingham.ac.uk',
]);

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ── RSS Proxy handler ─────────────────────────────────────────────────────────
async function handleRssProxy(req, res) {
    const origin = req.headers['origin'] ?? '';
    const cors = corsHeaders(origin);

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
    }

    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    const feedUrl = reqUrl.searchParams.get('url');

    if (!feedUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'Missing url parameter' }));
        return;
    }

    let parsedFeed;
    try {
        parsedFeed = new URL(feedUrl);
    } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'Invalid url parameter' }));
        return;
    }

    const hostname = parsedFeed.hostname;
    const bare = hostname.replace(/^www\./, '');
    const withWww = hostname.startsWith('www.') ? hostname : `www.${hostname}`;

    if (!ALLOWED_RSS_DOMAINS.has(hostname) && !ALLOWED_RSS_DOMAINS.has(bare) && !ALLOWED_RSS_DOMAINS.has(withWww)) {
        res.writeHead(403, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'Domain not allowed' }));
        return;
    }

    const isGoogleNews = feedUrl.includes('news.google.com');
    const timeout = isGoogleNews ? 20000 : 12000;

    try {
        const upstream = await fetchWithTimeout(feedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
        }, timeout);

        const body = await upstream.text();
        const contentType = upstream.headers.get('content-type') || 'application/xml';
        const isOk = upstream.status >= 200 && upstream.status < 300;

        res.writeHead(upstream.status, {
            'Content-Type': contentType,
            'Cache-Control': isOk
                ? 'public, max-age=180, s-maxage=900, stale-while-revalidate=1800, stale-if-error=3600'
                : 'public, max-age=15, s-maxage=60',
            ...cors,
        });
        res.end(body);
    } catch (err) {
        const isTimeout = err.name === 'AbortError';
        console.error(`[rss-proxy] ${isTimeout ? 'Timeout' : 'Error'}: ${feedUrl} — ${err.message}`);
        res.writeHead(isTimeout ? 504 : 502, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({
            error: isTimeout ? 'Feed timeout' : 'Failed to fetch feed',
            details: err.message,
            url: feedUrl,
        }));
    }
}

// ── Static file server (SPA fallback) ────────────────────────────────────────
const MIME_TYPES = {
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

function serveStatic(urlPath, res) {
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    const candidates = [
        path.join(DIST, safePath),
        path.join(DIST, 'index.html'), // SPA fallback
    ];

    for (const fp of candidates) {
        try {
            const stat = fs.statSync(fp);
            if (stat.isFile()) {
                const ext = path.extname(fp).toLowerCase();
                const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
                const isAsset = urlPath.startsWith('/assets/');
                res.writeHead(200, {
                    'Content-Type': mime,
                    'Cache-Control': isAsset
                        ? 'public, max-age=31536000, immutable'
                        : fp.endsWith('index.html') && !urlPath.startsWith('/assets/')
                            ? 'no-cache, no-store, must-revalidate'
                            : 'public, max-age=86400',
                });
                fs.createReadStream(fp).pipe(res);
                return;
            }
        } catch {
            // try next candidate
        }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/api/rss-proxy') {
        handleRssProxy(req, res).catch(err => {
            console.error('[server] Unhandled error in rss-proxy:', err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            }
        });
        return;
    }

    // health check for Railway
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }

    serveStatic(url.pathname, res);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`INFO  Accepting connections at http://localhost:${PORT}`);
});
