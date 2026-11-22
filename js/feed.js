/* Glimpse - feed.js: Loading and ranking the feed, notice slides, like/save/share, taps.
   Loaded in order by index.html: core.js, slides.js, feed.js, ui.js (they share top-level names). */
'use strict';

/* ======================= feed building ======================= */
function tagItems(items, q) {
  const t = now();
  return (items || []).map((it) => Object.assign(it, { q, fetchedAt: it.fetchedAt || t, tokens: itemTokens(Object.assign(it, { q })) }));
}
function appendItems(batch, opts) {
  const fresh = [];
  for (const it of batch) {
    if (!it || S.ids.has(it.id) || (P.hidden[it.id] && S.mode !== 'saved')) continue;
    S.ids.add(it.id);
    fresh.push(it);
  }
  if (!fresh.length) return 0;
  removeLoader();
  const list = opts && opts.noRank ? fresh : rankBatch(fresh, S.mode);
  const frag = document.createDocumentFragment(), els = [];
  for (const it of list) {
    const el = makeSlide(it, S.items.length);
    S.items.push(it);
    frag.append(el); els.push(el);
  }
  feedEl.append(frag);
  els.forEach((el) => io.observe(el));
  return list.length;
}
let noticeN = 0;
function appendNotice(html) {
  const it = { kind: 'notice', id: 'notice-' + (++noticeN), html };
  const el = makeSlide(it, S.items.length);
  S.items.push(it);
  feedEl.append(el);
  io.observe(el);
  return it;
}
function appendLoader() {
  const it = appendNotice('<div class="notice center"><div class="spinner"></div><p>Finding things you’ll like…</p></div>');
  it.loader = true;
}
function removeLoader() {
  const i = S.items.findIndex((x) => x.loader);
  if (i < 0) return;
  // Loader is only ever the last slide in an otherwise empty feed.
  io.unobserve(slideEl(i)); slideEl(i).remove(); S.items.splice(i, 1);
  if (S.active === i) S.active = -1;
}
function reset(mode) {
  S.gen++;
  if (S.active >= 0) endView(S.active, false);
  saveSoon();
  io.disconnect();
  S.items.forEach(dropPlayer);
  feedEl.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
  feedEl.innerHTML = '';
  feedEl.scrollTop = 0;
  Object.assign(S, { mode, items: [], ids: new Set(), active: -1, viewStart: 0, mounted: new Set(), loading: false, done: false, cursor: null, seeds: [], round: 0, blocked: false, noKeys: false });
  $('#spin').hidden = true;
  updateHeader();
}
function updateHeader() {
  const chip = $('#modechip'), brand = $('#brand');
  if (S.mode === 'foryou') { chip.hidden = true; brand.hidden = false; return; }
  brand.hidden = true; chip.hidden = false;
  chip.querySelector('span').textContent = S.mode === 'saved' ? 'Saved' : S.query;
}

