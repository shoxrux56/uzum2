/* ═══════════════════════════════════════════════════════════
   app.js  —  GameZone  v5.0
   Shared logic: data fetching, rendering, likes,
   comments, settings, carousel, cross-tab sync.

   ARCHITECTURE:
   • GAMES_DATA (hardcode) — O'CHIRILDI
   • GameStore             — yagona runtime manbai (API'dan)
   • fetchData()           — sahifa yuklanganda API chaqiradi
   • BroadcastChannel      — tab-lar orasida sinxronizatsiya
   • Socket.io             — real-time like/comment sync (YANGI)
═══════════════════════════════════════════════════════════ */
'use strict';

// ── Socket.io — real-time sinxronizatsiya ─────────────────
// Socket.io skripti index.html da yuklangan bo'lishi kerak:
//   <script src="/socket.io/socket.io.js"></script>
const _socket = (typeof io !== 'undefined') ? io() : null;

// ── LocalStorage keys ─────────────────────────────────────
const LS_LIKES    = 'gz_likes';
const LS_COUNTS   = 'gz_counts';
const LS_COMMENTS = 'gz_comments';
const LS_SETTINGS = 'gz_settings';
const LS_CACHE    = 'gz_cache';       // ← yangi: API cache
const CACHE_TTL   =  60_000;          // 60 soniya — shundan keyin background refresh

// ── Placeholder image (DB'da rasm yo'q bo'lganda) ─────────
const PLACEHOLDER_IMG =
  'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=400&q=80';

// Prevent duplicate rapid toggles for the same game id
const PENDING_LIKES = new Set();

// ══════════════════════════════════════════════════════════
//  GameStore — yagona in-memory holat (runtime)
//
//  games      : API'dan normalizatsiya qilingan o'yinlar ro'yxati
//  categories : API'dan kategoriyalar ro'yxati
//  Hardcode   : YO'Q — faqat fetchData() orqali to'ldiriladi
// ══════════════════════════════════════════════════════════
const GameStore = {
  games:      [],
  categories: [],

  /** ID bo'yicha o'yinni topish */
  getById(id) {
    return this.games.find(g => g.id === id) || null;
  },

  /** Barcha o'yinlarni likes bo'yicha kamayish tartibida qaytarish */
  getSorted() {
    return [...this.games]
      .map(g => ({ ...g, likes: State.getLikeCount(g) }))
      .sort((a, b) => b.likes - a.likes);
  },

  /** Foydalanuvchi like bosgan o'yinlar */
  getLiked() {
    const liked = State.likedSet;
    return this.getSorted().filter(g => liked.has(g.id));
  }
};

// ══════════════════════════════════════════════════════════
//  normalizeGame()
//
//  DB o'yin shaklini (API javob) → app ichki shakliga aylantiradi.
//  buildCard() API + eski mock ikkisini ham qabul qiladi.
//
//  DB shakli  : { id, title, category_name, image_url,
//                 game_url, likes, is_featured }
//  App shakli : { ...db, img, genre, players, badge, rating,
//                 comments }
// ══════════════════════════════════════════════════════════
function normalizeGame(g) {
  return {
    ...g,
    // buildCard() kutayotgan maydonlar
    img:      g.image_url  || PLACEHOLDER_IMG,
    genre:    g.category_name || 'Game',
    players:  formatEngagementNumbers(g.likes || 0) + ' players',
    badge:    g.is_featured ? 'top' : null,
    rating:   g.rating || null,          // DB'da yo'q — null ko'rsatilmaydi
    comments: g.comments || [],          // localStorage'dan to'ldiriladi
  };
}

// ══════════════════════════════════════════════════════════
//  fetchData()
//
//  /api/games va /api/categories ni parallel olib keladi,
//  GameStore'ni to'ldiradi, callback chaqiradi.
//
//  Har qanday sahifada ishlatiladi:
//    await fetchData();
//    renderLibrary();   // yoki renderHome(), renderFavorites()
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
//  Stale-While-Revalidate cache
//  1. in-memory bor → 0ms qaytadi + eski bo'lsa background refresh
//  2. localStorage bor → darhol render + background refresh
//  3. hech narsa yo'q → await fetch (faqat birinchi marta)
// ══════════════════════════════════════════════════════════
let _memCache = null;

