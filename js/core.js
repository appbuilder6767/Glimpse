/* Glimpse - core.js: Constants, helpers, memory on this device, learning, ranking, state, server calls, toasts.
   Loaded in order by index.html: core.js, slides.js, feed.js, ui.js (they share top-level names). */
'use strict';

/* ======================= constants ======================= */
const API = '/api/search';
const LS_PROFILE = 'glimpse.v1';
const LS_CACHE = 'glimpse.cache.v1';
const LS_PASS = 'glimpse.pass';
const DAY = 864e5;
const HALF_LIFE = 21 * DAY;           // interests fade by half every 3 weeks without activity
const CACHE_TTL = 20 * 3600e3;        // reuse search results on this device for 20h
const SEEN_HIDE = 7 * DAY;            // For You hides things you've seen in the last week
const STARTERS = ['Ocean waves', 'City at night', 'Mountains', 'Puppies', 'Street food', 'Northern lights',
  'Architecture', 'Rainy window', 'Skateboarding', 'Space', 'Coffee art', 'Forest'];
const SRC = {
  pexels: { name: 'Pexels', home: 'https://www.pexels.com' },
  pixabay: { name: 'Pixabay', home: 'https://pixabay.com' },
  youtube: { name: 'YouTube', home: 'https://www.youtube.com' },
};
const KIND_LABEL = { photo: 'Photos', video: 'Clips', youtube: 'YouTube' };
// How strongly each action teaches the feed. Positive = more like this.
const SIG = {
  like:    { terms: 1.0,  creator: 2.0,  kind: 0.8,  query: 1.0 },
  unlike:  { terms: -1.0, creator: -2.0, kind: -0.8, query: -1.0 },
  save:    { terms: 1.5,  creator: 3.0,  kind: 1.2,  query: 1.5 },
  unsave:  { terms: -1.5, creator: -3.0, kind: -1.2, query: -1.5 },
  watch:   { terms: 0.35, creator: 0.4,  kind: 0.35, query: 0.3 },
  skip:    { terms: -0.25, creator: -0.3, kind: -0.2, query: -0.2 },
  share:   { terms: 0.8,  creator: 1.0,  kind: 0.5,  query: 0.5 },
  open:    { terms: 0.5,  creator: 0.8,  kind: 0.3,  query: 0.3 },
  hide:    { terms: -2.0, creator: -4.0, kind: -0.6, query: -0.8 },
};
const STOP = new Set(('a an and are as at be by for from has have in into is it its of on or that the this to was were will with ' +
  'your you my our we they them their there here what when where who why how not no yes do does did can just about over under ' +
  'up down out off than then so very more most some any all each few such own same too also only video videos photo photos ' +
  'image images picture pictures stock footage free hd 4k uhd shorts short youtube pexels pixabay official new best top shot ' +
  'view close closeup clip clips background full one two day way get got make made like via vs amp').split(' '));

