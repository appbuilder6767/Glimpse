/* Glimpse - ui.js: Panels (search, saved, interests, more), backup, events and start-up.
   Loaded in order by index.html: core.js, slides.js, feed.js, ui.js (they share top-level names). */
'use strict';

/* ======================= sheets ======================= */
function openSheet(html, opts) {
  opts = opts || {};
  const replacing = !!S.sheet;
  S.sheet = opts.name || 'sheet';
  sheetEl.className = (opts.full ? 'full ' : '') + 'open';
  sheetEl.innerHTML = html;
  sheetEl.setAttribute('aria-hidden', 'false');
  scrimEl.classList.add('show');
  if (replacing) history.replaceState({ sheet: S.sheet, mode: S.mode, q: S.query }, '');
  else history.pushState({ sheet: S.sheet, mode: S.mode, q: S.query }, '');
  // pause the current video while a sheet is up
  const v = slideEl(S.active) && slideEl(S.active).querySelector('video');
  if (v) v.pause();
  if (S.items[S.active] && S.items[S.active].kind === 'youtube') ytCommand(S.active, 'pauseVideo');
}
function hideSheet() {
  if (!S.sheet) return;
  S.sheet = null;
  sheetEl.classList.remove('open');
  sheetEl.setAttribute('aria-hidden', 'true');
  scrimEl.classList.remove('show');
  const v = slideEl(S.active) && slideEl(S.active).querySelector('video');
  if (v && !slideEl(S.active).querySelector('.paused-ico')) playVideo(v);
  const it = S.items[S.active];
  if (it && it.kind === 'youtube') {
    const box = slideEl(S.active).querySelector('.player');
    if (it._player) ytCommand(S.active, 'playVideo');
    else if (box) startYT(box, it);
  }
}
function closeSheet() {
  if (!S.sheet) return;
  if (history.state && history.state.sheet) history.back(); else hideSheet();
}
function sheetHead(title) {
  return `<div class="sh-head"><h2>${esc(title)}</h2><button class="tb" data-act="close" aria-label="Close">${icon('close')}</button></div>`;
}