async function fetchData({ background = false } = {}) {
  // ── in-memory (tab yopilmaguncha eng tez) ─────────────
  if (_memCache && !background) {
    GameStore.games      = _memCache.games;
    GameStore.categories = _memCache.categories;
    if (Date.now() - _memCache.ts > CACHE_TTL)
      fetchData({ background: true }).catch(() => {});
    return true;
  }

  // ── localStorage cache ─────────────────────────────────
  if (!background) {
    try {
      const raw = localStorage.getItem(LS_CACHE);
      if (raw) {
        const s = JSON.parse(raw);
        if (s?.games && s?.categories) {
          GameStore.games      = s.games.map(normalizeGame);
          GameStore.categories = s.categories;
          _memCache = { games: GameStore.games, categories: GameStore.categories, ts: s.ts || 0 };
          fetchData({ background: true }).catch(() => {}); // har doim background refresh
          return true;
        }
      }
    } catch (_) {}
  }

  // ── Haqiqiy API so'rovi ────────────────────────────────
  try {
    const [gR, cR] = await Promise.all([
      fetch('/api/games'),
      fetch('/api/categories')
    ]);
    if (!gR.ok) throw new Error(`Games: ${gR.status}`);
    if (!cR.ok) throw new Error(`Cats: ${cR.status}`);

    const rawGames = await gR.json();
    const rawCats  = await cR.json();

    GameStore.games      = rawGames.map(normalizeGame);
    GameStore.categories = rawCats;
    _memCache = { games: GameStore.games, categories: GameStore.categories, ts: Date.now() };

    try {
      localStorage.setItem(LS_CACHE, JSON.stringify({ games: rawGames, categories: rawCats, ts: Date.now() }));
    } catch (_) {}

    if (background) SyncBus.emit('GAMES_UPDATED');
    return true;
  } catch (err) {
    console.error('[fetchData]', err.message);
    return false;
  }
}

// ── Eski alias — mavjud `getGames()` chaqiruvlari ishlashda davom etadi
function getGames()      { return GameStore.getSorted(); }
function getLikedGames() { return GameStore.getLiked(); }

// ══════════════════════════════════════════════════════════
//  BroadcastChannel — TASK 4: sahifasiz sinxronizatsiya
//
//  Admin panel o'yin/kategoriya qo'shganda/o'chirganda:
//    SyncBus.emit('GAMES_UPDATED')
//  → boshqa barcha ochiq tablar fetchData() qayta chaqiradi
//    va o'z UI'larini yangilaydi.
// ══════════════════════════════════════════════════════════
const SyncBus = (() => {
  // BroadcastChannel hamma brauzerlarda ishlamaydi — xavfsiz fallback
  if (typeof BroadcastChannel === 'undefined') {
    return { emit: () => {}, onUpdate: () => {} };
  }

  const ch = new BroadcastChannel('gz_sync');

  return {
    /** Admin panel ishlatadi: o'zgartirish bo'lgandan keyin chaqir */
    emit(type = 'GAMES_UPDATED') {
      ch.postMessage({ type, ts: Date.now() });
    },

    /**
     * Boshqa tablar uchun:
     * onUpdate(callback) — ma'lumot yangilanganda callback chaqiradi.
     * Callback: async fn — fetchData + render logikasini o'z ichiga oladi.
     */
    onUpdate(callback) {
      ch.onmessage = (e) => {
        if (e.data?.type === 'GAMES_UPDATED') {
          callback();
        }
      };
    }
  };
})();

// ══════════════════════════════════════════════════════════
//  State — localStorage bilan ishlash
// ══════════════════════════════════════════════════════════
const State = {
  get likedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_LIKES) || '[]')); }
    catch { return new Set(); }
  },
  saveLikedSet(set) {
    localStorage.setItem(LS_LIKES, JSON.stringify([...set]));
  },

  get counts() {
    try { return JSON.parse(localStorage.getItem(LS_COUNTS) || '{}'); }
    catch { return {}; }
  },
  saveCounts(obj) { localStorage.setItem(LS_COUNTS, JSON.stringify(obj)); },

  get comments() {
    try { return JSON.parse(localStorage.getItem(LS_COMMENTS) || '{}'); }
    catch { return {}; }
  },
  saveComments(obj) { localStorage.setItem(LS_COMMENTS, JSON.stringify(obj)); },

  getLikeCount(game) {
    // Like bosilgan bo'lsa → base + 1, aks holda → base
    // counts[] ni ishlatmaymiz — u har safar qayta hisoblanadi
    const isLiked = this.likedSet.has(game.id);
    return (game.likes || 0) + (isLiked ? 1 : 0);
  },
  getComments(game) {
    const all = this.comments;
    // localStorage'da bor bo'lsa → uni qaytaradi
    // bo'lmasa → normalizeGame() qo'ygan bo'sh massiv
    return all[game.id] !== undefined ? all[game.id] : [...(game.comments || [])];
  }
};

