/* Glimpse - slides.js: Slides, media, the YouTube player, and which slide is on screen.
   Loaded in order by index.html: core.js, slides.js, feed.js, ui.js (they share top-level names). */
'use strict';

/* ======================= slides ======================= */
function slideEl(i) { return feedEl.children[i] || null; }
function railBtn(cls, ic, label, on) {
  return `<button class="act ${cls}${on ? ' on' : ''}" data-act="${cls}" aria-label="${label}"${on !== undefined ? ` aria-pressed="${!!on}"` : ''}><span class="ring">${icon(ic)}</span><span class="lbl">${label}</span></button>`;
}
function creditHTML(it) {
  const c = it.creator || {};
  if (it.source === 'youtube') return `${ext(c.url, c.name)} · YouTube${it.duration ? ' · ' + fmtDur(it.duration) : ''}`;
  const s = SRC[it.source];
  const what = it.kind === 'video' ? 'Video' : 'Photo';
  return `${what} by ${ext(c.url, c.name)} ${it.source === 'pixabay' ? 'from' : 'on'} ${ext(it.pageUrl || s.home, s.name)}`;
}
function showTags(it) {
  const skip = new Set(tokenize(S.mode === 'search' ? S.query : it.q));
  const fromTags = (it.tags || []).flatMap(tokenize);
  return uniq([...fromTags, ...tokenize(it.title)]).filter((t) => !skip.has(t) && t.length < 18).slice(0, 3);
}
function makeSlide(it, i) {
  const el = document.createElement('article');
  el.dataset.i = i;
  if (it.kind === 'notice') { el.className = 'slide'; el.innerHTML = it.html; return el; }
  el.className = 'slide ' + (it.kind === 'youtube' ? 'yt' : 'media');
  const liked = !!P.liked[it.id], saved = isSaved(it.id);
  const badge = it.kind === 'youtube'
    ? icon('yt') + 'YouTube' + (it.duration ? ' · ' + fmtDur(it.duration) : '')
    : icon(it.kind === 'video' ? 'clip' : 'photo') + SRC[it.source].name + ' · ' + (it.kind === 'video' ? 'Clip' + (it.duration ? ' ' + fmtDur(it.duration) : '') : 'Photo');
  const tags = showTags(it).map((t) => `<button class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
  el.innerHTML = `
    <div class="stage" style="--c:${/^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : '#0d0d10'}"></div>
    ${it.kind === 'youtube' ? '' : '<div class="shade"></div>'}
    <div class="info">
      ${it.kind === 'youtube' ? '' : `<span class="badge">${badge}</span>`}
      <h2 class="title">${esc(it.title)}</h2>
      <p class="credit">${creditHTML(it)}</p>
      ${tags && it.kind !== 'youtube' ? `<div class="tags">${tags}</div>` : ''}
    </div>
    <div class="rail">
      ${railBtn('like', 'heart', liked ? 'Liked' : 'Like', liked)}
      ${railBtn('save', 'bookmark', saved ? 'Saved' : 'Save', saved)}
      ${railBtn('share', 'share', 'Share')}
      ${railBtn('more', 'dots', 'More')}
    </div>
    ${it.kind === 'video' ? '<div class="progress"><i></i></div>' : ''}`;
  return el;
}
function updateRail(i) {
  const it = S.items[i], el = slideEl(i);
  if (!it || !el) return;
  const liked = !!P.liked[it.id], saved = isSaved(it.id);
  const lb = el.querySelector('.act.like'), sb = el.querySelector('.act.save');
  if (lb) { lb.classList.toggle('on', liked); lb.setAttribute('aria-pressed', liked); lb.querySelector('.lbl').textContent = liked ? 'Liked' : 'Like'; }
  if (sb) { sb.classList.toggle('on', saved); sb.setAttribute('aria-pressed', saved); sb.querySelector('.lbl').textContent = saved ? 'Saved' : 'Save'; }
}
function popBtn(i, cls) {
  const b = slideEl(i) && slideEl(i).querySelector('.act.' + cls);
  if (!b) return;
  b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
}

/* media mounting: only the current slide and its neighbours hold media */
function screenAR() { return feedEl.clientWidth / Math.max(1, feedEl.clientHeight); }
function coverFit(it) {
  if (it._fit) return it._fit === 'cover';
  const r = (it.width / Math.max(1, it.height)) / screenAR();
  return r > 0.7 && r < 1.5;
}
function bgImg(src) { const b = new Image(); b.className = 'bg'; b.alt = ''; b.decoding = 'async'; if (src) b.src = src; return b; }
let safeBottom = 0;
function measureSafe() {
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;visibility:hidden;height:env(safe-area-inset-bottom,0px)';
  document.body.append(d); safeBottom = d.offsetHeight; d.remove();
}
function sizePlayer(box, it, el) {
  // As big as possible between the top bar and the caption. YouTube's rules: nothing may cover the player.
  const W = feedEl.clientWidth, H = feedEl.clientHeight;
  const top = topEl.offsetHeight + 2;
  const info = el && el.querySelector('.info');
  const bottomEdge = info && info.offsetTop > 0 ? info.offsetTop - 8 : H - 110 - safeBottom;
  const ar = (it.width || 16) / (it.height || 9);
  const avail = Math.max(200, bottomEdge - top);
  let w = W - 12, h = w / ar;
  if (h > avail) { h = avail; w = h * ar; }
  w = Math.max(w, 200); h = Math.max(h, 200);
  Object.assign(box.style, { width: w + 'px', height: h + 'px', left: (W - w) / 2 + 'px', top: top + Math.max(0, (avail - h) / 2) + 'px' });
}
function ytPoster(it) {
  return `<button class="poster" data-act="ytplay" aria-label="Play ${esc(it.title)}"><img src="${esc(safeUrl(it.thumb))}" alt=""><span>${icon('play')}</span></button>`;
}
/* YouTube's official IFrame Player API tells us when a video ends, so the feed can move on.
   If it can't load, videos still play in the plain YouTube player. */
let ytApiP = null, ytApiFailedAt = 0;
function ytApi() {
  if (window.YT && window.YT.loaded && window.YT.Player) return Promise.resolve(window.YT);
  if (now() - ytApiFailedAt < 60e3) return Promise.resolve(null);
  if (!ytApiP) {
    ytApiP = new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => done(null), 6000);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') { try { prev(); } catch (e) { /* ignore */ } }
        done(window.YT);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => done(null);
      document.head.append(s);
    }).then((yt) => { if (!yt) { ytApiP = null; ytApiFailedAt = now(); } return yt; });
  }
  return ytApiP;
}
function ytVars() {
  return { autoplay: 1, mute: P.settings.sound ? 0 : 1, playsinline: 1, rel: 0, enablejsapi: 1, origin: location.origin };
}
function plainYT(box, it) {
  const f = document.createElement('iframe');
  f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(it.ytId)}?${new URLSearchParams(ytVars())}`;
  f.title = it.title;
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  f.allowFullscreen = true;
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  box.innerHTML = '';
  box.append(f);
}
function startYT(box, it) {
  if (it._failed || box.querySelector('iframe') || box.dataset.loading) return;
  box.dataset.loading = '1';
  ytApi().then((YT) => {
    delete box.dataset.loading;
    // Only the slide you're looking at gets a player, and only while no panel is open.
    if (!box.isConnected || S.items[S.active] !== it || S.sheet || box.querySelector('iframe')) return;
    if (!YT) { plainYT(box, it); return; }
    try {
      box.innerHTML = '<div></div>';
      it._player = new YT.Player(box.firstChild, {
        host: 'https://www.youtube-nocookie.com',
        videoId: it.ytId,
        width: '100%',
        height: '100%',
        playerVars: ytVars(),
        events: {
          onStateChange: (e) => { if (e.data === 0) ytEnded(it); },
          onError: () => ytFailed(it, box),
        },
      });
      const f = it._player.getIframe && it._player.getIframe();
      if (f) { f.title = it.title; f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin'); }
    } catch (e) {
      it._player = null;
      plainYT(box, it);
    }
  });
}
function dropPlayer(it) {
  if (it && it._player) { try { it._player.destroy(); } catch (e) { /* already gone */ } it._player = null; }
}
function stopYT(box, it) {
  dropPlayer(it);
  if (it._failed) return;
  if (box.querySelector('iframe') || !box.firstChild || !box.querySelector('.poster')) box.innerHTML = ytPoster(it);
}
function goTo(i) {
  if (i >= 0 && i < S.items.length) feedEl.scrollTo({ top: i * feedEl.clientHeight, behavior: 'smooth' });
}
function ytEnded(it) {
  const i = S.items.indexOf(it);
  if (i < 0 || i !== S.active || S.sheet || document.hidden) return;
  if (!it._watched) { it._watched = true; learn(it, 'watch'); }
  goTo(i + 1);
}
function ytFailed(it, box) {
  it._failed = true;
  dropPlayer(it);
  box.innerHTML = `<div class="ytmsg"><span>This video can’t play here.</span>${ext(it.pageUrl, 'Open on YouTube')}<span>Skipping to the next one…</span></div>`;
  const i = S.items.indexOf(it);
  setTimeout(() => { if (S.active === i && !S.sheet) goTo(i + 1); }, 2500);
}
function ytCommand(i, func) {
  const it = S.items[i];
  if (it && it._player && typeof it._player[func] === 'function') { try { it._player[func](); } catch (e) { /* not ready yet */ } return; }
  const f = slideEl(i) && slideEl(i).querySelector('iframe');
  if (f && f.contentWindow) f.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), 'https://www.youtube-nocookie.com');
}
function playVideo(v) {
  v.muted = !P.settings.sound;
  const p = v.play();
  if (p && p.catch) p.catch(() => {
    if (!v.muted) { v.muted = true; v.play().catch(() => {}); toastOnce('sound', 'Tap the speaker to turn sound on'); }
  });
}
function toastOnce(key, msg) { if (!S.shown.has(key)) { S.shown.add(key); toast(msg); } }