function openSearch() {
  const rec = P.recent.map((q) => `<span class="chip"><button data-q="${esc(q)}"><b>${esc(q)}</b></button><button class="x" data-act="forget" data-v="${esc(q)}" aria-label="Remove ${esc(q)}">${icon('close')}</button></span>`).join('');
  const ints = topInterests(10).map(([t]) => `<button class="chip hot" data-q="${esc(t)}">${esc(t)}</button>`).join('');
  openSheet(`
    <div class="sh-head" style="padding-right:8px">
      <form class="sbar" data-search style="flex:1">${icon('search')}<input id="q" name="q" type="search" placeholder="Search photos, clips, videos" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="100" aria-label="Search"></form>
      <button class="btn" data-act="close" style="background:none;padding:0 8px">Cancel</button>
    </div>
    <div class="sh-body">
      ${rec ? `<section><h3>Recent</h3><div class="chips">${rec}</div></section>` : ''}
      ${ints ? `<section><h3>Your interests</h3><div class="chips">${ints}</div></section>` : ''}
      <section><h3>Try</h3>${starterChips(STARTERS)}</section>
      <section><p class="fine">Safe search is on for every source. ${attributionLine()}</p></section>
    </div>`, { full: true, name: 'search' });
  const inp = $('#q', sheetEl);
  if (inp) inp.focus();
}
function openSavedSheet() {
  if (!P.saved.length) {
    openSheet(sheetHead('Saved') + `<div class="sh-body"><p>Nothing saved yet. Tap ${icon('bookmark')} on anything you want to keep.</p></div>`, { name: 'saved' });
    return;
  }
  const cells = P.saved.map((it, i) => `<button class="cell" data-act="opensaved" data-v="${i}" aria-label="${esc(it.title)}">
      <img src="${esc(safeUrl(it.thumb || it.image))}" alt="" loading="lazy">
      ${it.kind !== 'photo' ? `<span class="k">${icon(it.kind === 'youtube' ? 'yt' : 'play')}</span>` : ''}</button>`).join('');
  openSheet(sheetHead(`Saved (${P.saved.length})`) + `<div class="sh-body"><div class="grid">${cells}</div></div>`, { name: 'saved' });
}
function openYou() {
  const ints = topInterests(15);
  const max = ints.length ? ints[0][1] : 1;
  const rows = ints.map(([t, w]) => `<div class="row"><span class="lbl">${esc(t)}</span><span class="bar"><i style="width:${Math.max(6, 100 * w / max).toFixed(0)}%"></i></span><button class="x" data-act="dropterm" data-v="${esc(t)}" aria-label="Forget ${esc(t)}">${icon('close')}</button></div>`).join('');
  const kinds = ['photo', 'video', 'youtube'].map((k) => [k, Math.exp(Math.tanh(eff(P.kinds[k]) / 4))]);
  const tot = kinds.reduce((s, x) => s + x[1], 0);
  const mix = kinds.map(([k, v]) => `<div class="row"><span class="lbl">${KIND_LABEL[k]}</span><span class="bar"><i style="width:${(100 * v / tot * 1.6).toFixed(0)}%"></i></span><span style="width:38px;text-align:right;color:var(--muted)">${Math.round(100 * v / tot)}%</span></div>`).join('');
  const fans = Object.entries(P.creators).map(([id, e]) => [e.name || id, eff(e), e.source]).filter((x) => x[1] > 1).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([n, , s]) => `<span class="chip">${esc(n)} <small style="color:var(--faint)">${esc((SRC[s] || {}).name || '')}</small></span>`).join('');
  const st = S.status ? S.status.sources : null;
  const srcs = st ? ['pexels', 'pixabay', 'youtube'].map((s) => `<span class="${st[s] ? 'ok' : 'no'}">${SRC[s].name} ${st[s] ? '✓ on' : '– no key'}</span>`).join('') : '<span class="no">Couldn’t check</span>';
  const tog = (key, label, on) => `<button class="toggle" role="switch" aria-checked="${on}" data-act="toggle" data-v="${key}"><span>${label}</span><span class="sw"></span></button>`;
  openSheet(sheetHead('What Glimpse has learned') + `<div class="sh-body">
    <section><h3>Top interests</h3>${rows || '<p>Nothing yet. Search, like and save things, and your interests show up here.</p>'}</section>
    <section><h3>Your mix</h3>${mix}</section>
    ${fans ? `<section><h3>Creators you like</h3><div class="chips">${fans}</div></section>` : ''}
    <section><p class="fine" style="margin:0">${P.stats.searches} searches · ${P.stats.likes} likes · ${P.saved.length} saved · ${P.stats.views} viewed · ${P.stats.skips} skipped</p></section>
    <section><h3>Settings</h3>
      ${tog('sound', 'Play with sound', P.settings.sound)}
      ${tog('vertical', 'Vertical YouTube videos (Shorts) that fill the screen', P.settings.vertical)}
      ${tog('shortOnly', 'Short YouTube videos only (under 4 min)', P.settings.shortOnly)}
    </section>
    <section><h3>Sources</h3><div class="src">${srcs}<span class="ok">Safe search: strict, always on</span></div></section>
    <section><h3>Keep your memory</h3>
      <p>Everything Glimpse learns is stored only in this browser on this device.</p>
      ${installHint()}
      <div class="stack" style="margin-top:10px">
        <button class="btn wide" data-act="backup">${icon('link')}Copy backup code</button>
        <textarea id="restore" placeholder="Paste a backup code here to restore"></textarea>
        <button class="btn wide" data-act="restore">Restore from code</button>
      </div>
    </section>
    <section><h3>About &amp; privacy</h3>
      <p>Glimpse uses YouTube API Services. By watching YouTube videos here you agree to the ${ext('https://www.youtube.com/t/terms', 'YouTube Terms of Service')}. See the ${ext('https://policies.google.com/privacy', 'Google Privacy Policy')}.</p>
      <p>Privacy: your searches go to this app’s own server, which asks ${st && !st.pixabay ? 'Pexels' : 'Pexels/Pixabay'} and YouTube for results. Your likes, saves, skips and interests never leave this device. Media loads straight from those services, and the YouTube player is in privacy-enhanced mode. Tap “Forget everything” to delete it all.</p>
      <p class="fine">${attributionLine()}</p>
    </section>
    <section><button class="btn wide danger" data-act="wipe">Forget everything</button></section>
  </div>`, { name: 'you' });
}
function openMore(i) {
  const it = S.items[i];
  if (!it || it.kind === 'notice') return;
  const reasons = [];
  if (it.q) reasons.push(S.mode === 'search' ? `you searched “${esc(it.q)}”` : `you’re into “${esc(it.q)}”`);
  const w = (it._why || []).filter((t) => !tokenize(it.q).includes(t));
  if (w.length) reasons.push('it matches ' + w.map((t) => `“${esc(t)}”`).join(', '));
  if (it._fan) reasons.push(`you’ve liked ${esc(it.creator.name)} before`);
  const src = SRC[it.source].name;
  openSheet(`<div class="sh-body" style="padding-top:18px">
    <div class="more-head"><img src="${esc(safeUrl(it.thumb || it.image))}" alt=""><div><b>${esc(it.title)}</b><small>${creditHTML(it)}</small></div></div>
    ${reasons.length ? `<div class="why">Showing this because ${reasons.join(', and ')}.</div>` : ''}
    <div class="stack">
      <button class="btn wide" data-act="hide" data-v="${i}">${icon('ban')}Not interested</button>
      <button class="btn wide" data-act="similar" data-v="${i}">${icon('search')}More like this</button>
      <a class="btn wide" href="${esc(safeUrl(it.pageUrl))}" target="_blank" rel="noopener" data-act="open" data-v="${i}">${icon('open')}Open on ${src}</a>
      <button class="btn wide" data-act="copylink" data-v="${i}">${icon('link')}Copy link</button>
      <button class="btn wide" data-act="close">Close</button>
    </div></div>`, { name: 'more' });
}
let passPromptOpen = false;
function askPasscode() {
  if (passPromptOpen) return;
  passPromptOpen = true;
  openSheet(sheetHead('Enter passcode') + `<div class="sh-body">
    <p>This Glimpse is private. Enter the passcode you set in Vercel (APP_PASSCODE). You only need to do this once on this device.</p>
    <form data-pass><input class="pass" name="p" type="password" autocomplete="current-password" placeholder="Passcode" aria-label="Passcode"><button class="btn primary wide">Unlock</button></form>
  </div>`, { name: 'pass' });
  const inp = sheetEl.querySelector('input'); if (inp) inp.focus();
}