// ══════════════════════════════════════════════════════════
//  Utility
// ══════════════════════════════════════════════════════════
/**
 * formatEngagementNumbers(n)
 *   0–999       → "60"
 *   1k–999k     → "6.5k"
 *   1m+         → "1.2m"
 */
function formatEngagementNumbers(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'm';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
const fmtLikes = formatEngagementNumbers;  // mavjud chaqiruvlar uchun alias

// ══════════════════════════════════════════════════════════
//  Card rendering
// ══════════════════════════════════════════════════════════
function badgeHTML(badge) {
  if (!badge) return '';
  const map = { hot: '🔥 Hot', new: 'New', top: '★ Top' };
  return `<span class="gz-card__badge gz-card__badge--${badge}">${map[badge] || badge}</span>`;
}

function heartSVG(filled) {
  return filled
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="#FF3B57" stroke="#FF3B57" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
}

/**
 * buildCard(game)
 * game = normalizeGame() o'tkazilgan ob'ekt.
 * DB va mock ikkisini ham qabul qiladi.
 */
function buildCard(game) {
  const liked  = State.likedSet.has(game.id);
  const cCount = State.getComments(game).length;

  const div = document.createElement('div');
  div.className  = 'gz-card';
  div.dataset.id = game.id;
  // URL mavjud bo'lsa pointer, bo'lmasa default cursor
  div.style.cursor = (game.game_url && game.game_url !== '#') ? 'pointer' : 'default';

  div.innerHTML = `
    <div class="gz-card__img-wrap">
      <img class="gz-card__img" src="${game.img || PLACEHOLDER_IMG}"
           loading="lazy" decoding="async"
           alt="${game.title}" loading="lazy"
           onerror="this.src='${PLACEHOLDER_IMG}'" />
      ${badgeHTML(game.badge)}
      ${game.rating ? `
      <span class="gz-card__rating">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="#FFB800">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
        ${game.rating}
      </span>` : ''}
    </div>
    <div class="gz-card__body">
      <!-- meta (genre / players) removed per user request -->
      <p class="gz-card__title">${game.title}</p>
      <div class="gz-card__footer">
        <button class="gz-like-btn ${liked ? 'liked' : ''}"
                data-action="like" data-id="${game.id}" aria-label="Like">
          ${heartSVG(liked)}
          <span class="like-count">${formatEngagementNumbers(State.getLikeCount(game))}</span>
        </button>
        <button class="gz-comment-btn"
                data-action="comment" data-id="${game.id}" aria-label="Comments">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          ${formatEngagementNumbers(cCount)}
        </button>
      </div>
    </div>
  `;

  div.querySelector('[data-action="like"]').addEventListener('click', e => {
    e.stopPropagation();
    toggleLike(game.id, div);
  });

  // Izoh tugmasi → modal ochadi
  div.querySelector('[data-action="comment"]').addEventListener('click', e => {
    e.stopPropagation();
    openModal(game.id);
  });

  // Karta bosilsa → o'yin iframe'da ochiladi
  div.addEventListener('click', () => {
    const url = game.game_url && game.game_url !== '#' ? game.game_url : null;
    if (url) openGamePlayer(url, game.title);
  });

  return div;
}

// ══════════════════════════════════════════════════════════
//  Like toggle
//  Ishlash prinsipi:
//    liked = false  →  count = game.likes + 1  (bazaviy + 1)
//    liked = true   →  count = game.likes + 0  (bazaviy, qaytariladi)
//
//  `current` ni counts[] dan EMAS, game.likes (original DB qiymati)
//  dan hisoblash muhim — aks holda har bosishda ortib ketadi.
// ══════════════════════════════════════════════════════════
function toggleLike(id, cardEl) {
  if (PENDING_LIKES.has(id)) return;
  PENDING_LIKES.add(id);

  const game   = GameStore.getById(id);
  if (!game) { PENDING_LIKES.delete(id); return; }

  const liked      = State.likedSet;
  const isNowLiked = !liked.has(id);
  const action     = isNowLiked ? 'add' : 'remove';

  // UI ni zudlik bilan yangilaymiz (optimistic update)
  if (isNowLiked) { liked.add(id); } else { liked.delete(id); }
  State.saveLikedSet(liked);

  const optimisticCount = (game.likes || 0) + (isNowLiked ? 1 : 0);
  _updateLikeUI(id, isNowLiked, optimisticCount);
  showToast(isNowLiked ? '❤️ Added to Favourites' : '💔 Removed from Favourites');

  // Serverga yuboramiz — real sonni olamiz
  fetch(`/api/games/${id}/like`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action })
  })
    .then(r => r.json())
    .then(data => {
      if (data.likes !== undefined) {
        // DB dagi haqiqiy sonni game.likes ga yozamiz
        game.likes = data.likes;
        // liked holat saqlanadi, UI ni DB qiymati bilan sinxronlaymiz
        _updateLikeUI(id, isNowLiked, data.likes + (isNowLiked ? 0 : 0));
      }
    })
    .catch(() => {
      // Xato bo'lsa — optimistic update ni orqaga qaytaramiz
      if (isNowLiked) { liked.delete(id); } else { liked.add(id); }
      State.saveLikedSet(liked);
      _updateLikeUI(id, !isNowLiked, game.likes || 0);
      showToast('❌ Xatolik yuz berdi');
    })
    .finally(() => {
      if (typeof renderFavorites === 'function') renderFavorites();
      setTimeout(() => PENDING_LIKES.delete(id), 420);
    });
}

