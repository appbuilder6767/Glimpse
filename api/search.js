'use strict';
/*
 * Glimpse search server (a Vercel Function, Node.js runtime, no packages needed).
 *
 * Your API keys live here on the server, read from Vercel environment variables.
 * They are never sent to the phone.
 *   PEXELS_API_KEY   optional  Pexels photos and videos
 *   PIXABAY_API_KEY  optional  Pixabay photos and videos (backup, safesearch=true)
 *   YOUTUBE_API_KEY  optional  YouTube Data API v3 (safeSearch=strict)
 *   APP_PASSCODE     optional  if set, the app asks for this once on each device
 *
 * Requests:
 *   GET /api/search?status=1                     which sources are set up
 *   GET /api/search?q=ocean&page=1&yt=first      one page of mixed results
 *       yt=first gets YouTube's first page; yt=<token> gets the next page;
 *       leave yt out to skip YouTube for that page (saves YouTube quota).
 *       short=0 allows YouTube videos longer than 4 minutes.
 *       vertical=1 asks YouTube for Shorts and keeps only tall videos.
 *   GET /api/search?refresh=pixabay-photo-123    fresh copy of a saved Pixabay photo
 *   GET /api/search?refresh=youtube-ID,youtube-ID  re-check saved YouTube videos (max 50)
 *   GET /api/search?asset=manifest | asset=icon  home-screen app manifest and icon
 */

const crypto = require('crypto');
const zlib = require('zlib');

const TIMEOUT_MS = 8000;
const MAX_QUERY = 100;
const YT_PER_PAGE = 12;

// Safe search: each source's own filter is always on (YouTube safeSearch=strict,
// Pixabay safesearch=true; Pexels has no switch but only hosts moderated content).
// This word list is an extra layer applied to every query and every result.
const BLOCKED_WORDS = [
  'porn', 'porno', 'pornhub', 'pornography', 'xxx', 'nsfw', 'nude', 'nudes', 'nudity',
  'naked', 'hentai', 'erotic', 'erotica', 'onlyfans', 'fetish', 'topless', 'striptease',
  'stripper', 'camgirl', 'sexting', 'sex', 'sexy', 'gore', 'gory',
];
const BLOCK_RE = new RegExp('\\b(' + BLOCKED_WORDS.join('|') + ')\\b', 'i');

function env(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  }
  return u.toString();
}

class SourceError extends Error {
  constructor(source, code, message) {
    super(message);
    this.source = source;
    this.code = code;
  }
}

