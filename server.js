/**
 * ═══════════════════════════════════════════════════════════════
 *  DjiboIntel — Serveur Backend Node.js
 *  Version 1.0 — Avril 2026
 *  République de Djibouti — Document confidentiel
 * ═══════════════════════════════════════════════════════════════
 *
 *  Rôle : Proxy sécurisé entre le frontend DjiboIntel et les APIs externes.
 *  Résout le problème CORS, protège les clés API, et met en cache
 *  les réponses pour réduire les coûts et améliorer les performances.
 *
 *  APIs gérées :
 *    ▸ NewsAPI       → articles presse mondiale
 *    ▸ Alpha Vantage → cours pétrole Brent & WTI
 *    ▸ RSS Maritime  → Lloyd's List, Splash247 (gratuit)
 *    ▸ MarineTraffic → trafic AIS Bab-el-Mandeb (Phase 2)
 *
 *  Déploiement : Railway.app (gratuit jusqu'à 5 USD/mois)
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const NodeCache  = require('node-cache');
const Parser     = require('rss-parser');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
require('dotenv').config();

// ──────────────────────────────────────────────
//  CONFIGURATION
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

const KEYS = {
  newsapi:        process.env.NEWSAPI_KEY        || 'd3f6d030274d4d62b7c5245b8300a22c',
  alphaVantage:   process.env.ALPHAVANTAGE_KEY   || '1SS7FEV5HOLYE2OK',
  marineTraffic:  process.env.MARINETRAFFIC_KEY  || '',   // Phase 2 — payant
};

// Origines autorisées à appeler ce backend
// Remplacez par l'URL réelle de votre frontend Netlify
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

// Durées de cache en secondes
const CACHE_TTL = {
  news:         15 * 60,    // 15 minutes — articles presse
  brent:        10 * 60,    // 10 minutes — prix pétrole
  maritime_rss:  5 * 60,    //  5 minutes — flux RSS maritime
  marine_ais:    2 * 60,    //  2 minutes — trafic AIS (Phase 2)
  health:            30,    // 30 secondes — ping santé
};

// ──────────────────────────────────────────────
//  INITIALISATION
// ──────────────────────────────────────────────
const app   = express();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const rss   = new Parser({ timeout: 10000 });

// ──────────────────────────────────────────────
//  MIDDLEWARES DE SÉCURITÉ
// ──────────────────────────────────────────────

// Helmet : headers de sécurité HTTP
app.use(helmet({ contentSecurityPolicy: false }));

// CORS : autoriser uniquement le frontend DjiboIntel
app.use(cors({
  origin: (origin, callback) => {
    // Autoriser les requêtes sans origin (ex : Postman, Railway health check)
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS bloqué pour l'origine : ${origin}`));
    }
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-token'],
}));

// Protection brute-force : max 120 requêtes / minute par IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes. Réessayez dans une minute.' },
});
app.use(limiter);

// Auth optionnelle par token (pour restreindre l'accès en production)
app.use((req, res, next) => {
  const token = process.env.API_TOKEN;
  if (!token) return next(); // pas de token configuré → accès libre
  const provided = req.headers['x-api-token'] || req.query.token;
  if (provided !== token) {
    return res.status(401).json({ error: 'Token API manquant ou invalide.' });
  }
  next();
});

// Parse JSON
app.use(express.json());

// ──────────────────────────────────────────────
//  UTILITAIRES
// ──────────────────────────────────────────────

/** Répond depuis le cache si disponible, sinon appelle fn() et met en cache */
async function withCache(key, ttl, fn) {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return { data: cached, fromCache: true };
  }
  const data = await fn();
  cache.set(key, data, ttl);
  return { data, fromCache: false };
}

/** Formate une erreur axios en message lisible */
function fmtAxiosError(err) {
  if (err.response) {
    return `API ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}`;
  }
  if (err.request) return 'Pas de réponse reçue (timeout ou réseau)';
  return err.message;
}

