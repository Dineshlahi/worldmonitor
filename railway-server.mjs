/**
 * railway-server.mjs
 *
 * Self-contained production server for Railway.
 *  - Serves the compiled Vite `dist/` as a Single-Page App.
 *  - Proxies RSS feeds via GET /api/rss-proxy?url=<encoded-url>
 *    (implements the same domain allowlist as api/rss-proxy.js).
 *  - Serves news digest via GET /api/news/v1/list-feed-digest
 *    (ports the TypeScript server logic: feed list, XML parser, classifier).
 *  - No extra npm packages needed — only Node.js built-ins + the native fetch
 *    that ships with Node 18+.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const PORT = parseInt(process.env.PORT ?? '8080', 10);

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

// ── News Digest ──────────────────────────────────────────────────────────────
// Ported from server/worldmonitor/news/v1/ TypeScript files.
// Keyword classifier
const CRITICAL_KW = { 'nuclear strike': 'military', 'nuclear attack': 'military', 'nuclear war': 'military', 'invasion': 'conflict', 'declaration of war': 'conflict', 'martial law': 'military', 'coup': 'military', 'genocide': 'conflict', 'ethnic cleansing': 'conflict', 'chemical attack': 'terrorism', 'biological attack': 'terrorism', 'dirty bomb': 'terrorism', 'mass casualty': 'conflict', 'pandemic declared': 'health', 'health emergency': 'health', 'nato article 5': 'military', 'evacuation order': 'disaster', 'meltdown': 'disaster', 'nuclear meltdown': 'disaster' };
const HIGH_KW = { 'war': 'conflict', 'armed conflict': 'conflict', 'airstrike': 'conflict', 'air strike': 'conflict', 'drone strike': 'conflict', 'missile': 'military', 'missile launch': 'military', 'troops deployed': 'military', 'military escalation': 'military', 'bombing': 'conflict', 'casualties': 'conflict', 'hostage': 'terrorism', 'terrorist': 'terrorism', 'terror attack': 'terrorism', 'assassination': 'crime', 'cyber attack': 'cyber', 'ransomware': 'cyber', 'data breach': 'cyber', 'sanctions': 'economic', 'embargo': 'economic', 'earthquake': 'disaster', 'tsunami': 'disaster', 'hurricane': 'disaster', 'typhoon': 'disaster' };
const MEDIUM_KW = { 'protest': 'protest', 'protests': 'protest', 'riot': 'protest', 'riots': 'protest', 'unrest': 'protest', 'demonstration': 'protest', 'strike action': 'protest', 'military exercise': 'military', 'naval exercise': 'military', 'arms deal': 'military', 'weapons sale': 'military', 'diplomatic crisis': 'diplomatic', 'ambassador recalled': 'diplomatic', 'expel diplomats': 'diplomatic', 'trade war': 'economic', 'tariff': 'economic', 'recession': 'economic', 'inflation': 'economic', 'market crash': 'economic', 'flood': 'disaster', 'flooding': 'disaster', 'wildfire': 'disaster', 'volcano': 'disaster', 'eruption': 'disaster', 'outbreak': 'health', 'epidemic': 'health', 'infection spread': 'health', 'oil spill': 'environmental', 'pipeline explosion': 'infrastructure', 'blackout': 'infrastructure', 'power outage': 'infrastructure', 'internet outage': 'infrastructure', 'derailment': 'infrastructure' };
const LOW_KW = { 'election': 'diplomatic', 'vote': 'diplomatic', 'referendum': 'diplomatic', 'summit': 'diplomatic', 'treaty': 'diplomatic', 'agreement': 'diplomatic', 'negotiation': 'diplomatic', 'talks': 'diplomatic', 'peacekeeping': 'diplomatic', 'humanitarian aid': 'diplomatic', 'ceasefire': 'diplomatic', 'peace treaty': 'diplomatic', 'climate change': 'environmental', 'emissions': 'environmental', 'pollution': 'environmental', 'deforestation': 'environmental', 'drought': 'environmental', 'vaccine': 'health', 'vaccination': 'health', 'disease': 'health', 'virus': 'health', 'public health': 'health', 'covid': 'health', 'interest rate': 'economic', 'gdp': 'economic', 'unemployment': 'economic', 'regulation': 'economic' };
const TECH_HIGH_KW = { 'major outage': 'infrastructure', 'service down': 'infrastructure', 'global outage': 'infrastructure', 'zero-day': 'cyber', 'critical vulnerability': 'cyber', 'supply chain attack': 'cyber', 'mass layoff': 'economic' };
const TECH_MEDIUM_KW = { 'outage': 'infrastructure', 'breach': 'cyber', 'hack': 'cyber', 'vulnerability': 'cyber', 'layoff': 'economic', 'layoffs': 'economic', 'antitrust': 'economic', 'monopoly': 'economic', 'ban': 'economic', 'shutdown': 'infrastructure' };
const TECH_LOW_KW = { 'ipo': 'economic', 'funding': 'economic', 'acquisition': 'economic', 'merger': 'economic', 'launch': 'tech', 'release': 'tech', 'update': 'tech', 'partnership': 'economic', 'startup': 'tech', 'ai model': 'tech', 'open source': 'tech' };
const EXCLUSIONS = ['protein', 'couples', 'relationship', 'dating', 'diet', 'fitness', 'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie', 'tv show', 'sports', 'game', 'concert', 'festival', 'wedding', 'vacation', 'travel tips', 'life hack', 'self-care', 'wellness'];
const SHORT_KW = new Set(['war', 'coup', 'ban', 'vote', 'riot', 'riots', 'hack', 'talks', 'ipo', 'gdp', 'virus', 'disease', 'flood']);
const kwReCache = new Map();
function getKwRe(kw) {
    let re = kwReCache.get(kw);
    if (!re) {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = SHORT_KW.has(kw) ? new RegExp(`\\b${escaped}\\b`) : new RegExp(escaped);
        kwReCache.set(kw, re);
    }
    return re;
}
function matchKwMap(lower, map) {
    for (const [kw, cat] of Object.entries(map)) {
        if (getKwRe(kw).test(lower)) return { cat, kw };
    }
    return null;
}
function classifyTitle(title, variant) {
    const lower = title.toLowerCase();
    if (EXCLUSIONS.some(ex => lower.includes(ex))) return { level: 'info', category: 'general', confidence: 0.3 };
    const isTech = variant === 'tech';
    let m;
    if ((m = matchKwMap(lower, CRITICAL_KW))) return { level: 'critical', category: m.cat, confidence: 0.9 };
    if ((m = matchKwMap(lower, HIGH_KW))) return { level: 'high', category: m.cat, confidence: 0.8 };
    if (isTech && (m = matchKwMap(lower, TECH_HIGH_KW))) return { level: 'high', category: m.cat, confidence: 0.75 };
    if ((m = matchKwMap(lower, MEDIUM_KW))) return { level: 'medium', category: m.cat, confidence: 0.7 };
    if (isTech && (m = matchKwMap(lower, TECH_MEDIUM_KW))) return { level: 'medium', category: m.cat, confidence: 0.65 };
    if ((m = matchKwMap(lower, LOW_KW))) return { level: 'low', category: m.cat, confidence: 0.6 };
    if (isTech && (m = matchKwMap(lower, TECH_LOW_KW))) return { level: 'low', category: m.cat, confidence: 0.55 };
    return { level: 'info', category: 'general', confidence: 0.3 };
}

// Feed lists (mirrors server/worldmonitor/news/v1/_feeds.ts)
const gn = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
const VARIANT_FEEDS = {
    full: {
        politics: [
            { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
            { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },
            { name: 'AP News', url: gn('site:apnews.com') },
            { name: 'Reuters World', url: gn('site:reuters.com world') },
        ],
        us: [
            { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
            { name: 'CBS News', url: 'https://www.cbsnews.com/latest/rss/main' },
            { name: 'NBC News', url: 'https://feeds.nbcnews.com/nbcnews/public/news' },
            { name: 'Axios', url: 'https://api.axios.com/feed/' },
        ],
        europe: [
            { name: 'France 24', url: 'https://www.france24.com/en/rss' },
            { name: 'EuroNews', url: 'https://www.euronews.com/rss?format=xml' },
            { name: 'DW News', url: 'https://rss.dw.com/xml/rss-en-all' },
        ],
        middleeast: [
            { name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
            { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
        ],
        tech: [
            { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
            { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
            { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
        ],
        ai: [
            { name: 'AI News', url: gn('(OpenAI OR Anthropic OR Google AI OR "large language model" OR ChatGPT) when:2d') },
            { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
        ],
        finance: [
            { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
            { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
        ],
        gov: [
            { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
            { name: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss' },
            { name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
            { name: 'CISA', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml' },
        ],
        africa: [
            { name: 'BBC Africa', url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml' },
        ],
        latam: [
            { name: 'BBC Latin America', url: 'https://feeds.bbci.co.uk/news/world/latin_america/rss.xml' },
        ],
        asia: [
            { name: 'BBC Asia', url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml' },
            { name: 'The Diplomat', url: 'https://thediplomat.com/feed/' },
            { name: 'CNA', url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml' },
        ],
        thinktanks: [
            { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
            { name: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml' },
        ],
        crisis: [
            { name: 'CrisisWatch', url: 'https://www.crisisgroup.org/rss' },
            { name: 'WHO', url: 'https://www.who.int/rss-feeds/news-english.xml' },
        ],
    },
    tech: {
        tech: [
            { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
            { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
            { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
            { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
        ],
        ai: [
            { name: 'AI News', url: gn('(OpenAI OR Anthropic OR Google AI OR "large language model" OR ChatGPT) when:2d') },
            { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
        ],
        security: [
            { name: 'Krebs Security', url: 'https://krebsonsecurity.com/feed/' },
            { name: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml' },
        ],
        startups: [
            { name: 'TechCrunch Startups', url: 'https://techcrunch.com/category/startups/feed/' },
            { name: 'Crunchbase News', url: 'https://news.crunchbase.com/feed/' },
        ],
        dev: [
            { name: 'Dev.to', url: 'https://dev.to/feed' },
            { name: 'Hacker News Show', url: 'https://hnrss.org/show' },
        ],
        finance: [
            { name: 'CNBC Tech', url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' },
        ],
    },
    finance: {
        markets: [
            { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
            { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/rss/topstories' },
        ],
        crypto: [
            { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
            { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
        ],
        centralbanks: [
            { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
        ],
    },
    happy: {
        positive: [
            { name: 'Good News Network', url: 'https://www.goodnewsnetwork.org/feed/' },
            { name: 'Positive.News', url: 'https://www.positive.news/feed/' },
            { name: 'Reasons to be Cheerful', url: 'https://reasonstobecheerful.world/feed/' },
            { name: 'Optimist Daily', url: 'https://www.optimistdaily.com/feed/' },
        ],
        science: [
            { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml' },
        ],
    },
};
const INTEL_FEEDS = [
    { name: 'Defense One', url: 'https://www.defenseone.com/rss/all/' },
    { name: 'Breaking Defense', url: 'https://breakingdefense.com/feed/' },
    { name: 'USNI News', url: 'https://news.usni.org/feed' },
    { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
    { name: 'Krebs Security', url: 'https://krebsonsecurity.com/feed/' },
    { name: 'FAO News', url: 'https://www.fao.org/feeds/fao-newsroom-rss' },
];

// Simple RSS/Atom parser (no dependencies)
function decodeXmlEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function extractTag(xml, tag) {
    const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
    const plainRe = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
    const cdm = xml.match(cdataRe);
    if (cdm) return cdm[1].trim();
    const m = xml.match(plainRe);
    return m ? decodeXmlEntities(m[1].trim()) : '';
}
function parseRssXml(xml, feed, variant) {
    const items = [];
    const ITEMS_PER_FEED = 5;
    const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
    const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    let matches = [...xml.matchAll(itemRe)];
    const isAtom = matches.length === 0;
    if (isAtom) matches = [...xml.matchAll(entryRe)];
    for (const match of matches.slice(0, ITEMS_PER_FEED)) {
        const block = match[1];
        const title = extractTag(block, 'title');
        if (!title) continue;
        let link;
        if (isAtom) {
            const hm = block.match(/<link[^>]+href=["']([^"']+)["']/);
            link = hm?.[1] ?? '';
        } else {
            link = extractTag(block, 'link');
        }
        const pubStr = isAtom ? (extractTag(block, 'published') || extractTag(block, 'updated')) : extractTag(block, 'pubDate');
        const parsed = pubStr ? new Date(pubStr) : new Date();
        const publishedAt = isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
        const threat = classifyTitle(title, variant);
        const isAlert = threat.level === 'critical' || threat.level === 'high';
        const levelMap = { critical: 'THREAT_LEVEL_CRITICAL', high: 'THREAT_LEVEL_HIGH', medium: 'THREAT_LEVEL_MEDIUM', low: 'THREAT_LEVEL_LOW', info: 'THREAT_LEVEL_UNSPECIFIED' };
        items.push({ source: feed.name, title, link, publishedAt, isAlert, threat: { level: levelMap[threat.level], category: threat.category, confidence: threat.confidence, source: 'keyword' }, locationName: '' });
    }
    return items;
}

// In-memory digest cache (15 min per variant+lang)
const DIGEST_CACHE = new Map();
const DIGEST_TTL_MS = 15 * 60 * 1000;
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FEED_TIMEOUT_MS = 8_000;
const OVERALL_DEADLINE_MS = 22_000;
const BATCH_CONCURRENCY = 15;
const MAX_ITEMS_PER_CATEGORY = 20;

async function fetchRssFeed(url, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*', 'Accept-Language': 'en-US,en;q=0.9' },
            signal: ctrl.signal,
        });
        if (!resp.ok) return null;
        return await resp.text();
    } catch { return null; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
}

async function buildNewsDigest(variant, _lang) {
    const feedsByCategory = VARIANT_FEEDS[variant] ?? VARIANT_FEEDS.full;
    const categories = {};
    const feedStatuses = {};
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), OVERALL_DEADLINE_MS);
    try {
        // Collect all (category, feed) pairs
        const allEntries = [];
        for (const [cat, feeds] of Object.entries(feedsByCategory)) {
            for (const feed of feeds) allEntries.push({ cat, feed });
        }
        if (variant === 'full') {
            for (const feed of INTEL_FEEDS) allEntries.push({ cat: 'intel', feed });
        }

        const results = new Map();
        for (let i = 0; i < allEntries.length; i += BATCH_CONCURRENCY) {
            if (deadline.signal.aborted) break;
            const batch = allEntries.slice(i, i + BATCH_CONCURRENCY);
            const settled = await Promise.allSettled(batch.map(async ({ cat, feed }) => {
                const text = await fetchRssFeed(feed.url, deadline.signal);
                const items = text ? parseRssXml(text, feed, variant) : [];
                feedStatuses[feed.name] = items.length > 0 ? 'ok' : 'empty';
                return { cat, items };
            }));
            for (const r of settled) {
                if (r.status === 'fulfilled') {
                    const { cat, items } = r.value;
                    const existing = results.get(cat) ?? [];
                    existing.push(...items);
                    results.set(cat, existing);
                }
            }
        }
        for (const { feed } of allEntries) {
            if (!(feed.name in feedStatuses)) feedStatuses[feed.name] = 'timeout';
        }
        for (const [cat, items] of results) {
            items.sort((a, b) => b.publishedAt - a.publishedAt);
            categories[cat] = { items: items.slice(0, MAX_ITEMS_PER_CATEGORY) };
        }
        return { categories, feedStatuses, generatedAt: new Date().toISOString() };
    } finally {
        clearTimeout(deadlineTimer);
    }
}

async function handleNewsDigest(req, res) {
    const origin = req.headers['origin'] ?? '';
    const cors = corsHeaders(origin);

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
    const variant = ['full', 'tech', 'finance', 'happy'].includes(reqUrl.searchParams.get('variant') ?? '') ? reqUrl.searchParams.get('variant') : 'full';
    const lang = reqUrl.searchParams.get('lang') || 'en';
    const cacheKey = `${variant}:${lang}`;

    const cached = DIGEST_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.ts < DIGEST_TTL_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900', ...cors });
        res.end(JSON.stringify(cached.data));
        return;
    }

    try {
        const data = await buildNewsDigest(variant, lang);
        DIGEST_CACHE.set(cacheKey, { data, ts: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900', ...cors });
        res.end(JSON.stringify(data));
    } catch (err) {
        console.error('[news-digest] Error:', err);
        // Return stale cache if available, otherwise error
        const stale = DIGEST_CACHE.get(cacheKey);
        if (stale) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...cors });
            res.end(JSON.stringify(stale.data));
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
            res.end(JSON.stringify({ error: 'Failed to build news digest', categories: {}, feedStatuses: {}, generatedAt: new Date().toISOString() }));
        }
    }
}

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

    // News digest API — primary news source for the frontend
    if (url.pathname === '/api/news/v1/list-feed-digest') {
        handleNewsDigest(req, res).catch(err => {
            console.error('[server] Unhandled error in news-digest:', err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error', categories: {}, feedStatuses: {}, generatedAt: new Date().toISOString() }));
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