async function loadMore() {
  if (S.loading || S.done || S.mode === 'saved') return;
  S.loading = true;
  const gen = S.gen;
  const realCount = () => S.items.filter((x) => x.kind !== 'notice').length;
  if (realCount()) $('#spin').hidden = false;
  try {
    let added = 0, rounds = 0;
    while (added < 4 && rounds < 4 && !S.done) {
      rounds++;
      const batch = S.mode === 'search' ? await searchPage() : await forYouRound();
      if (gen !== S.gen) return;
      added += appendItems(batch);
    }
    if (S.done && gen === S.gen) {
      removeLoader();
      if (!S.items.some((x) => x.end)) {
        const n = appendNotice(realCount() || (S.mode === 'foryou' && !S.noKeys) ? endHTML() : emptyHTML());
        n.end = true;
      }
    }
  } catch (e) {
    if (gen !== S.gen) return;
    if (e.message !== 'passcode') {
      if (!realCount()) { removeLoader(); appendNotice(errorHTML(e.message)); S.done = true; }
      else toast('Couldn’t load more. Check your connection.');
    }
  } finally {
    if (gen === S.gen) { S.loading = false; $('#spin').hidden = true; }
  }
}
async function searchPage() {
  const c = S.cursor;
  const ytParam = c.yt && c.ytPages < 2 ? c.yt : '';
  if (c.page == null && !ytParam) { S.done = true; return []; }
  const data = await api({ q: S.query, page: c.page || 1, yt: ytParam, media: c.page != null });
  reportErrors(data);
  if (data.blocked) { S.done = true; S.blocked = true; return []; }
  if (data.errors && data.errors.some((e) => e.code === 'no-keys')) { S.done = true; S.noKeys = true; return []; }
  if (c.page != null) c.page = data.next.page;
  if (ytParam) { c.ytPages++; c.yt = data.next.yt; }
  if (c.page == null && !(c.yt && c.ytPages < 2)) S.done = true;
  return tagItems(data.items, S.query);
}
async function forYouRound() {
  const live = S.seeds.filter((s) => !s.done);
  if (!live.length) { S.done = true; return []; }
  const round = S.round++;
  const res = await Promise.all(live.map((s, idx) => {
    const yt = round < 2 && idx < 2 && s.yt ? s.yt : '';
    if (s.page == null && !yt) { s.done = true; return { s, d: null }; }
    return api({ q: s.q, page: s.page || 1, yt, media: s.page != null })
      .then((d) => ({ s, d, yt })).catch((e) => ({ s, e }));
  }));
  let items = [];
  for (const r of res) {
    if (r.e) { if (r.e.message === 'passcode') throw r.e; r.s.done = true; continue; }
    if (!r.d) continue;
    reportErrors(r.d);
    if (r.d.errors && r.d.errors.some((e) => e.code === 'no-keys')) { S.done = true; S.noKeys = true; return []; }
    if (r.s.page != null) r.s.page = r.d.next.page;
    if (r.yt) r.s.yt = r.d.next.yt;
    if (r.s.page == null && !(r.s.yt && S.round < 2)) r.s.done = true;
    items = items.concat(tagItems(r.d.items, r.s.q));
  }
  const cutoff = now() - SEEN_HIDE;
  return items.filter((it) => !(P.seen[it.id] > cutoff));
}

function goForYou() {
  reset('foryou');
  if (S.status && !S.status.sources.pexels && !S.status.sources.pixabay && !S.status.sources.youtube) {
    appendNotice(setupHTML()); S.done = true; return;
  }
  const seeds = pickSeeds();
  if (!seeds.length) { appendNotice(welcomeHTML()); S.done = true; return; }
  S.seeds = seeds.map((q) => ({ q, page: 1, yt: hasYT() ? 'first' : null, done: false }));
  appendLoader();
  loadMore();
}
function goSearch(q, learnIt) {
  q = normQ(q);
  if (!q) return;
  if (learnIt !== false) learnSearch(q);
  reset('search');
  S.query = q;
  S.blocked = false;
  S.cursor = { page: 1, yt: hasYT() ? 'first' : null, ytPages: 0 };
  updateHeader();
  appendLoader();
  loadMore();
}
function goSaved(index) {
  reset('saved');
  S.done = true;
  if (!P.saved.length) { appendNotice(`<div class="notice center"><h2>Nothing saved yet</h2><p>Tap ${icon('bookmark')} on anything you want to keep.</p></div>`); return; }
  appendItems(P.saved.map((x) => Object.assign({}, x)), { noRank: true });
  requestAnimationFrame(() => {
    feedEl.scrollTop = (index || 0) * feedEl.clientHeight;
    setActive(index || 0);
  });
}