/** Ajoute les headers de debug utiles */
function addDebugHeaders(res, meta = {}) {
  res.set('X-Cache',       meta.fromCache ? 'HIT' : 'MISS');
  res.set('X-DjiboIntel',  '1.0');
  res.set('X-Timestamp',   new Date().toISOString());
}

// ──────────────────────────────────────────────
//  ROUTE : SANTÉ DU SERVEUR
//  GET /health
// ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DjiboIntel Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    apis: {
      newsapi:       !!KEYS.newsapi       ? 'configuré' : 'manquant',
      alphaVantage:  !!KEYS.alphaVantage  ? 'configuré' : 'manquant',
      marineTraffic: !!KEYS.marineTraffic ? 'configuré' : 'phase 2',
    },
    cache: {
      keys: cache.keys().length,
      stats: cache.getStats(),
    },
  });
});

// ──────────────────────────────────────────────
//  ROUTE : ARTICLES PRESSE — NewsAPI
//  GET /api/news?q=djibouti&lang=fr&pageSize=20
// ──────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  const {
    q        = 'Djibouti',
    lang     = 'fr',
    pageSize = '20',
    from,          // date ISO ex: 2026-04-01
    sortBy   = 'publishedAt',
  } = req.query;

  const cacheKey = `news:${q}:${lang}:${pageSize}:${from || 'none'}:${sortBy}`;

  try {
    const result = await withCache(cacheKey, CACHE_TTL.news, async () => {
      const params = {
        q,
        language: lang,
        pageSize: Math.min(parseInt(pageSize, 10) || 20, 100),
        sortBy,
        apiKey: KEYS.newsapi,
      };
      if (from) params.from = from;

      const { data } = await axios.get('https://newsapi.org/v2/everything', {
        params,
        timeout: 8000,
      });

      return {
        totalResults: data.totalResults,
        articles: (data.articles || []).map(a => ({
          source:      a.source?.name || '—',
          title:       a.title,
          description: a.description,
          url:         a.url,
          image:       a.urlToImage,
          publishedAt: a.publishedAt,
        })),
      };
    });

    addDebugHeaders(res, result);
    res.json({ ok: true, ...result.data, fromCache: result.fromCache });

  } catch (err) {
    console.error('[/api/news]', fmtAxiosError(err));
    res.status(502).json({ ok: false, error: 'Erreur NewsAPI', detail: fmtAxiosError(err) });
  }
});

// ──────────────────────────────────────────────
//  ROUTE : VEILLE IDE — NewsAPI multi-requêtes
//  GET /api/ide?geo=dj
//  geo : dj | et | ke | so | gulf | all
// ──────────────────────────────────────────────
const IDE_QUERIES = {
  dj:   '"Djibouti" AND (investment OR infrastructure OR "free zone" OR DTFE OR port)',
  et:   '"Ethiopia" AND (investment OR infrastructure OR "Addis Abeba") AND logistics',
  ke:   '"Kenya" AND (investment OR infrastructure OR Mombasa) AND Africa',
  so:   '"Somaliland" OR ("Somalia" AND (port OR investment OR Berbera))',
  gulf: '("UAE" OR "Saudi Arabia" OR "Qatar") AND (Africa OR Djibouti) AND investment',
  all:  '(Djibouti OR Ethiopia OR Kenya OR Somaliland) AND (investment OR infrastructure OR "FDI")',
};