/* backup / restore */
function exportCode() {
  const json = JSON.stringify(Object.assign({}, P, { seen: {} }));
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'GLIMPSE1:' + btoa(bin);
}
function importCode(code) {
  const m = /^GLIMPSE1:([A-Za-z0-9+/=\s]+)$/.exec(String(code || '').trim());
  if (!m) throw new Error('That doesn’t look like a Glimpse backup code.');
  const bin = atob(m[1].replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const p = JSON.parse(new TextDecoder().decode(bytes));
  if (!p || p.v !== 1 || typeof p.terms !== 'object') throw new Error('That backup code is damaged.');
  const f = freshProfile();
  P = Object.assign(f, p, { settings: Object.assign(f.settings, p.settings), stats: Object.assign(f.stats, p.stats) });
  saveNow();
}

/* Saved YouTube videos are re-checked after ~25 days; removed or private ones drop out. */
async function refreshSavedYouTube() {
  if (!hasYT() || now() - (P.ytCheckedAt || 0) < DAY) return;
  const stale = P.saved.filter((x) => x.source === 'youtube' && now() - (x.fetchedAt || 0) > 25 * DAY).slice(0, 50);
  P.ytCheckedAt = now();
  if (!stale.length) { saveSoon(); return; }
  try {
    const u = new URLSearchParams({ refresh: stale.map((x) => x.id).join(',') });
    if (S.passHash) u.set('k', S.passHash);
    const r = await fetch(API + '?' + u);
    if (!r.ok) return;
    const fresh = new Map(((await r.json()).items || []).map((x) => [x.id, x]));
    const staleIds = new Set(stale.map((x) => x.id));
    P.saved = P.saved.flatMap((x) => {
      if (!staleIds.has(x.id)) return [x];
      const f = fresh.get(x.id);
      if (!f) return [];
      return [Object.assign(x, { title: f.title, tags: f.tags, creator: f.creator, thumb: f.thumb, width: f.width, height: f.height, duration: f.duration, fetchedAt: now() })];
    });
    saveSoon();
  } catch (e) { /* try again tomorrow */ }
}

/* ======================= events ======================= */
feedEl.addEventListener('click', (e) => {
  const slide = e.target.closest('.slide');
  if (!slide) return;
  const i = +slide.dataset.i;
  if (handleCommon(e, i)) return;
  if (e.target.closest('a, button, input, form, .info, .rail')) return;
  if (e.target.closest('.stage') && slide.classList.contains('media')) onStageTap(i, e);
});
sheetEl.addEventListener('click', (e) => { handleCommon(e, S.active); });
scrimEl.addEventListener('click', closeSheet);

function handleCommon(e, i) {
  const qBtn = e.target.closest('[data-q]');
  if (qBtn) { e.preventDefault(); startSearch(qBtn.dataset.q); return true; }
  const tag = e.target.closest('[data-tag]');
  if (tag) { e.preventDefault(); bump(P.terms, tag.dataset.tag, 1.0); startSearch(tag.dataset.tag); return true; }
  const a = e.target.closest('[data-act]');
  if (!a) {
    const link = e.target.closest('a[href^="https://"]');
    if (link && S.items[i] && S.items[i].kind !== 'notice' && !link.closest('#sheet')) learn(S.items[i], 'open');
    return false;
  }
  const act = a.dataset.act, v = a.dataset.v;
  const ii = v !== undefined && /^\d+$/.test(v) ? +v : i;
  switch (act) {
    case 'like': toggleLike(i); break;
    case 'save': toggleSave(i); break;
    case 'share': share(i); break;
    case 'more': openMore(i); break;
    case 'ytplay': { const box = a.closest('.player'); if (box && S.items[i]) { if (i !== S.active) setActive(i); startYT(box, S.items[i]); } break; }
    case 'close': closeSheet(); break;
    case 'hide': hideItem(ii); break;
    case 'similar': { const it = S.items[ii]; const words = uniq([...(it._why || []), ...(it.tokens || [])]).slice(0, 3).join(' '); closeSheetThen(() => goSearchPush(words)); break; }
    case 'open': if (S.items[ii]) learn(S.items[ii], 'open'); return false;
    case 'copylink': { const it = S.items[ii]; copyText(it.pageUrl).then((ok) => toast(ok ? 'Link copied' : it.pageUrl)); closeSheet(); break; }
    case 'opensaved': closeSheetThen(() => { goSaved(+v); history.pushState({ mode: 'saved' }, '', location.pathname); }); break;
    case 'forget': P.recent = P.recent.filter((x) => x !== v); saveSoon(); a.closest('.chip').remove(); break;
    case 'dropterm': delete P.terms[v]; for (const q of Object.keys(P.queries)) if (tokenize(q).includes(v)) delete P.queries[q]; saveSoon(); a.closest('.row').remove(); toast(`Forgot “${v}”`); break;
    case 'toggle': {
      if (v === 'sound') { toggleSound(); a.setAttribute('aria-checked', P.settings.sound); }
      else { P.settings[v] = !P.settings[v]; a.setAttribute('aria-checked', P.settings[v]); saveSoon(); }
      break;
    }
    case 'backup': copyText(exportCode()).then((ok) => toast(ok ? 'Backup code copied. Keep it somewhere safe, like Notes.' : 'Couldn’t copy. Try again.', 3500)); break;
    case 'restore': {
      try { importCode($('#restore', sheetEl).value); toast('Restored'); closeSheetThen(goForYou); } catch (err) { toast(err.message, 3500); }
      break;
    }
    case 'wipe':
      if (a.dataset.armed) {
        P = freshProfile(); saveNow();
        try { localStorage.removeItem(LS_CACHE); } catch (_) {} C = {};
        toast('Everything forgotten'); closeSheetThen(goForYou);
      } else { a.dataset.armed = '1'; a.textContent = 'Tap again to erase all likes, saves and interests'; }
      break;
    case 'recheck': loadStatus().then(goForYou); break;
    case 'retry': S.mode === 'search' ? goSearch(S.query, false) : goForYou(); break;
    case 'opensearch': openSearch(); break;
    default: return false;
  }
  e.preventDefault();
  return true;
}
function closeSheetThen(fn) {
  if (!S.sheet) { fn(); return; }
  if (history.state && history.state.sheet) { pendingAfterPop = fn; history.back(); } else { hideSheet(); fn(); }
}
let pendingAfterPop = null;
function goSearchPush(q) {
  q = normQ(q);
  if (!q) return;
  history.pushState({ mode: 'search', q }, '', '?q=' + encodeURIComponent(q));
  goSearch(q);
}
function startSearch(q) {
  if (S.sheet) closeSheetThen(() => goSearchPush(q)); else goSearchPush(q);
}

document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.matches('[data-search]')) {
    e.preventDefault();
    const q = f.querySelector('input').value;
    if (normQ(q)) { f.querySelector('input').blur(); startSearch(q); }
  } else if (f.matches('[data-pass]')) {
    e.preventDefault();
    const val = f.querySelector('input').value;
    if (!val) return;
    sha256(val).then((h) => {
      setPass(h);
      passPromptOpen = false;
      closeSheetThen(() => (S.mode === 'search' ? goSearch(S.query, false) : goForYou()));
    });
  }
});