/* ======================= notice slides ======================= */
function attributionLine() {
  const st = (S.status && S.status.sources) || { pexels: true, pixabay: false, youtube: true };
  const parts = [];
  if (st.pexels) parts.push(`Photos and videos provided by ${ext('https://www.pexels.com', 'Pexels')}`);
  if (st.pixabay) parts.push(`${st.pexels ? 'and' : 'Photos and videos from'} ${ext('https://pixabay.com', 'Pixabay')}`);
  if (st.youtube) parts.push(`· Videos from ${ext('https://www.youtube.com', 'YouTube')}`);
  return parts.join(' ');
}
function installHint() {
  if (standalone()) return '';
  if (isIOS) return '<p class="fine">Tip: tap Share → <b>Add to Home Screen</b>. Safari can erase what a site remembers if you don’t open it for a week; the Home Screen app keeps it.</p>';
  return '<p class="fine">Tip: use your browser menu → <b>Add to Home screen</b> to open Glimpse like an app.</p>';
}
function starterChips(list) {
  return `<div class="chips">${list.map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
}
function welcomeHTML() {
  return `<div class="notice">
    <div class="logo">${icon('play')}</div>
    <h1>Search anything.<br>Swipe forever.</h1>
    <p>Photos, clips and YouTube videos in one feed. Like ${icon('heart', 'inl')}, save, or just swipe past. Glimpse learns your taste and remembers it on this device.</p>
    <form class="sbar" data-search><input name="q" type="search" placeholder="Try “ocean waves”" enterkeyhint="search" autocomplete="off" maxlength="100" aria-label="Search"><button class="go">Go</button></form>
    ${starterChips(STARTERS)}
    <p class="fine">Safe search is always on. ${attributionLine()}</p>
    ${installHint()}
  </div>`;
}
function setupHTML() {
  return `<div class="notice">
    <div class="logo">${icon('spark')}</div>
    <h2>Almost there: add your API keys</h2>
    <p>The app is running, but the server has no API keys yet.</p>
    <ol>
      <li>Open your project on vercel.com → <b>Settings</b> → <b>Environment Variables</b>.</li>
      <li>Add <code>PEXELS_API_KEY</code> and/or <code>PIXABAY_API_KEY</code>, and <code>YOUTUBE_API_KEY</code>.</li>
      <li>Go to <b>Deployments</b> → ⋯ on the newest one → <b>Redeploy</b>.</li>
    </ol>
    <button class="btn primary" data-act="recheck">Check again</button>
  </div>`;
}
function endHTML() {
  const ints = topInterests(6).map((x) => x[0]);
  return `<div class="notice center">
    <h2>You’re all caught up</h2>
    <p>${S.mode === 'search' ? 'That’s everything for this search.' : 'That’s everything new for now.'} Try something else:</p>
    ${starterChips(ints.length ? ints : STARTERS.slice(0, 6))}
    <button class="btn primary" data-act="opensearch">${icon('search')}New search</button>
  </div>`;
}
function emptyHTML() {
  if (S.noKeys) return setupHTML();
  if (S.blocked) return `<div class="notice center"><h2>Safe search is on</h2><p>Glimpse doesn’t show results for that search. Try something else.</p>${starterChips(STARTERS.slice(0, 6))}</div>`;
  return `<div class="notice center"><h2>No results for “${esc(S.query)}”</h2><p>Try fewer or different words.</p>${starterChips(STARTERS.slice(0, 6))}</div>`;
}
function errorHTML(msg) {
  return `<div class="notice center"><h2>Couldn’t load the feed</h2><p>${esc(msg || 'Check your connection and try again.')}</p><button class="btn primary" data-act="retry">Try again</button></div>`;
}

/* ======================= actions ======================= */
function slim(it) {
  const o = {};
  for (const k of ['id', 'source', 'kind', 'title', 'tags', 'creator', 'pageUrl', 'width', 'height', 'color', 'image', 'thumb', 'video', 'poster', 'duration', 'ytId', 'q', 'tokens', 'refreshable', 'fetchedAt']) if (it[k] !== undefined) o[k] = it[k];
  return o;
}
function toggleLike(i, onlyOn) {
  const it = S.items[i];
  if (!it || it.kind === 'notice') return;
  if (P.liked[it.id]) {
    if (onlyOn) return;
    delete P.liked[it.id]; P.stats.likes = Math.max(0, P.stats.likes - 1); learn(it, 'unlike');
  } else {
    P.liked[it.id] = now(); P.stats.likes++; learn(it, 'like'); askPersist();
  }
  updateRail(i); popBtn(i, 'like');
}
function toggleSave(i) {
  const it = S.items[i];
  if (!it || it.kind === 'notice') return;
  if (isSaved(it.id)) {
    P.saved = P.saved.filter((x) => x.id !== it.id); P.stats.saves = Math.max(0, P.stats.saves - 1); learn(it, 'unsave');
    toast('Removed from Saved');
  } else {
    P.saved.unshift(slim(it)); P.stats.saves++; learn(it, 'save'); askPersist();
    toast('Saved');
  }
  updateRail(i); popBtn(i, 'save');
}
async function share(i) {
  const it = S.items[i];
  if (!it) return;
  learn(it, 'share');
  const data = { title: it.title, url: it.pageUrl };
  try {
    if (navigator.share) { await navigator.share(data); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  copyText(it.pageUrl).then((ok) => toast(ok ? 'Link copied' : it.pageUrl));
}
function hideItem(i) {
  const it = S.items[i];
  if (!it) return;
  P.hidden[it.id] = now();
  learn(it, 'hide');
  closeSheet();
  toast('Got it — you’ll see less like this');
  const el = slideEl(i);
  if (el) {
    unmount(i);
    el.querySelector('.stage').innerHTML = '<div class="fail">Hidden. Swipe up for the next one.</div>';
    it._failed = true;
    setTimeout(() => feedEl.scrollTo({ top: (i + 1) * feedEl.clientHeight, behavior: 'smooth' }), 350);
  }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}
function burst(x, y) {
  const b = document.createElement('div');
  b.className = 'burst';
  b.innerHTML = icon('heart');
  b.style.left = x + 'px'; b.style.top = y + 'px';
  $('#app').append(b);
  setTimeout(() => b.remove(), 800);
}
function toggleSound() {
  P.settings.sound = !P.settings.sound;
  saveSoon();
  renderSoundBtn();
  const it = S.items[S.active], el = slideEl(S.active);
  if (it && el && it.kind === 'video') {
    const v = el.querySelector('video');
    if (v) { v.muted = !P.settings.sound; if (!v.muted) v.play().catch(() => {}); }
  }
  if (it && it.kind === 'youtube') ytCommand(S.active, P.settings.sound ? 'unMute' : 'mute');
  toast(P.settings.sound ? 'Sound on' : 'Sound off', 1200);
}
function renderSoundBtn() {
  const b = $('#bSound');
  b.innerHTML = icon(P.settings.sound ? 'sound' : 'mute');
  b.setAttribute('aria-label', P.settings.sound ? 'Sound on' : 'Sound off');
}

/* taps on the media: single tap = pause/play (or show whole photo), double tap = like */
let tapTimer = 0, lastTap = 0;
function onStageTap(i, e) {
  const t = performance.now();
  if (t - lastTap < 280) {
    clearTimeout(tapTimer); lastTap = 0;
    const r = $('#app').getBoundingClientRect();
    burst(e.clientX - r.left, e.clientY - r.top);
    toggleLike(i, true);
    return;
  }
  lastTap = t;
  tapTimer = setTimeout(() => {
    const it = S.items[i], el = slideEl(i);
    if (!it || !el) return;
    if (it.kind === 'video') {
      const v = el.querySelector('video');
      if (!v) return;
      const st = el.querySelector('.stage');
      if (v.paused) { playVideo(v); const pi = st.querySelector('.paused-ico'); if (pi) pi.remove(); }
      else { v.pause(); if (!st.querySelector('.paused-ico')) st.insertAdjacentHTML('beforeend', `<div class="paused-ico">${icon('play')}</div>`); }
    } else if (it.kind === 'photo') {
      const img = el.querySelector('.stage .fg');
      if (!img) return;
      it._fit = img.classList.contains('cover') ? 'contain' : 'cover';
      unmount(i); mount(i, i === S.active);
    }
  }, 280);
}