app.get('/api/ide', async (req, res) => {
  const geo = (req.query.geo || 'all').toLowerCase();
  const query = IDE_QUERIES[geo] || IDE_QUERIES.all;
  const cacheKey = `ide:${geo}`;

  try {
    const result = await withCache(cacheKey, CACHE_TTL.news, async () => {
      const { data } = await axios.get('https://newsapi.org/v2/everything', {
        params: { q: query, language: 'en', pageSize: 30, sortBy: 'publishedAt', apiKey: KEYS.newsapi },
        timeout: 8000,
      });

      const articles = (data.articles || []).map(a => {
        const text = `${a.title || ''} ${a.description || ''}`;
        return {
          source:      a.source?.name,
          title:       a.title,
          description: a.description,
          url:         a.url,
          publishedAt: a.publishedAt,
          amount:      extractAmount(text),
          score:       scoreIDE(text, geo),
          sector:      classifySector(text),
          priority:    classifyPriority(text),
        };
      }).sort((a, b) => b.score - a.score);

      return { geo, totalResults: articles.length, articles };
    });

    addDebugHeaders(res, result);
    res.json({ ok: true, ...result.data, fromCache: result.fromCache });

  } catch (err) {
    console.error('[/api/ide]', fmtAxiosError(err));
    res.status(502).json({ ok: false, error: 'Erreur NewsAPI IDE', detail: fmtAxiosError(err) });
  }
});

// ──────────────────────────────────────────────
//  ROUTE : PRIX PÉTROLE — Alpha Vantage
//  GET /api/brent          → Brent dernière valeur
//  GET /api/brent?history=1 → 30 jours
// ──────────────────────────────────────────────
app.get('/api/brent', async (req, res) => {
  const withHistory = req.query.history === '1';
  const cacheKey = `brent:${withHistory ? 'history' : 'latest'}`;

  try {
    const result = await withCache(cacheKey, CACHE_TTL.brent, async () => {
      const { data } = await axios.get('https://www.alphavantage.co/query', {
        params: {
          function: 'TIME_SERIES_DAILY',
          symbol:   'BZ=F',         // Brent Crude Futures
          apikey:   KEYS.alphaVantage,
          outputsize: withHistory ? 'compact' : 'compact',
        },
        timeout: 10000,
      });

      const series = data['Time Series (Daily)'];
      if (!series) {
        // Alpha Vantage renvoie parfois un message d'information si quota dépassé
        throw new Error(data['Information'] || data['Note'] || 'Données Brent indisponibles');
      }

      const dates  = Object.keys(series).sort().reverse();
      const latest = series[dates[0]];
      const prev   = series[dates[1]];

      const price   = parseFloat(latest['4. close']);
      const pricePrev = parseFloat(prev['4. close']);
      const change  = ((price - pricePrev) / pricePrev * 100).toFixed(2);

      const base = {
        symbol:    'BZ=F',
        name:      'Brent Crude Futures',
        price,
        change:    parseFloat(change),
        date:      dates[0],
        currency:  'USD',
      };

      if (!withHistory) return base;

      // 30 jours d'historique
      const history = dates.slice(0, 30).reverse().map(d => ({
        date:  d,
        close: parseFloat(series[d]['4. close']),
        high:  parseFloat(series[d]['2. high']),
        low:   parseFloat(series[d]['3. low']),
      }));

      return { ...base, history };
    });

    addDebugHeaders(res, result);
    res.json({ ok: true, ...result.data, fromCache: result.fromCache });

  } catch (err) {
    console.error('[/api/brent]', err.message);
    // Fallback : retourner une valeur statique si l'API est indisponible
    res.json({
      ok:       true,
      price:    84.7,
      change:   -1.3,
      date:     new Date().toISOString().split('T')[0],
      currency: 'USD',
      fallback: true,
      warning:  'Données en cache statique — API temporairement indisponible',
    });
  }
});