/** Like UI ni yangilash — ichki yordamchi */
function _updateLikeUI(id, isLiked, count) {
  document.querySelectorAll(`.gz-card[data-id="${id}"]`).forEach(cardEl => {
    const btn = cardEl.querySelector('[data-action="like"]');
    if (!btn) return;
    btn.innerHTML = `${heartSVG(isLiked)}<span class="like-count">${formatEngagementNumbers(count)}</span>`;
    btn.classList.toggle('liked', isLiked);
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.classList.add('heart-pop');
      svg.addEventListener('animationend', () => svg.classList.remove('heart-pop'), { once: true });
    }
  });
}

// ══════════════════════════════════════════════════════════
//  Modal / Comments — GameStore'dan o'qiydi
// ══════════════════════════════════════════════════════════
let modalGameId = null;

function openModal(id) {
  modalGameId = id;

  // ← GAMES_DATA.find() o'rniga GameStore.getById()
  const game = GameStore.getById(id);
  if (!game) return;

  const overlay = document.getElementById('gz-overlay');
  overlay.querySelector('.gz-modal__thumb').src      = game.img || PLACEHOLDER_IMG;
  overlay.querySelector('.gz-modal__info h3').textContent = game.title;
  overlay.querySelector('.gz-modal__info p').textContent  =
    `${game.genre}${game.game_url && game.game_url !== '#' ? ' · ' + game.game_url : ''}`;

  renderModalComments(id);
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => overlay.querySelector('.gz-modal__input')?.focus(), 350);
}

function closeModal() {
  const overlay = document.getElementById('gz-overlay');
  overlay.classList.remove('open');
  document.body.style.overflow = '';
  modalGameId = null;
}

function renderModalComments(id) {
  const list = document.getElementById('gz-comments-list');
  list.innerHTML = '<p class="gz-modal__empty">Yuklanmoqda…</p>';

  fetch(`/api/games/${id}/comments`)
    .then(r => r.json())
    .then(comments => {
      list.innerHTML = '';
      if (!comments.length) {
        list.innerHTML = `<p class="gz-modal__empty">No comments yet. Be the first! 🎮</p>`;
        return;
      }
      comments.forEach(c => {
        const el = document.createElement('div');
        el.className = 'gz-comment';
        el.innerHTML = `
          <div class="gz-comment__avatar" style="background:${c.color || '#FF3B57'}">${(c.user_name || 'U').charAt(0)}</div>
          <div class="gz-comment__body">
            <p class="gz-comment__name">${c.user_name || 'You'}</p>
            <p class="gz-comment__text">${c.text}</p>
            <p class="gz-comment__time">${_relativeTime(c.created_at)}</p>
          </div>
        `;
        list.appendChild(el);
      });
      list.scrollTop = list.scrollHeight;
    })
    .catch(() => {
      list.innerHTML = `<p class="gz-modal__empty">Kommentlarni yuklashda xatolik ❌</p>`;
    });
}