function mount(i, active) {
  const it = S.items[i], el = slideEl(i);
  if (!it || !el || it.kind === 'notice') return;
  const st = el.querySelector('.stage');
  if (it.refreshable && it.fetchedAt && now() - it.fetchedAt > 20 * 3600e3 && !it._refreshing) { refreshItem(i); return; }
  if (!st.firstChild) {
    if (it.kind === 'photo') {
      const cover = coverFit(it);
      if (!cover) st.append(bgImg(it.thumb || it.image));
      const img = new Image();
      img.className = 'fg' + (cover ? ' cover' : '');
      img.alt = it.title; img.decoding = 'async';
      img.onerror = () => mediaFailed(i);
      img.src = it.image;
      st.append(img);
    } else if (it.kind === 'video') {
      const cover = coverFit(it);
      if (!cover && it.poster) st.append(bgImg(it.poster));
      const v = document.createElement('video');
      v.className = 'fg' + (cover ? ' cover' : '');
      v.muted = true; v.loop = true; v.playsInline = true;
      v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.setAttribute('disablepictureinpicture', '');
      v.preload = active ? 'auto' : 'metadata';
      if (it.poster) v.poster = it.poster;
      v.onerror = () => mediaFailed(i);
      const bar = el.querySelector('.progress i');
      v.ontimeupdate = () => { if (bar && v.duration) bar.style.width = (100 * v.currentTime / v.duration).toFixed(2) + '%'; };
      v.src = it.video;
      st.append(v);
    } else if (it.kind === 'youtube') {
      st.append(bgImg(it.thumb));
      const box = document.createElement('div');
      box.className = 'player';
      sizePlayer(box, it, el);
      box.innerHTML = ytPoster(it);
      st.append(box);
    }
  }
  if (it.kind === 'video') {
    const v = st.querySelector('video');
    if (v) { if (active) { v.preload = 'auto'; playVideo(v); } else v.pause(); }
    const pi = st.querySelector('.paused-ico'); if (pi) pi.remove();
  } else if (it.kind === 'youtube') {
    const box = st.querySelector('.player');
    if (box) active ? startYT(box, it) : stopYT(box, it);
  }
}
function unmount(i) {
  dropPlayer(S.items[i]);
  const el = slideEl(i);
  const st = el && el.querySelector('.stage');
  if (!st || !st.firstChild) return;
  st.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
  st.innerHTML = '';
}
function mediaFailed(i) {
  const it = S.items[i], el = slideEl(i);
  if (!it || !el) return;
  if (it.refreshable && !it._refreshTried) { it._refreshTried = true; refreshItem(i); return; }
  it._failed = true;
  const st = el.querySelector('.stage');
  st.innerHTML = '<div class="fail">This one didn’t load. Swipe up for the next.</div>';
}
async function refreshItem(i) {
  const it = S.items[i];
  it._refreshing = true;
  try {
    const u = new URLSearchParams({ refresh: it.id });
    if (S.passHash) u.set('k', S.passHash);
    const r = await fetch(API + '?' + u);
    const d = await r.json();
    if (d.item) {
      Object.assign(it, { image: d.item.image, thumb: d.item.thumb, video: d.item.video || it.video, poster: d.item.poster || it.poster, fetchedAt: now() });
      const sv = P.saved.find((x) => x.id === it.id);
      if (sv) { Object.assign(sv, { image: it.image, thumb: it.thumb, video: it.video, poster: it.poster, fetchedAt: it.fetchedAt }); saveSoon(); }
    }
  } catch (e) { /* keep old links */ }
  it._refreshing = false;
  it.fetchedAt = it.fetchedAt && now() - it.fetchedAt < 20 * 3600e3 ? it.fetchedAt : now();
  unmount(i);
  if (Math.abs(i - S.active) <= 2) mount(i, i === S.active);
}