// ──────────────────────────────────────────────
//  ROUTE : WTI (pétrole américain)
//  GET /api/wti
// ──────────────────────────────────────────────
app.get('/api/wti', async (req, res) => {
  const cacheKey = 'wti:latest';
  try {
    const result = await withCache(cacheKey, CACHE_TTL.brent, async () => {
      const { data } = await axios.get('https://www.alphavantage.co/query', {
        params: { function: 'TIME_SERIES_DAILY', symbol: 'CL=F', apikey: KEYS.alphaVantage, outputsize: 'compact' },
        timeout: 10000,
      });
      const series = data['Time Series (Daily)'];
      if (!series) throw new Error('Données WTI indisponibles');
      const dates = Object.keys(series).sort().reverse();
      const price = parseFloat(series[dates[0]]['4. close']);
      const prev  = parseFloat(series[dates[1]]['4. close']);
      return { symbol: 'CL=F', name: 'WTI Crude', price, change: parseFloat(((price - prev) / prev * 100).toFixed(2)), date: dates[0], currency: 'USD' };
    });
    addDebugHeaders(res, result);
    res.json({ ok: true, ...result.data, fromCache: result.fromCache });
  } catch (err) {
    res.json({ ok: true, price: 81.2, change: -0.9, date: new Date().toISOString().split('T')[0], currency: 'USD', fallback: true });
  }
});

// ──────────────────────────────────────────────
//  ROUTE : FLUX RSS MARITIME
//  GET /api/maritime/rss
// ──────────────────────────────────────────────
const MARITIME_RSS_FEEDS = [
  { name: "Splash247",    url: "https://splash247.com/feed/" },
  { name: "Lloyd's List", url: "https://lloydslist.com/feed" },
  { name: "TradeWinds",   url: "https://www.tradewindsnews.com/rss" },
  { name: "The Loadstar", url: "https://theloadstar.com/feed/" },
];

app.get('/api/maritime/rss', async (req, res) => {
  const cacheKey = 'maritime:rss';
  try {
    const result = await withCache(cacheKey, CACHE_TTL.maritime_rss, async () => {
      const results = await Promise.allSettled(
        MARITIME_RSS_FEEDS.map(async feed => {
          try {
            const parsed = await rss.parseURL(feed.url);
            return (parsed.items || []).slice(0, 8).map(item => ({
              source:      feed.name,
              title:       item.title,
              summary:     item.contentSnippet?.slice(0, 200),
              url:         item.link,
              publishedAt: item.pubDate || item.isoDate,
              relevant:    isMaritimeRelevant(item.title + ' ' + (item.contentSnippet || '')),
            }));
          } catch {
            return [];
          }
        })
      );

      const articles = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value)
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

      return { count: articles.length, articles };
    });

    addDebugHeaders(res, result);
    res.json({ ok: true, ...result.data, fromCache: result.fromCache });

  } catch (err) {
    console.error('[/api/maritime/rss]', err.message);
    res.status(502).json({ ok: false, error: 'Erreur RSS maritime', detail: err.message });
  }
});

// ──────────────────────────────────────────────
//  ROUTE : TRAFIC MARITIME AIS — MarineTraffic (Phase 2)
//  GET /api/maritime/ais?zone=bab
// ──────────────────────────────────────────────
app.get('/api/maritime/ais', async (req, res) => {
  if (!KEYS.marineTraffic) {
    return res.status(402).json({
      ok: false,
      error: 'MarineTraffic API non configurée',
      message: 'Phase 2 — Abonnement requis sur marinetraffic.com',
      phase: 2,
    });
  }

  const zone = req.query.zone || 'bab'; // bab = Bab-el-Mandeb
  const cacheKey = `ais:${zone}`;

  try {
    const result = await withCache(cacheKey, CACHE_TTL.marine_ais, async () => {
      // Zone Bab-el-Mandeb : lat 11.6-13.0 / lon 42.5-43.5
      const { data } = await axios.get('https://services.marinetraffic.com/api/exportvessels/v:8', {
        params: {
          apikey:  KEYS.marineTraffic,
          minlat:  11.6, maxlat: 13.0,
          minlon:  42.5, maxlon: 43.5,
          protocol: 'jsono',
        },
        timeout: 10000,
      });

      const vessels = (data || []).map(v => ({
        mmsi:        v.MMSI,
        name:        v.SHIPNAME,
        type:        v.TYPE_NAME,
        flag:        v.FLAG,
        lat:         parseFloat(v.LAT),
        lon:         parseFloat(v.LON),
        speed:       parseFloat(v.SPEED),
        destination: v.DESTINATION,
        status:      v.STATUS,
        timestamp:   v.TIMESTAMP,
      }));

      return { zone: 'Bab-el-Mandeb', count: vessels.length, vessels };
    });

    addDebugHeaders(res, result);
    res.json({ ok: true, ...result.data, fromCache: result.fromCache });

  } catch (err) {
    console.error('[/api/maritime/ais]', fmtAxiosError(err));
    res.status(502).json({ ok: false, error: 'Erreur MarineTraffic AIS', detail: fmtAxiosError(err) });
  }
});