/** Unix timestamp → "just now / 2 min ago / ..." */
function _relativeTime(ts) {
  if (!ts) return 'just now';
  const sec = Math.floor(Date.now() / 1000 - Number(ts));
  if (sec < 60)  return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hr ago`;
  return `${Math.floor(sec / 86400)} day(s) ago`;
}

function submitComment() {
  const input = document.getElementById('gz-comment-input');
  const text  = input.value.trim();
  if (!text || modalGameId === null) return;

  const btn = document.getElementById('gz-send-btn');
  if (btn) btn.disabled = true;

  fetch(`/api/games/${modalGameId}/comments`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text, user: 'You' })
  })
    .then(r => r.json())
    .then(data => {
      if (data.comment) {
        input.value = '';
        // Modal ochiq bo'lsa yangilanadi (socket ham keladi, lekin tezlik uchun)
        if (modalGameId !== null) renderModalComments(modalGameId);
        // Kartalardagi son yangilanadi
        _updateCommentCountUI(modalGameId, data.count);
        showToast('💬 Comment added!');
      } else {
        showToast('❌ ' + (data.error || 'Xatolik'));
      }
    })
    .catch(() => showToast('❌ Server bilan bog\'lanib bo\'lmadi'))
    .finally(() => { if (btn) btn.disabled = false; });
}

/** Karta(lar)dagi komment sonini yangilash */
function _updateCommentCountUI(gameId, count) {
  document.querySelectorAll(`.gz-card[data-id="${gameId}"]`).forEach(card => {
    const cBtn = card.querySelector('[data-action="comment"]');
    if (cBtn) cBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>${formatEngagementNumbers(count)}`;
  });
}