/* ======================= active slide + view tracking ======================= */
function watchMs(it) {
  if (it.kind === 'photo') return 4500;
  if (it.kind === 'youtube') return 15000;
  return clamp((it.duration || 10) * 800, 5000, 15000);
}
function endView(i, forward) {
  const it = S.items[i];
  const t0 = S.viewStart;
  S.viewStart = 0;
  if (!it || it.kind === 'notice' || !t0 || S.mode === 'saved' || it._failed) return;
  const dwell = performance.now() - t0;
  if (dwell >= 700) { if (!P.seen[it.id]) P.stats.views++; P.seen[it.id] = now(); }
  const engaged = P.liked[it.id] || isSaved(it.id);
  if (forward && dwell < 1500 && !engaged && !it._skipped && !it._watched) {
    it._skipped = true; P.stats.skips++; learn(it, 'skip');
  } else if (dwell >= watchMs(it) && !it._watched) {
    it._watched = true; learn(it, 'watch');
  }
  saveSoon();
}
function setActive(i) {
  if (i === S.active || i < 0 || i >= S.items.length) return;
  const prev = S.active;
  if (prev >= 0) endView(prev, i > prev);
  S.active = i;
  S.viewStart = performance.now();
  for (const j of [...S.mounted]) if (Math.abs(j - i) > 2) { unmount(j); S.mounted.delete(j); }
  for (const j of [i, i + 1, i - 1, i + 2]) {
    if (j >= 0 && j < S.items.length) { mount(j, j === i); S.mounted.add(j); }
  }
  if (S.items.length - i <= 5) loadMore();
}
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.6) setActive(+e.target.dataset.i);
}, { root: feedEl, threshold: [0.6] });