window.addEventListener('popstate', (e) => {
  if (S.sheet) {
    if (S.sheet === 'pass') passPromptOpen = false;
    hideSheet();
    const fn = pendingAfterPop; pendingAfterPop = null;
    if (fn) fn();
    return;
  }
  const st = e.state || { mode: 'foryou' };
  if (st.mode === 'search' && st.q) { if (S.mode !== 'search' || S.query !== st.q) goSearch(st.q, false); }
  else if (st.mode === 'saved') goSaved(0);
  else if (S.mode !== 'foryou') goForYou();
});

$('#brand').addEventListener('click', () => { if (feedEl.scrollTop > 0) feedEl.scrollTo({ top: 0, behavior: 'smooth' }); else goForYou(); });
$('#modechip').addEventListener('click', () => { history.pushState({ mode: 'foryou' }, '', location.pathname); goForYou(); });
$('#bSearch').addEventListener('click', openSearch);
$('#bSaved').addEventListener('click', openSavedSheet);
$('#bYou').addEventListener('click', openYou);
$('#bSound').addEventListener('click', toggleSound);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) { if (e.key === 'Escape') closeSheet(); return; }
  if (S.sheet) { if (e.key === 'Escape') closeSheet(); return; }
  const go = (d) => feedEl.scrollTo({ top: clamp(S.active + d, 0, S.items.length - 1) * feedEl.clientHeight, behavior: 'smooth' });
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(1); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(-1); }
  else if (e.key === 'l') toggleLike(S.active);
  else if (e.key === 's') toggleSave(S.active);
  else if (e.key === '/') { e.preventDefault(); openSearch(); }
});