// ══════════════════════════════════════════════════════════
//  Toast
// ══════════════════════════════════════════════════════════
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('gz-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ══════════════════════════════════════════════════════════
//  Settings (localStorage)
// ══════════════════════════════════════════════════════════
function onBellClick() {
  const on = Settings.get('notifications') !== false;
  showToast(on ? '🔔 Bildirishnomalar yoqiq' : "🔕 Bildirishnomalar o'chiq");
}

const Settings = {
  all()        { try { return JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch { return {}; } },
  get(key)     { const d = { darkMode: false, notifications: true, language: 'en' }; const s = this.all(); return key in s ? s[key] : d[key]; },
  set(key, v)  { const s = this.all(); s[key] = v; localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }
};

function applyDarkMode(enabled) { document.documentElement.classList.toggle('dark', enabled); }
function applyLanguage(lang)    { document.documentElement.setAttribute('lang', lang); }

;(function applyStoredSettings() {
  applyDarkMode(Settings.get('darkMode'));
  applyLanguage(Settings.get('language'));
}());

// ══════════════════════════════════════════════════════════
//  FEATURED CAROUSEL — /api/featured dan olib keladi
// ══════════════════════════════════════════════════════════
const Carousel = {
  index: 0, items: [], timer: null, DELAY: 4500,

  async init() {
    const wrap = document.getElementById('gz-carousel');
    if (!wrap) return;
    try {
      const res   = await fetch('/api/featured');
      const games = res.ok ? await res.json() : [];
      if (!games.length) {
        wrap.style.display = 'none';
        const fb = document.getElementById('gz-carousel-fallback');
        if (fb) fb.style.display = '';
        return;
      }
      this.items = games;
      this._render(wrap);
      this._bindTouch(wrap);
      this._startAuto();
      wrap.addEventListener('mouseenter', () => this._stopAuto());
      wrap.addEventListener('mouseleave', () => this._startAuto());
    } catch {
      wrap.style.display = 'none';
      const fb = document.getElementById('gz-carousel-fallback');
      if (fb) fb.style.display = '';
    }
  },

  _render(wrap) {
    const track = wrap.querySelector('.gz-carousel__track');
    const dots  = wrap.querySelector('.gz-carousel__dots');
    if (!track || !dots) return;
    track.innerHTML = '';
    dots.innerHTML  = '';
    this.items.forEach((g, i) => {
      const slide = document.createElement('div');
      slide.className = 'gz-carousel__slide';
      slide.innerHTML = `
        <img src="${g.image_url || PLACEHOLDER_IMG}" alt="${g.title}" loading="lazy" />
        <div class="gz-carousel__overlay"></div>
        <div class="gz-carousel__info">
          <span class="gz-carousel__tag">⚡ Muharrir Tanlovi</span>
          <h3 class="gz-carousel__title">${g.title}</h3>
          <button class="gz-carousel__play" onclick="openGamePlayer('${g.game_url}','${g.title.replace(/'/g,"\\'")}')">▶ Hozir o'yna</button>
        </div>`;
      track.appendChild(slide);
      const dot = document.createElement('button');
      dot.className = 'gz-carousel__dot' + (i === 0 ? ' active' : '');
      dot.setAttribute('aria-label', `Slide ${i + 1}`);
      dot.addEventListener('click', () => this._goTo(i));
      dots.appendChild(dot);
    });
    this._goTo(0);
    const prev = wrap.querySelector('.gz-carousel__prev');
    const next = wrap.querySelector('.gz-carousel__next');
    if (prev) prev.addEventListener('click', () => this._goTo(this.index - 1));
    if (next) next.addEventListener('click', () => this._goTo(this.index + 1));
    if (this.items.length === 1) { if (prev) prev.style.display = 'none'; if (next) next.style.display = 'none'; }
  },

  _goTo(i) {
    const wrap  = document.getElementById('gz-carousel');
    if (!wrap) return;
    const track = wrap.querySelector('.gz-carousel__track');
    const dots  = wrap.querySelectorAll('.gz-carousel__dot');
    const len   = this.items.length;
    this.index  = ((i % len) + len) % len;
    track.style.transform = `translateX(-${this.index * 100}%)`;
    dots.forEach((d, idx) => d.classList.toggle('active', idx === this.index));
  },

  _startAuto() { this._stopAuto(); if (this.items.length > 1) this.timer = setInterval(() => this._goTo(this.index + 1), this.DELAY); },
  _stopAuto()  { clearInterval(this.timer); },

  _bindTouch(wrap) {
    let startX = 0;
    wrap.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
    wrap.addEventListener('touchend',   e => {
      const diff = startX - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 40) this._goTo(diff > 0 ? this.index + 1 : this.index - 1);
    });
  }
};

// ══════════════════════════════════════════════════════════
//  TASK 4 — Reset funksiyalari
// ══════════════════════════════════════════════════════════

/**
 * resetProfileData()
 * Faqat avatar serverdan o'chiradi + localStorage tozalaydi.
 * games_catalog va categories jadvallariga tegmaydi.
 */
async function resetProfileData() {
  if (!confirm(
    'Reset profile?\n\n' +
    'This will remove your profile picture and reset your display name to the default.\n' +
    'Your likes, comments and other local data will NOT be cleared.'
  )) return false;

  try {
    // Remove avatar image on server (if endpoint exists)
    const delRes = await fetch('/api/profile/image', { method: 'DELETE' });
    const delData = await delRes.json().catch(() => ({}));
    if (!delRes.ok) {
      // Non-fatal: continue to try resetting name but inform user
      showToast('⚠️ Avatar remove failed: ' + (delData.error || delRes.status));
    }

    // Reset name on server (POST with name only). If endpoint not available, ignore error.
    try {
      const form = new FormData();
      form.append('name', 'GameZone User');
      const postRes = await fetch('/api/profile', { method: 'POST', body: form });
      const postData = await postRes.json().catch(() => ({}));
      if (!postRes.ok) throw new Error(postData.error || postRes.status);
    } catch (e) {
      // Non-fatal: still update UI locally
      console.warn('[resetProfileData] name reset failed', e.message);
    }

    // Update UI if present
    try {
      const nameEl = document.getElementById('profileName');
      if (nameEl) nameEl.textContent = 'GameZone User';
      // Update avatar UI (client-side) if helper exists
      if (typeof setAvatar === 'function') setAvatar(null, 'GameZone User');
    } catch (e) { /* ignore DOM errors */ }

    showToast('✅ Profile picture and name reset');
    return true;
  } catch (e) {
    showToast('❌ Could not reset profile: ' + e.message);
    return false;
  }
}

/**
 * clearGameData()
 * Faqat o'yin interaksiya kalitlarini o'chiradi.
 * Settings (dark mode, language) saqlanib qoladi.
 * Hech qanday API chaqirmaydi — bazaga tegmaydi.
 */
function clearGameData() {
  if (!confirm(
    'Reset your likes and comments?\n\n' +
    'Your profile, settings, and all database records\n' +
    'will NOT be affected.'
  )) return false;

  localStorage.removeItem(LS_LIKES);
  localStorage.removeItem(LS_COUNTS);
  localStorage.removeItem(LS_COMMENTS);
  localStorage.removeItem(LS_CACHE);
  _memCache = null;
  showToast('🗑️ Likes and comments cleared.');
  return true;
}

// ══════════════════════════════════════════════════════════
//  Nav, Modal injection, Init
// ══════════════════════════════════════════════════════════
function setActiveNav() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.gz-nav__item').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === page);

    // Hover qilinganda keyingi sahifani oldindan yuklaymiz (prefetch)
    a.addEventListener('mouseenter', () => {
      const href = a.getAttribute('href');
      if (href && href !== page && !document.querySelector(`link[rel="prefetch"][href="${href}"]`)) {
        const lnk = document.createElement('link');
        lnk.rel  = 'prefetch';
        lnk.href = href;
        document.head.appendChild(lnk);
      }
    }, { once: true });
  });
}