/* ======================= helpers ======================= */
const $ = (s, r = document) => r.querySelector(s);
const feedEl = $('#feed'), topEl = $('#top'), sheetEl = $('#sheet'), scrimEl = $('#scrim'), toastEl = $('#toast');
const now = () => Date.now();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : '#');
const icon = (n, cls) => `<svg class="i ${cls || ''}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const ext = (href, text) => `<a href="${esc(safeUrl(href))}" target="_blank" rel="noopener">${esc(text)}</a>`;
const fmtDur = (s) => { s = Math.round(s || 0); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };
const normQ = (q) => String(q || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function tokenize(text) {
  const words = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (let w of words) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
    if (!STOP.has(w)) out.push(w);
  }
  return out;
}
const uniq = (a) => [...new Set(a)];

/* ======================= memory (this device) ======================= */
function freshProfile() {
  return {
    v: 1, created: now(), terms: {}, creators: {}, kinds: {}, queries: {}, recent: [], saved: [],
    liked: {}, hidden: {}, seen: {}, stats: { searches: 0, likes: 0, saves: 0, skips: 0, views: 0 },
    settings: { sound: false, shortOnly: true, vertical: true },
  };
}
function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_PROFILE));
    if (p && p.v === 1) {
      const f = freshProfile();
      return Object.assign(f, p, { settings: Object.assign(f.settings, p.settings), stats: Object.assign(f.stats, p.stats) });
    }
  } catch (e) { /* corrupted or blocked: start fresh */ }
  return freshProfile();
}
let P = loadProfile();

// Weights fade over time so the feed follows what you're into now.
function eff(e) { return e ? e.w * Math.pow(0.5, (now() - e.t) / HALF_LIFE) : 0; }
function bump(map, key, delta, extra) {
  if (!key) return;
  const e = map[key];
  map[key] = Object.assign(e || {}, extra || {}, { w: clamp(eff(e) + delta, -15, 40), t: now() });
}
function pruneMap(map, max, byWeight) {
  const keys = Object.keys(map);
  if (byWeight) for (const k of keys) if (Math.abs(eff(map[k])) < 0.05 && !(map[k] && map[k].n)) delete map[k];
  const left = Object.keys(map);
  if (left.length <= max) return;
  left.sort((a, b) => (byWeight ? Math.abs(eff(map[b])) - Math.abs(eff(map[a])) : map[b] - map[a]));
  for (const k of left.slice(max)) delete map[k];
}
function prune() {
  pruneMap(P.terms, 600, true); pruneMap(P.creators, 250, true); pruneMap(P.queries, 80, true);
  pruneMap(P.seen, 3000); pruneMap(P.liked, 2000); pruneMap(P.hidden, 1500);
  if (P.saved.length > 300) P.saved.length = 300;
  if (P.recent.length > 12) P.recent.length = 12;
}
let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
function saveNow() {
  clearTimeout(saveTimer);
  prune();
  const s = JSON.stringify(P);
  try { localStorage.setItem(LS_PROFILE, s); }
  catch (e) { try { localStorage.removeItem(LS_CACHE); C = {}; localStorage.setItem(LS_PROFILE, s); } catch (_) { /* storage full or blocked */ } }
}
let persistAsked = false;
function askPersist() {
  if (persistAsked) return; persistAsked = true;
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* not supported */ }
}

/* results cache: saves your API quotas and makes revisits instant */
let C = {};
try { C = JSON.parse(localStorage.getItem(LS_CACHE)) || {}; for (const k in C) if (!C[k] || now() - C[k].t > C[k].ttl) delete C[k]; } catch (e) { C = {}; }
function cacheGet(k) { const e = C[k]; return e && now() - e.t < e.ttl ? e.d : null; }
function cachePut(k, d, ttl) {
  C[k] = { t: now(), ttl, d };
  const keys = Object.keys(C);
  if (keys.length > 36) keys.sort((a, b) => C[a].t - C[b].t).slice(0, keys.length - 36).forEach((x) => delete C[x]);
  try { localStorage.setItem(LS_CACHE, JSON.stringify(C)); } catch (e) { C = {}; try { localStorage.removeItem(LS_CACHE); } catch (_) {} }
}

/* ======================= learning ======================= */
function itemTokens(it) {
  return uniq([...tokenize(it.title), ...(it.tags || []).flatMap(tokenize), ...tokenize(it.q)]).slice(0, 24);
}
function learn(it, sig) {
  const s = SIG[sig];
  if (!s || !it || it.kind === 'notice') return;
  const toks = it.tokens || itemTokens(it);
  const per = (s.terms * 2.5) / Math.sqrt(Math.max(1, toks.length));
  for (const t of toks) bump(P.terms, t, per);
  if (it.creator && it.creator.id) bump(P.creators, it.creator.id, s.creator, { name: it.creator.name, source: it.source });
  bump(P.kinds, it.kind, s.kind);
  if (it.q && (P.queries[it.q] || s.query > 0)) bump(P.queries, it.q, s.query, { n: (P.queries[it.q] && P.queries[it.q].n) || 0 });
  saveSoon();
}
function learnSearch(q) {
  const e = P.queries[q];
  bump(P.queries, q, 2.0, { n: ((e && e.n) || 0) + 1 });
  for (const t of tokenize(q)) bump(P.terms, t, 1.2);
  P.recent = [q, ...P.recent.filter((x) => x !== q)].slice(0, 12);
  P.stats.searches++;
  saveSoon();
}

/* ======================= ranking ======================= */
function score(it, mode, rarity) {
  // rarity(t): 1 for words few results share, ~0 for words every result has (like the search itself),
  // so the score reacts to what makes this item different.
  const toks = it.tokens || [];
  let sum = 0;
  const why = [];
  for (const t of toks) {
    const w = eff(P.terms[t]);
    if (!w) continue;
    sum += w * (rarity ? rarity(t) : 1);
    if (w > 0.6) why.push([t, w]);
  }
  const interest = 2.5 * Math.tanh(sum / Math.sqrt(Math.max(1, toks.length)) / 4);
  const cw = it.creator ? eff(P.creators[it.creator.id]) : 0;
  const creator = 1.2 * Math.tanh(cw / 3);
  const kind = 0.9 * Math.tanh(eff(P.kinds[it.kind]) / 4);
  const base = 0.8 * (1 - Math.min(it.rank || 0, 20) / 20);    // the source's own relevance order
  const seen = mode === 'search' && P.seen[it.id] ? -1.0 : 0;  // already seen: push down
  const explore = (Math.random() - 0.5) * 0.4;                 // a little variety
  it._why = why.sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
  it._fan = cw > 1.5;
  return base + interest + creator + kind + seen + explore;
}
function rankBatch(items, mode) {
  const df = {};
  for (const it of items) for (const t of new Set(it.tokens || [])) df[t] = (df[t] || 0) + 1;
  const n = items.length;
  const rarity = (t) => (n < 3 ? 1 : clamp(1 - ((df[t] || 1) - 1) / (n - 1), 0, 1));
  const pool = items.map((it) => ({ it, s: score(it, mode, rarity) }));
  const tail = S.items.filter((x) => x.kind !== 'notice');
  const kinds = tail.slice(-2).map((x) => x.kind);
  const creators = tail.slice(-4).map((x) => x.creator && x.creator.id);
  const out = [];
  while (pool.length) {
    let bi = 0, bs = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const { it, s } = pool[i];
      let pen = 0;
      const k1 = kinds[kinds.length - 1], k2 = kinds[kinds.length - 2];
      if (it.kind === k1) pen += 0.45;
      if (it.kind === k1 && it.kind === k2) pen += 0.9;       // avoid 3 of a kind in a row
      if (it.creator && creators.includes(it.creator.id)) pen += 0.8;
      if (s - pen > bs) { bs = s - pen; bi = i; }
    }
    const { it } = pool.splice(bi, 1)[0];
    out.push(it);
    kinds.push(it.kind); if (kinds.length > 2) kinds.shift();
    creators.push(it.creator && it.creator.id); if (creators.length > 4) creators.shift();
  }
  return out;
}
function weightedPick(pairs, k) {
  const pool = pairs.slice(), out = [];
  while (out.length < k && pool.length) {
    const total = pool.reduce((s, p) => s + Math.max(0.05, p[1]), 0);
    let r = Math.random() * total, i = 0;
    for (; i < pool.length - 1; i++) { r -= Math.max(0.05, pool[i][1]); if (r <= 0) break; }
    out.push(pool.splice(i, 1)[0][0]);
  }
  return out;
}
function pickSeeds() {
  const qs = Object.entries(P.queries).map(([q, e]) => [q, eff(e)]).filter((x) => x[1] > 0.25)
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  const seeds = weightedPick(qs, 3);
  const used = new Set(seeds.flatMap(tokenize));
  const terms = Object.entries(P.terms).map(([t, e]) => [t, eff(e)])
    .filter(([t, w]) => w > 1.2 && !used.has(t)).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return uniq([...seeds, ...weightedPick(terms, seeds.length ? 1 : 3)]);
}
function topInterests(n) {
  return Object.entries(P.terms).map(([t, e]) => [t, eff(e)]).filter((x) => x[1] > 0.5)
    .sort((a, b) => b[1] - a[1]).slice(0, n);
}

/* ======================= state ======================= */
const S = {
  mode: 'foryou', query: '', items: [], ids: new Set(), active: -1, viewStart: 0, mounted: new Set(),
  loading: false, done: false, cursor: null, seeds: [], round: 0, gen: 0, status: null,
  passHash: (() => { try { return localStorage.getItem(LS_PASS) || ''; } catch (e) { return ''; } })(),
  sheet: null, shown: new Set(),
};
const hasYT = () => !S.status || S.status.sources.youtube;
const isSaved = (id) => P.saved.some((x) => x.id === id);

/* ======================= server calls ======================= */
async function api(o) {
  const u = new URLSearchParams();
  u.set('q', o.q);
  u.set('page', String(o.page || 1));
  if (o.yt) u.set('yt', o.yt);
  if (o.media === false) u.set('media', '0');
  if (!P.settings.shortOnly) u.set('short', '0');
  if (o.yt && P.settings.vertical) u.set('vertical', '1');
  if (S.passHash) u.set('k', S.passHash);
  const key = u.toString();
  const hit = cacheGet(key);
  if (hit) return hit;
  const r = await fetch(API + '?' + key, { headers: { accept: 'application/json' } });
  if (r.status === 401) { setPass(''); askPasscode(); throw new Error('passcode'); }
  let data;
  try { data = await r.json(); } catch (e) { throw new Error('The server sent something unexpected.'); }
  if (!r.ok) throw new Error(data.message || 'Search failed.');
  cachePut(key, data, data.errors && data.errors.length ? 10 * 60e3 : CACHE_TTL);
  return data;
}
async function loadStatus() {
  try {
    const r = await fetch(API + '?status=1', { cache: 'no-store' });
    if (r.ok) S.status = await r.json();
  } catch (e) { /* offline: assume configured */ }
  return S.status;
}
function setPass(h) { S.passHash = h; try { h ? localStorage.setItem(LS_PASS, h) : localStorage.removeItem(LS_PASS); } catch (e) {} }
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function reportErrors(data) {
  for (const e of (data && data.errors) || []) {
    const key = e.source + ':' + e.code;
    if (S.shown.has(key)) continue;
    S.shown.add(key);
    if (e.code === 'no-keys') continue;
    toast(e.message, 5000);
  }
}

/* ======================= toast ======================= */
let toastQ = [], toastBusy = false;
function toast(msg, ms) {
  toastQ.push([msg, ms || 2600]);
  if (!toastBusy) nextToast();
}
function nextToast() {
  const n = toastQ.shift();
  if (!n) { toastBusy = false; return; }
  toastBusy = true;
  toastEl.textContent = n[0];
  toastEl.classList.toggle('low', !!(S.items[S.active] && S.items[S.active].kind === 'youtube'));
  toastEl.classList.add('show');
  setTimeout(() => { toastEl.classList.remove('show'); setTimeout(nextToast, 220); }, n[1]);
}