document.addEventListener('visibilitychange', () => {
  const el = slideEl(S.active);
  const v = el && el.querySelector('video');
  if (document.hidden) {
    if (S.active >= 0) endView(S.active, false);
    if (v) v.pause();
    saveNow();
  } else {
    S.viewStart = performance.now();
    if (v && !S.sheet && !el.querySelector('.paused-ico')) playVideo(v);
  }
});
window.addEventListener('pagehide', saveNow);

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    measureSafe();
    for (const j of S.mounted) {
      const it = S.items[j], box = slideEl(j) && slideEl(j).querySelector('.player');
      if (it && box) sizePlayer(box, it, slideEl(j));
    }
    if (S.active >= 0) feedEl.scrollTop = S.active * feedEl.clientHeight;
  }, 150);
});

/* ======================= start ======================= */
measureSafe();
renderSoundBtn();
window.__glimpse = { S, get P() { return P; }, tokenize, score, rankBatch, pickSeeds, learn, eff };

(async () => {
  const startQ = new URLSearchParams(location.search).get('q');
  const statusP = loadStatus();
  if (startQ) {
    history.replaceState({ mode: 'search', q: normQ(startQ) }, '', '?q=' + encodeURIComponent(normQ(startQ)));
    await statusP;
    goSearch(startQ);
  } else {
    history.replaceState({ mode: 'foryou' }, '', location.pathname);
    await statusP;
    goForYou();
  }
  if (S.status && S.status.passcode && !S.passHash) askPasscode();
  else refreshSavedYouTube();
})();