// ══════════════════════════════════════════════════════════
//  Game Player  —  o'yinni sayt ichida iframe'da ochadi
// ══════════════════════════════════════════════════════════
function injectGamePlayer() {
  if (document.getElementById('gz-player-overlay')) return;
  const el = document.createElement('div');
  el.id = 'gz-player-overlay';
  el.innerHTML = `
    <div class="gz-player">
      <div class="gz-player__bar">
        <span class="gz-player__title" id="gz-player-title"></span>
        <div class="gz-player__actions">
          <button class="gz-player__fs" id="gz-player-fs" title="To'liq ekran">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
          </button>
          <button class="gz-player__close" id="gz-player-close" title="Yopish">✕</button>
        </div>
      </div>

      <!-- Iframe blok xabar (default yashirin) -->
      <div class="gz-player__blocked" id="gz-player-blocked" style="display:none">
        <div class="gz-player__blocked-icon">🚫</div>
        <p class="gz-player__blocked-title">O'yin bu yerda ochilmaydi</p>
        <p class="gz-player__blocked-desc">Bu sayt iframe ichida ko'rsatishni taqiqlagan.<br>Yangi tabda ochib o'ynashingiz mumkin.</p>
        <button class="gz-player__blocked-btn" id="gz-player-newtab">
          ↗ Yangi tabda ochish
        </button>
      </div>

      <iframe id="gz-player-frame" src="" allowfullscreen
        allow="fullscreen; autoplay; gamepad; pointer-lock; screen-wake-lock"></iframe>
    </div>
  `;
  document.body.appendChild(el);

  document.getElementById('gz-player-close').addEventListener('click', closeGamePlayer);
  el.addEventListener('click', e => { if (e.target === el) closeGamePlayer(); });

  // To'liq ekran tugmasi
  document.getElementById('gz-player-fs').addEventListener('click', () => {
    const frame = document.getElementById('gz-player-frame');
    if (frame.requestFullscreen)            frame.requestFullscreen();
    else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
  });

  // ESC bilan yopish
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeGamePlayer();
  });

  // Iframe yuklanganda X-Frame-Options tekshiramiz
  // (blocked bo'lsa about:blank yoki xato keladi)
  const frame = document.getElementById('gz-player-frame');
  let _checkTimer = null;

  frame.addEventListener('load', () => {
    clearTimeout(_checkTimer);
    // Agar src bo'sh bo'lsa — tekshirma
    if (!frame.src || frame.src === window.location.href) return;
    try {
      // Agar cross-origin blok bo'lsa — contentDocument null yoki xato beradi
      const doc = frame.contentDocument;
      // doc null bo'lsa — BLOK (same-origin policy)
      if (!doc || !doc.body) {
        _showBlocked();
      } else if (doc.body.innerHTML.trim() === '') {
        _showBlocked();
      }
    } catch (e) {
      // SecurityError — cross-origin, lekin yuklangan (OK)
      // Hech narsa qilmaymiz
    }
  });

  // 6 soniyadan keyin hali ham bo'sh bo'lsa — blok deb hisoblaymiz
  frame._startCheck = (url) => {
    clearTimeout(_checkTimer);
    _checkTimer = setTimeout(() => {
      try {
        const doc = frame.contentDocument;
        if (!doc || doc.body.innerHTML.trim() === '') _showBlocked();
      } catch (_) { /* cross-origin OK */ }
    }, 6000);
  };

  function _showBlocked() {
    frame.style.display = 'none';
    document.getElementById('gz-player-blocked').style.display = 'flex';
    document.getElementById('gz-player-fs').style.display = 'none';
  }
}