async function getJSON(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { ok: r.ok, status: r.status, data, text };
  } catch (err) {
    return { ok: false, status: 0, data: null, text: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

function httpsUrl(u) {
  return typeof u === 'string' && /^https:\/\//i.test(u) ? u : '';
}

function slugTitle(url) {
  // https://www.pexels.com/photo/brown-rocks-at-sunset-2014422/ -> "Brown rocks at sunset"
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const words = (parts[parts.length - 1] || '').split('-').filter((w) => w && !/^\d+$/.test(w));
    if (!words.length) return '';
    const s = words.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch (_) {
    return '';
  }
}

function blocked(text) {
  return BLOCK_RE.test(String(text || ''));
}

/* ----------------------------- Pexels ----------------------------- */

function pexelsError(r, what) {
  if (r.status === 401 || r.status === 403) return new SourceError('pexels', 'key', 'Pexels rejected the API key. Check PEXELS_API_KEY in Vercel.');
  if (r.status === 429) return new SourceError('pexels', 'rate', 'Pexels hourly limit reached. It resets within the hour.');
  return new SourceError('pexels', 'upstream', `Pexels ${what} search failed (${r.status || 'network'}).`);
}

function pickPexelsFile(files) {
  const mp4 = (files || []).filter((f) => f && httpsUrl(f.link) && f.width && f.height &&
    f.quality !== 'hls' && (!f.file_type || f.file_type === 'video/mp4'));
  let best = null;
  let bestScore = Infinity;
  for (const f of mp4) {
    const short = Math.min(f.width, f.height);
    const score = short >= 540 ? Math.abs(short - 720) : 1000 + (540 - short);
    if (score < bestScore) { best = f; bestScore = score; }
  }
  return best;
}

function normPexelsPhoto(p, i) {
  if (!p || !p.src) return null;
  const slug = slugTitle(p.url);
  const image = httpsUrl(p.src.large2x) || httpsUrl(p.src.large) || httpsUrl(p.src.original);
  if (!image) return null;
  return {
    id: 'pexels-photo-' + p.id,
    source: 'pexels',
    kind: 'photo',
    title: (p.alt || slug || 'Photo').slice(0, 200),
    tags: slug && slug !== p.alt ? [slug] : [],
    creator: { id: 'pexels:' + (p.photographer_id || p.photographer), name: p.photographer || 'Pexels photographer', url: httpsUrl(p.photographer_url) || httpsUrl(p.url) },
    pageUrl: httpsUrl(p.url),
    width: p.width,
    height: p.height,
    color: /^#[0-9a-f]{6}$/i.test(p.avg_color || '') ? p.avg_color : null,
    image,
    thumb: httpsUrl(p.src.medium) || image,
    rank: i,
  };
}

function normPexelsVideo(v, i) {
  if (!v) return null;
  const file = pickPexelsFile(v.video_files);
  if (!file) return null;
  const user = v.user || {};
  return {
    id: 'pexels-video-' + v.id,
    source: 'pexels',
    kind: 'video',
    title: slugTitle(v.url) || 'Video',
    tags: Array.isArray(v.tags) ? v.tags.slice(0, 10).map(String) : [],
    creator: { id: 'pexels:' + (user.id || user.name), name: user.name || 'Pexels videographer', url: httpsUrl(user.url) || httpsUrl(v.url) },
    pageUrl: httpsUrl(v.url),
    width: file.width,
    height: file.height,
    video: file.link,
    poster: httpsUrl(v.image),
    thumb: httpsUrl(v.image),
    duration: v.duration || 0,
    rank: i,
  };
}

async function pexelsSearch(q, page, counts) {
  const h = { Authorization: env('PEXELS_API_KEY') };
  const base = 'https://api.pexels.com';
  const photoQs = qs({ query: q, page, per_page: counts.photos, orientation: 'portrait' });
  const videoQs = qs({ query: q, page, per_page: counts.videos, orientation: 'portrait' });
  const [p, v] = await Promise.all([
    counts.photos ? getJSON(`${base}/v1/search?${photoQs}`, h) : null,
    counts.videos
      ? getJSON(`${base}/v1/videos/search?${videoQs}`, h)
        // Older keys/paths: fall back to the legacy video path if the new one 404s.
        .then((r) => (r.status === 404 ? getJSON(`${base}/videos/search?${videoQs}`, h) : r))
      : null,
  ]);
  const items = [];
  const errors = [];
  let more = false;
  if (p) {
    if (p.ok && p.data) {
      (p.data.photos || []).forEach((x, i) => { const n = normPexelsPhoto(x, i); if (n) items.push(n); });
      if (p.data.next_page) more = true;
    } else errors.push(pexelsError(p, 'photo'));
  }
  if (v) {
    if (v.ok && v.data) {
      (v.data.videos || []).forEach((x, i) => { const n = normPexelsVideo(x, i); if (n) items.push(n); });
      if (v.data.next_page) more = true;
    } else errors.push(pexelsError(v, 'video'));
  }
  if (!items.length && errors.length) throw errors[0];
  return { items, more, errors };
}

/* ----------------------------- Pixabay ---------------------------- */

function pixabayError(r) {
  if (r.status === 400 && /invalid api key/i.test(r.text)) return new SourceError('pixabay', 'key', 'Pixabay rejected the API key. Check PIXABAY_API_KEY in Vercel.');
  if (r.status === 429) return new SourceError('pixabay', 'rate', 'Pixabay rate limit reached. Try again in a minute.');
  return new SourceError('pixabay', 'upstream', `Pixabay search failed (${r.status || 'network'}).`);
}

function pixabayTags(tags) {
  return String(tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10);
}

function pixabayTitle(tags) {
  const t = pixabayTags(tags).slice(0, 4).join(', ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Pixabay';
}

function pixabayUserUrl(h) {
  return h.user && h.user_id ? `https://pixabay.com/users/${encodeURIComponent(h.user)}-${h.user_id}/` : 'https://pixabay.com/';
}

function normPixabayPhoto(h, i) {
  const image = httpsUrl(h.largeImageURL) || httpsUrl(h.webformatURL);
  if (!image) return null;
  return {
    id: 'pixabay-photo-' + h.id,
    source: 'pixabay',
    kind: 'photo',
    title: pixabayTitle(h.tags),
    tags: pixabayTags(h.tags),
    creator: { id: 'pixabay:' + h.user_id, name: h.user || 'Pixabay contributor', url: pixabayUserUrl(h) },
    pageUrl: httpsUrl(h.pageURL),
    width: h.imageWidth,
    height: h.imageHeight,
    image,
    thumb: httpsUrl(h.webformatURL) || image,
    refreshable: true, // Pixabay image links expire after ~24h; saved ones get refreshed.
    rank: i,
  };
}

function normPixabayVideo(h, i) {
  const v = h.videos || {};
  const r = [v.small, v.tiny, v.medium].find((x) => x && httpsUrl(x.url));
  if (!r) return null;
  const poster = httpsUrl(r.thumbnail) || httpsUrl((v.medium || {}).thumbnail) || '';
  return {
    id: 'pixabay-video-' + h.id,
    source: 'pixabay',
    kind: 'video',
    title: pixabayTitle(h.tags),
    tags: pixabayTags(h.tags),
    creator: { id: 'pixabay:' + h.user_id, name: h.user || 'Pixabay contributor', url: pixabayUserUrl(h) },
    pageUrl: httpsUrl(h.pageURL),
    width: r.width,
    height: r.height,
    video: r.url,
    poster,
    thumb: poster,
    duration: h.duration || 0,
    rank: i,
  };
}

async function pixabaySearch(q, page, counts) {
  const common = { key: env('PIXABAY_API_KEY'), q: q.slice(0, 100), safesearch: 'true', page };
  const [p, v] = await Promise.all([
    counts.photos ? getJSON('https://pixabay.com/api/?' + qs({ ...common, image_type: 'photo', orientation: 'vertical', per_page: Math.max(3, counts.photos) })) : null,
    counts.videos ? getJSON('https://pixabay.com/api/videos/?' + qs({ ...common, per_page: Math.max(3, counts.videos) })) : null,
  ]);
  const items = [];
  const errors = [];
  let more = false;
  const outOfRange = (r) => r.status === 400 && /out of valid range/i.test(r.text);
  if (p) {
    if (p.ok && p.data) {
      (p.data.hits || []).slice(0, counts.photos).forEach((x, i) => { const n = normPixabayPhoto(x, i); if (n) items.push(n); });
      if ((p.data.totalHits || 0) > page * Math.max(3, counts.photos)) more = true;
    } else if (!outOfRange(p)) errors.push(pixabayError(p));
  }
  if (v) {
    if (v.ok && v.data) {
      (v.data.hits || []).slice(0, counts.videos).forEach((x, i) => { const n = normPixabayVideo(x, i); if (n) items.push(n); });
      if ((v.data.totalHits || 0) > page * Math.max(3, counts.videos)) more = true;
    } else if (!outOfRange(v)) errors.push(pixabayError(v));
  }
  if (!items.length && errors.length) throw errors[0];
  return { items, more, errors };
}

async function pixabayById(kind, id) {
  const url = (kind === 'video' ? 'https://pixabay.com/api/videos/?' : 'https://pixabay.com/api/?') +
    qs({ key: env('PIXABAY_API_KEY'), id, safesearch: 'true' });
  const r = await getJSON(url);
  if (!r.ok || !r.data) throw pixabayError(r);
  const h = (r.data.hits || [])[0];
  if (!h) return null;
  return kind === 'video' ? normPixabayVideo(h, 0) : normPixabayPhoto(h, 0);
}

/* ----------------------------- YouTube ---------------------------- */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function isoSeconds(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
}

function ytError(r) {
  const e = (r.data && r.data.error) || {};
  const reason = ((e.errors && e.errors[0] && e.errors[0].reason) || '') + ' ' + (e.status || '') + ' ' + (e.message || '');
  if (/quota|dailyLimit|rateLimit/i.test(reason)) return new SourceError('youtube', 'quota', "YouTube's daily search limit is used up. It resets at midnight Pacific time.");
  if (/keyInvalid|API key not valid|API_KEY_INVALID/i.test(reason)) return new SourceError('youtube', 'key', 'YouTube rejected the API key. Check YOUTUBE_API_KEY in Vercel.');
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(reason)) return new SourceError('youtube', 'disabled', 'YouTube Data API v3 is not turned on for this key’s Google Cloud project.');
  if (/API_KEY_SERVICE_BLOCKED|referer|ip address|forbidden/i.test(reason)) return new SourceError('youtube', 'restricted', 'The YouTube key is restricted in a way that blocks this server. Use "API restrictions" only, not website or IP restrictions.');
  return new SourceError('youtube', 'upstream', `YouTube search failed (${r.status || 'network'}).`);
}

function bestThumb(t) {
  t = t || {};
  const x = t.maxres || t.standard || t.high || t.medium || t.default || {};
  return httpsUrl(x.url);
}

async function youtubeSearch(q, token, short, vertical) {
  const key = env('YOUTUBE_API_KEY');
  const params = {
    part: 'snippet', type: 'video', q: vertical ? `${q} #shorts` : q, maxResults: YT_PER_PAGE,
    safeSearch: 'strict', videoEmbeddable: 'true', videoSyndicated: 'true', key,
  };
  if (short) params.videoDuration = 'short';
  if (token && token !== 'first') params.pageToken = token;
  const s = await getJSON('https://www.googleapis.com/youtube/v3/search?' + qs(params));
  if (!s.ok || !s.data) throw ytError(s);
  const hits = (s.data.items || []).filter((it) => it.id && it.id.videoId &&
    (!it.snippet || !it.snippet.liveBroadcastContent || it.snippet.liveBroadcastContent === 'none'));
  const ids = hits.map((it) => it.id.videoId);
  const details = {};
  if (ids.length) {
    const v = await getJSON('https://www.googleapis.com/youtube/v3/videos?' + qs({
      part: 'snippet,contentDetails,status,player', id: ids.join(','), maxHeight: 1280, key,
    }));
    if (v.ok && v.data) for (const it of v.data.items || []) details[it.id] = it;
  }
  let items = [];
  hits.forEach((hit, i) => {
    const n = normYouTube(hit.id.videoId, i, details[hit.id.videoId], hit.snippet);
    if (n) items.push(n);
  });
  // Vertical mode keeps only tall videos (Shorts), unless that would leave nothing.
  if (vertical) {
    const tall = items.filter((it) => it.height > it.width);
    if (tall.length) items = tall.map((it, i) => Object.assign(it, { rank: i }));
  }
  return { items, nextToken: s.data.nextPageToken || null };
}

function normYouTube(id, i, d, fallbackSnippet) {
  const sn = (d && d.snippet) || fallbackSnippet || {};
  if (d) {
    const st = d.status || {};
    const cd = d.contentDetails || {};
    if (st.embeddable === false || (st.privacyStatus && st.privacyStatus !== 'public')) return null;
    if (cd.contentRating && cd.contentRating.ytRating === 'ytAgeRestricted') return null;
  }
  const pl = (d && d.player) || {};
  return {
    id: 'youtube-' + id,
    source: 'youtube',
    kind: 'youtube',
    ytId: id,
    title: decodeEntities(sn.title || 'YouTube video').slice(0, 200),
    tags: Array.isArray(sn.tags) ? sn.tags.slice(0, 12).map(String) : [],
    creator: { id: 'youtube:' + (sn.channelId || sn.channelTitle), name: decodeEntities(sn.channelTitle || 'YouTube channel'), url: sn.channelId ? `https://www.youtube.com/channel/${sn.channelId}` : 'https://www.youtube.com/' },
    pageUrl: `https://www.youtube.com/watch?v=${id}`,
    width: Number(pl.embedWidth) || 16,
    height: Number(pl.embedHeight) || 9,
    thumb: bestThumb(sn.thumbnails),
    duration: d ? isoSeconds(d.contentDetails && d.contentDetails.duration) : 0,
    rank: i,
  };
}

// Re-check saved YouTube videos (YouTube's policies ask apps to refresh stored data
// within 30 days). One call covers up to 50 videos and costs 1 quota unit.
async function youtubeByIds(ids) {
  const r = await getJSON('https://www.googleapis.com/youtube/v3/videos?' + qs({
    part: 'snippet,contentDetails,status,player', id: ids.join(','), maxHeight: 1280, key: env('YOUTUBE_API_KEY'),
  }));
  if (!r.ok || !r.data) throw ytError(r);
  return (r.data.items || []).map((d, i) => normYouTube(d.id, i, d)).filter(Boolean);
}

/* ------------------ home-screen icon + manifest ------------------- */
// Drawn in code so the project needs no image files.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function iconPixel(x, y) {
  // Background: diagonal coral -> violet gradient. Foreground: white ring with a play triangle.
  const t = Math.min(1, Math.max(0, (x + y) / 2));
  let r = 255 + (106 - 255) * t, g = 77 + (61 - 77) * t, b = 109 + (240 - 109) * t;
  const dx = x - 0.5, dy = y - 0.5, d = Math.sqrt(dx * dx + dy * dy);
  const ring = Math.abs(d - 0.3) < 0.035;
  // Play triangle with vertices (0.42,0.36) (0.42,0.64) (0.66,0.5)
  const inTri = x >= 0.42 && x <= 0.66 && Math.abs(y - 0.5) <= (0.66 - x) * (0.14 / 0.24);
  if (ring || inTri) { r = 255; g = 255; b = 255; }
  return [r, g, b];
}

function iconPng(size) {
  const ss = 3; // 3x3 supersampling for smooth edges
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let o = 0;
  for (let py = 0; py < size; py++) {
    raw[o++] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = iconPixel((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = ss * ss;
      raw[o++] = Math.round(r / n); raw[o++] = Math.round(g / n); raw[o++] = Math.round(b / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sendAsset(res, kind, size) {
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (kind === 'manifest') {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    return res.end(JSON.stringify({
      name: 'Glimpse', short_name: 'Glimpse', start_url: '/', scope: '/', display: 'standalone',
      background_color: '#000000', theme_color: '#000000', orientation: 'portrait',
      icons: [
        { src: '/api/search?asset=icon&size=192', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/api/search?asset=icon&size=512', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/api/search?asset=icon&size=512', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  }
  const s = [180, 192, 512].includes(size) ? size : 192;
  res.setHeader('Content-Type', 'image/png');
  return res.end(iconPng(s));
}

/* ----------------------------- handler ---------------------------- */

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function passOk(k, passcode) {
  if (typeof k !== 'string' || !/^[0-9a-f]{64}$/.test(k)) return false;
  const a = Buffer.from(k, 'hex');
  const b = Buffer.from(sha256hex(passcode), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(body));
}

function cleanQuery(q) {
  return String(q || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
}

function intParam(v, def, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

const LONG_CACHE = 'public, max-age=0, s-maxage=43200, stale-while-revalidate=3600';
const SHORT_CACHE = 'public, max-age=0, s-maxage=300';

module.exports = async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.searchParams;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return send(res, 405, { error: 'method', message: 'Only GET is supported.' });
  }

  const asset = p.get('asset');
  if (asset === 'manifest' || asset === 'icon') {
    res.statusCode = 200;
    return sendAsset(res, asset, intParam(p.get('size'), 192, 16, 1024));
  }

  const have = {
    pexels: !!env('PEXELS_API_KEY'),
    pixabay: !!env('PIXABAY_API_KEY'),
    youtube: !!env('YOUTUBE_API_KEY'),
  };
  const passcode = env('APP_PASSCODE');

  if (p.has('status')) {
    return send(res, 200, { ok: true, sources: have, passcode: !!passcode, safeSearch: 'strict' });
  }

  // With a passcode the app sends k = sha256(passcode). Because k is part of the URL,
  // Vercel's cache never hands a cached answer to someone without the passcode.
  if (passcode && !passOk(p.get('k'), passcode)) {
    return send(res, 401, { error: 'passcode', message: 'This app needs its passcode.' });
  }

  const refresh = p.get('refresh');
  if (refresh && refresh.startsWith('youtube-')) {
    const ids = refresh.split(',').map((x) => x.replace(/^youtube-/, '')).filter((x) => /^[A-Za-z0-9_-]{6,20}$/.test(x)).slice(0, 50);
    if (!ids.length || !have.youtube) return send(res, 400, { error: 'refresh', message: 'Nothing to refresh.' });
    try {
      const items = (await youtubeByIds(ids)).filter((it) => !blocked(it.title + ' ' + it.tags.join(' ')));
      return send(res, 200, { items }, SHORT_CACHE);
    } catch (e) {
      return send(res, 502, { error: e.code || 'upstream', message: e.message });
    }
  }
  if (refresh) {
    const m = /^pixabay-(photo|video)-(\d{1,12})$/.exec(refresh);
    if (!m || !have.pixabay) return send(res, 400, { error: 'refresh', message: 'Nothing to refresh.' });
    try {
      const item = await pixabayById(m[1], m[2]);
      return send(res, item ? 200 : 404, { item }, item ? SHORT_CACHE : 'no-store');
    } catch (e) {
      return send(res, 502, { error: e.code || 'upstream', message: e.message });
    }
  }

  const q = cleanQuery(p.get('q'));
  if (!q) return send(res, 400, { error: 'query', message: 'Type something to search for.' });

  if (blocked(q)) {
    return send(res, 200, { query: q, items: [], blocked: true, next: { page: null, yt: null }, errors: [] }, LONG_CACHE);
  }

  const page = intParam(p.get('page'), 1, 1, 40);
  const ytParam = p.get('yt') || '';
  const ytToken = ytParam === 'first' || /^[A-Za-z0-9_-]{1,120}$/.test(ytParam) ? ytParam : '';
  const short = p.get('short') !== '0';
  const media = p.get('media') !== '0';
  const vertical = p.get('vertical') === '1';

  const errors = [];
  if (!have.pexels && !have.pixabay && !have.youtube) {
    errors.push({ source: 'setup', code: 'no-keys', message: 'No API keys are set up yet. Add them in Vercel → Settings → Environment Variables, then redeploy.' });
    return send(res, 200, { query: q, page, items: [], next: { page: null, yt: null }, errors }, 'no-store');
  }

  const both = have.pexels && have.pixabay;
  const jobs = [];
  if (media && have.pexels) jobs.push(['pexels', pexelsSearch(q, page, both ? { photos: 8, videos: 5 } : { photos: 12, videos: 8 })]);
  if (media && have.pixabay) jobs.push(['pixabay', pixabaySearch(q, page, both ? { photos: 6, videos: 4 } : { photos: 12, videos: 8 })]);
  if (have.youtube && ytToken) jobs.push(['youtube', youtubeSearch(q, ytToken, short, vertical)]);

  const settled = await Promise.allSettled(jobs.map((j) => j[1]));
  let items = [];
  const next = { page: null, yt: null };
  settled.forEach((r, i) => {
    const name = jobs[i][0];
    if (r.status === 'fulfilled') {
      items = items.concat(r.value.items);
      if (name === 'youtube') next.yt = r.value.nextToken;
      else if (r.value.more) next.page = page + 1;
      for (const e of r.value.errors || []) errors.push({ source: e.source, code: e.code, message: e.message });
    } else {
      const e = r.reason || {};
      errors.push({ source: e.source || name, code: e.code || 'upstream', message: e.message || `${name} failed.` });
    }
  });

  items = items.filter((it) => !blocked(it.title + ' ' + (it.tags || []).join(' ')));

  return send(res, 200, { query: q, page, items, next, errors }, errors.length ? SHORT_CACHE : LONG_CACHE);
};

// Exposed for tests only.
module.exports._internals = { pickPexelsFile, slugTitle, isoSeconds, decodeEntities, blocked, passOk, sha256hex, cleanQuery };