// ──────────────────────────────────────────────
//  ROUTE : TABLEAU DE BORD AGRÉGÉ
//  GET /api/dashboard
//  Retourne tout en une requête (KPIs + news + Brent)
// ──────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const [newsResult, brentResult] = await Promise.allSettled([
      axios.get(`http://localhost:${PORT}/api/news?q=Djibouti+port+stratégie&pageSize=5`),
      axios.get(`http://localhost:${PORT}/api/brent`),
    ]);

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      news:  newsResult.status  === 'fulfilled' ? newsResult.value.data  : null,
      brent: brentResult.status === 'fulfilled' ? brentResult.value.data : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ──────────────────────────────────────────────
//  ROUTE : STATUT DES APIS
//  GET /api/status
// ──────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const checks = await Promise.allSettled([
    axios.get('https://newsapi.org/v2/top-headlines?country=us&pageSize=1', {
      params: { apiKey: KEYS.newsapi }, timeout: 5000
    }),
    axios.get('https://www.alphavantage.co/query', {
      params: { function: 'GLOBAL_QUOTE', symbol: 'IBM', apikey: KEYS.alphaVantage }, timeout: 5000
    }),
  ]);

  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    services: {
      newsapi: {
        name:   'NewsAPI',
        status: checks[0].status === 'fulfilled' ? 'ok' : 'error',
        detail: checks[0].status === 'rejected'  ? fmtAxiosError(checks[0].reason) : 'Opérationnel',
      },
      alphaVantage: {
        name:   'Alpha Vantage',
        status: checks[1].status === 'fulfilled' ? 'ok' : 'error',
        detail: checks[1].status === 'rejected'  ? fmtAxiosError(checks[1].reason) : 'Opérationnel',
      },
      marineTraffic: {
        name:   'MarineTraffic AIS',
        status: KEYS.marineTraffic ? 'configured' : 'not_configured',
        detail: KEYS.marineTraffic ? 'Clé présente' : 'Phase 2 — clé manquante',
      },
    },
  });
});

// ──────────────────────────────────────────────
//  ROUTE : VIDER LE CACHE (admin)
//  DELETE /api/cache
// ──────────────────────────────────────────────
app.delete('/api/cache', (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && req.headers['x-admin-secret'] !== adminSecret) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }
  cache.flushAll();
  res.json({ ok: true, message: 'Cache vidé', timestamp: new Date().toISOString() });
});

// ──────────────────────────────────────────────
//  ROUTE : RACINE
// ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service:  'DjiboIntel Backend API',
    version:  '1.0.0',
    status:   'running',
    endpoints: [
      'GET  /health',
      'GET  /api/status',
      'GET  /api/news?q=djibouti&lang=fr&pageSize=20',
      'GET  /api/ide?geo=dj|et|ke|so|gulf|all',
      'GET  /api/brent',
      'GET  /api/brent?history=1',
      'GET  /api/wti',
      'GET  /api/maritime/rss',
      'GET  /api/maritime/ais?zone=bab  (Phase 2)',
      'GET  /api/dashboard',
      'DELETE /api/cache  (admin)',
    ],
  });
});

// ──────────────────────────────────────────────
//  GESTIONNAIRE D'ERREURS GLOBAL
// ──────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    ok:    false,
    error: err.message || 'Erreur interne du serveur',
  });
});

// Route 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route introuvable : ${req.method} ${req.path}` });
});