function openGamePlayer(url, title) {
  if (!url || url === '#') return;
  injectGamePlayer();
  const frame   = document.getElementById('gz-player-frame');
  const blocked = document.getElementById('gz-player-blocked');
  const fsBtn   = document.getElementById('gz-player-fs');

  // Reset
  frame.style.display   = '';
  blocked.style.display = 'none';
  fsBtn.style.display   = '';

  document.getElementById('gz-player-title').textContent = title || '';
  frame.src = url;
  if (frame._startCheck) frame._startCheck(url);

  // "Yangi tabda" tugmasi URL ni biladi
  document.getElementById('gz-player-newtab').onclick = () => {
    window.open(url, '_blank', 'noopener,noreferrer');
    closeGamePlayer();
  };

  document.getElementById('gz-player-overlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeGamePlayer() {
  const ov = document.getElementById('gz-player-overlay');
  if (!ov) return;
  ov.classList.remove('active');
  document.getElementById('gz-player-frame').src = '';
  document.body.style.overflow = '';
}

function injectModal() {
  if (document.getElementById('gz-overlay')) return;
  const el = document.createElement('div');
  el.id = 'gz-overlay';
  el.className = 'gz-overlay';
  el.innerHTML = `
    <div class="gz-modal" role="dialog" aria-modal="true">
      <div class="gz-modal__drag"></div>
      <div class="gz-modal__head">
        <img class="gz-modal__thumb" src="" alt="" />
        <div class="gz-modal__info"><h3></h3><p></p></div>
        <button class="gz-modal__close" id="gz-modal-close" aria-label="Close">✕</button>
      </div>
      <div class="gz-modal__body" id="gz-comments-list"></div>
      <div class="gz-modal__footer">
        <input id="gz-comment-input" class="gz-modal__input"
               type="text" placeholder="Add a comment…" maxlength="200" />
        <button class="gz-modal__send" id="gz-send-btn" aria-label="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) closeModal(); });
  document.getElementById('gz-modal-close').addEventListener('click', closeModal);
  document.getElementById('gz-send-btn').addEventListener('click', submitComment);
  document.getElementById('gz-comment-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitComment();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

function injectToast() {
  if (document.getElementById('gz-toast')) return;
  const t = document.createElement('div');
  t.id = 'gz-toast'; t.className = 'gz-toast';
  document.body.appendChild(t);
}

document.addEventListener('DOMContentLoaded', () => {
  injectModal();
  injectToast();
  setActiveNav();
  document.querySelectorAll('[data-action="bell"]').forEach(b =>
    b.addEventListener('click', onBellClick));

  // ── Socket.io — real-time yangilanishlar ──────────────
  if (_socket) {
    // Boshqa foydalanuvchi layk bosdi → UI yangilanadi
    _socket.on('like-updated', ({ game_id, likes }) => {
      const game = GameStore.getById(game_id);
      if (!game) return;
      game.likes = likes;  // GameStore ni yangilaymiz
      const isLiked = State.likedSet.has(game_id);
      const display = likes + (isLiked ? 0 : 0); // server haqiqiy son
      _updateLikeUI(game_id, isLiked, likes);
    });

    // Boshqa foydalanuvchi komment yozdi → modal yangilanadi + son oshadi
    _socket.on('new-comment', ({ game_id, comment }) => {
      // Agar modal shu o'yin uchun ochiq bo'lsa — ro'yxatni yangilaymiz
      if (modalGameId === game_id) {
        renderModalComments(game_id);
      }
      // Karta sonini yangilash uchun serverdan haqiqiy sonni olamiz
      fetch(`/api/games/${game_id}/comments`)
        .then(r => r.json())
        .then(comments => _updateCommentCountUI(game_id, comments.length))
        .catch(() => {});
    });

    console.log('[WS] ✅ Socket.io ulandi');
  } else {
    console.warn('[WS] ⚠️ Socket.io topilmadi — index.html ga <script src="/socket.io/socket.io.js"> qo\'shing');
  }
});