// ──────────────────────────────────────────────
//  IA DE CLASSIFICATION — Fonctions utilitaires
// ──────────────────────────────────────────────

/** Extrait le premier montant financier trouvé dans un texte */
function extractAmount(text) {
  const patterns = [
    /\$[\d,.]+\s*(?:billion|B)\b/i,
    /\$[\d,.]+\s*(?:million|M)\b/i,
    /USD\s*[\d,.]+\s*(?:billion|million|B|M)\b/i,
    /[\d,.]+\s*(?:billion|million)\s*(?:USD|dollars?)/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[0].trim();
  }
  return null;
}

/** Score de pertinence IDE : 0–15 */
function scoreIDE(text, geo) {
  const t = text.toLowerCase();
  let score = 0;

  // Pertinence géographique
  const geoTerms = { dj: ['djibouti','dtfe','doraleh','ambouli'], et: ['ethiopia','addis'], ke: ['kenya','nairobi','mombasa'], so: ['somaliland','berbera','somalia'], gulf: ['uae','saudi','qatar','emirates','abu dhabi','dubai'] };
  const terms = geoTerms[geo] || Object.values(geoTerms).flat();
  if (terms.some(t_ => t.includes(t_))) score += 4;

  // Termes IDE
  const ideKeywords = ['investment','infrastructure','billion','million','project','deal','fund','loan','agreement','mou','contract','port','terminal','corridor','fdi','financing'];
  ideKeywords.forEach(kw => { if (t.includes(kw)) score += 1; });

  // Secteurs stratégiques
  ['port','maritime','shipping','logistics','telecom','5g','energy','solar','rail','airport'].forEach(kw => { if (t.includes(kw)) score += 0.5; });

  return Math.min(Math.round(score), 15);
}

/** Classifie le secteur d'un article */
function classifySector(text) {
  const t = text.toLowerCase();
  if (/(port|ship|vessel|maritime|container|cargo|logistics)/i.test(t)) return 'Port';
  if (/(telecom|network|5g|fiber|mobile|internet|spectrum)/i.test(t)) return 'Télécom';
  if (/(energy|solar|wind|power|electricity|oil|gas|petroleum)/i.test(t)) return 'Énergie';
  if (/(security|military|attack|threat|conflict|piracy)/i.test(t)) return 'Sécurité';
  if (/(free zone|dtfe|zone franche|trade|export|import)/i.test(t)) return 'DTFE';
  return 'Économie';
}

/** Classifie la priorité d'un article */
function classifyPriority(text) {
  const t = text.toLowerCase();
  const highTerms = ['crisis','attack','explosion','blockade','alert','critical','urgent','breaking','immediate','emergency'];
  const midTerms  = ['concern','risk','warning','tension','dispute','challenge','problem'];
  if (highTerms.some(kw => t.includes(kw))) return 'Haute';
  if (midTerms.some(kw => t.includes(kw)))  return 'Moyen';
  return 'Faible';
}

/** Indique si un article maritime est pertinent pour Djibouti */
function isMaritimeRelevant(text) {
  const keywords = ['djibouti','bab-el-mandeb','red sea','horn of africa','indian ocean','gulf of aden','houthi','somalia','ethiopia','suez'];
  return keywords.some(kw => text.toLowerCase().includes(kw));
}

// ──────────────────────────────────────────────
//  DÉMARRAGE
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║     DjiboIntel Backend — v1.0.0            ║');
  console.log('║     République de Djibouti                 ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`  → Serveur : http://localhost:${PORT}`);
  console.log(`  → Santé   : http://localhost:${PORT}/health`);
  console.log(`  → NewsAPI : ${KEYS.newsapi ? '✓ configuré' : '✗ manquant'}`);
  console.log(`  → AlphaV. : ${KEYS.alphaVantage ? '✓ configuré' : '✗ manquant'}`);
  console.log(`  → MarineT. : ${KEYS.marineTraffic ? '✓ configuré' : '⏳ phase 2'}`);
  console.log('');
});

module.exports = app;
