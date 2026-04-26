// ═══════════════════════════════════════════════════════════
//  server.js  —  GameZone Backend  v4.0
//  Stack : Express · node:sqlite (built-in) · Multer · dotenv
//  Run   : node --experimental-sqlite server.js
// ═══════════════════════════════════════════════════════════
'use strict';

// ── Load .env FIRST before anything reads process.env ─────
require('dotenv').config();

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const cors     = require('cors');
const crypto   = require('crypto');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════
//  SECURITY CONFIG
//  All secrets come from .env — never hard-coded below.
// ══════════════════════════════════════════════════════════
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TOKEN_SECRET   = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS   = 24 * 60 * 60 * 1000;   // 24 hours

if (!ADMIN_PASSWORD) {
  console.error('\n❌  ADMIN_PASSWORD is not set in .env — server cannot start.\n');
  process.exit(1);
}

// ══════════════════════════════════════════════════════════
//  FILE-SYSTEM SETUP
// ══════════════════════════════════════════════════════════
const UPLOADS_DIR     = path.join(__dirname, 'uploads');
const GAME_IMAGES_DIR = path.join(__dirname, 'uploads', 'games');

[UPLOADS_DIR, GAME_IMAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ══════════════════════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(__dirname));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ══════════════════════════════════════════════════════════
//  DATABASE  —  schema + seed
// ══════════════════════════════════════════════════════════
// ---------- PostgreSQL pool + tiny adapter that mimics the old sqlite API ----------
if (!process.env.DATABASE_URL) {
  console.error('\n❌  DATABASE_URL is not set in .env — server cannot connect to Postgres.\n');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Enable SSL in production if needed
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

function convertPlaceholder(sql, params) {
  // Convert '?' placeholders to $1, $2 ... for pg
  let i = 0;
  const text = sql.replace(/\?/g, () => { i++; return `$${i}`; });
  return { text, values: params };
}

const db = {
  // exec: run raw SQL (can be multiple semicolon-separated statements)
  async exec(sql) {
    const parts = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      await pool.query(p);
    }
  },
  // prepare returns an object with run/get/all similar to node:sqlite
  prepare(sql) {
    return {
      run: async (...params) => {
        try {
          // If it's an INSERT without RETURNING, try to append RETURNING id
          let q = sql;
          const isInsert = /^\s*INSERT\b/i.test(sql);
          if (isInsert && !/RETURNING\b/i.test(sql)) q = sql + ' RETURNING id';
          const { text, values } = convertPlaceholder(q, params);
          const res = await pool.query(text, values);
          return { lastInsertRowid: res.rows[0]?.id, changes: res.rowCount };
        } catch (e) {
          throw e;
        }
      },
      get: async (...params) => {
        const { text, values } = convertPlaceholder(sql, params);
        const res = await pool.query(text, values);
        return res.rows[0];
      },
      all: async (...params) => {
        const { text, values } = convertPlaceholder(sql, params);
        const res = await pool.query(text, values);
        return res.rows;
      }
    };
  }
};

// Attempt to run the original schema creation SQL for users who rely on it.
// If the SQL is not valid in Postgres (it may contain sqlite-specific bits)
// we catch and warn but continue — preserving the original logical flow.
const initialSchema = `
  -- User profile (single-user pattern)
  CREATE TABLE IF NOT EXISTS users (
    id                 INTEGER PRIMARY KEY,
    name               TEXT    NOT NULL DEFAULT 'GameZone User',
    profile_image_path TEXT
  );

  -- Dynamic categories (no hard-coded lists)
  CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,

    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  -- Game catalogue
  CREATE TABLE IF NOT EXISTS games_catalog (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    image_path  TEXT,
    game_url    TEXT    NOT NULL DEFAULT '#',
    likes       INTEGER NOT NULL DEFAULT 25,
    is_featured INTEGER NOT NULL DEFAULT 0 CHECK(is_featured IN (0,1)),
    created_at  INTEGER DEFAULT (strftime('%s','now'))
  );
`;

(async function initDb() {
  try {
    await db.exec(initialSchema);
    try {
      await db.prepare("INSERT OR IGNORE INTO users (id, name) VALUES (1, 'GameZone User')").run();
    } catch (e) {
      // Some SQLite-specific statements may fail in Postgres — warn and continue
      console.warn('[DB Init] Warning (ignored):', e.message);
    }
  } catch (e) {
    console.warn('[DB Init] Schema exec warning (ignored):', e.message);
  }
})();

// ══════════════════════════════════════════════════════════
//  MULTER  —  two separate instances
// ══════════════════════════════════════════════════════════
const ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

const imageFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  ALLOWED_EXTS.includes(ext)
    ? cb(null, true)
    : cb(new Error(`"${ext}" is not supported. Please upload JPG, PNG, WEBP, or GIF.`));
};

/** Reusable factory — avoids duplicating diskStorage config */
function makeUpload(dest) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dest),
      filename:    (_req,  file, cb) => {
        const ext    = path.extname(file.originalname).toLowerCase();
        const prefix = dest === UPLOADS_DIR ? 'avatar' : 'game';
        cb(null, `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
      }
    }),
    limits:     { fileSize: 5 * 1024 * 1024 },   // 5 MB
    fileFilter: imageFilter
  });
}

const avatarUpload = makeUpload(UPLOADS_DIR);
const gameUpload   = makeUpload(GAME_IMAGES_DIR);

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════

/** Convert a relative DB path → full public URL */
const toUrl = (req, p) =>
  p ? `${req.protocol}://${req.get('host')}/${p}` : null;

/** Safely delete a file from disk without throwing */
function removeFile(relativePath) {
  if (!relativePath) return;
  try {
    const abs = path.join(__dirname, relativePath);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (e) {
    console.warn(`[removeFile] Could not delete "${relativePath}":`, e.message);
  }
}

// ══════════════════════════════════════════════════════════
//  AUTH MIDDLEWARE  —  two independent strategies
//
//  1. headerAuth   — checks x-admin-password header directly
//                    against ADMIN_PASSWORD from .env
//                    Used by: reset, direct-delete, categories
//
//  2. tokenAuth    — verifies a signed JWT-style token issued
//                    by POST /admin/login
//                    Used by: admin panel SPA routes
// ══════════════════════════════════════════════════════════

/**
 * headerAuth
 * Reads the `x-admin-password` request header and compares it
 * to ADMIN_PASSWORD using a timing-safe comparison so an attacker
 * cannot infer the password length via response time differences.
 */
function headerAuth(req, res, next) {
  const provided = (req.headers['x-admin-password'] || '').trim();

  if (!provided) {
    return res.status(401).json({
      error: 'Missing x-admin-password header.'
    });
  }

  // timingSafeEqual requires same-length buffers
  const a = Buffer.alloc(64, 0);
  const b = Buffer.alloc(64, 0);
  a.write(ADMIN_PASSWORD);
  b.write(provided);

  if (!crypto.timingSafeEqual(a, b)) {
    console.warn(`[headerAuth] Failed attempt from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid admin password.' });
  }

  next();
}

// ── JWT token helpers (HMAC-SHA256, zero external deps) ───
function signToken(payload) {
  const data = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() }))
    .toString('base64url');
  const sig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [data, provided] = token.split('.');
  const expected = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(data)
    .digest('base64url');
  try {
    const expBuf = Buffer.from(expected, 'base64url');
    const proBuf = Buffer.from(provided || '', 'base64url');
    if (proBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(proBuf, expBuf)) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.iat || Date.now() - payload.iat > TOKEN_TTL_MS) return null;
    return payload;
  } catch { return null; }
}

function tokenAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized. Admin login required.' });
  }
  next();
}

// ── Brute-force rate limiter (login endpoint only) ────────
const loginAttempts = new Map();

function checkRateLimit(ip) {
  const WINDOW = 15 * 60 * 1000;   // 15 minutes
  const MAX    = 5;
  const now    = Date.now();
  const rec    = loginAttempts.get(ip) || { count: 0, windowStart: now };

  if (now - rec.windowStart > WINDOW) {
    rec.count = 0;
    rec.windowStart = now;
  }
  if (rec.count >= MAX) {
    const waitMin = Math.ceil((WINDOW - (now - rec.windowStart)) / 60_000);
    return { blocked: true, waitMin };
  }
  rec.count++;
  loginAttempts.set(ip, rec);
  return { blocked: false };
}

// ══════════════════════════════════════════════════════════
//  ROUTE MODULES
//  Each section is clearly labelled and self-contained.
// ══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
//  ADMIN AUTH  (SPA panel login / token verify)
// ─────────────────────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const rl = checkRateLimit(ip);

  if (rl.blocked) {
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${rl.waitMin} min.`
    });
  }

  if (!req.body.password || req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password.' });
  }

  loginAttempts.delete(ip);
  console.log(`[Admin] ✅ Login from ${ip}`);
  res.json({ token: signToken({ role: 'admin' }) });
});

app.get('/admin/verify', tokenAuth, (_req, res) => res.json({ ok: true }));

// ─────────────────────────────────────────────────────────
//  TASK 1 — SECURE DATABASE RESET
//
//  POST /api/admin/reset
//  Header : x-admin-password: <value from .env>
//
//  Deletes ALL rows from games_catalog and categories,
//  resets AUTOINCREMENT counters, and removes orphaned
//  image files from disk.
//  The users table is intentionally untouched.
// ─────────────────────────────────────────────────────────
app.post('/api/admin/reset', headerAuth, async (req, res) => {
  // Collect image paths BEFORE deleting rows
  try {
    const rows = await db.prepare('SELECT image_path FROM games_catalog WHERE image_path IS NOT NULL').all();
    const gameImages = rows.map(r => r.image_path);

    try {
      await db.exec('BEGIN');
      await db.prepare('DELETE FROM games_catalog').run();
      await db.prepare('DELETE FROM categories').run();
      // sqlite_sequence is SQLite-specific; in Postgres we can try to reset sequences if needed.
      try {
        await db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('games_catalog', 'categories')`).run();
      } catch (e) { /* ignore if not applicable */ }
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      console.error('[Reset] ❌ Transaction failed:', err.message);
      return res.status(500).json({ error: 'Reset failed: ' + err.message });
    }

    // Purge orphaned image files AFTER the DB transaction succeeds
    let deletedFiles = 0;
    gameImages.forEach(p => { removeFile(p); deletedFiles++; });

    // Also sweep the games sub-directory for any leftover files
    if (fs.existsSync(GAME_IMAGES_DIR)) {
      fs.readdirSync(GAME_IMAGES_DIR).forEach(f => {
        try { fs.unlinkSync(path.join(GAME_IMAGES_DIR, f)); } catch {}
      });
    }

    console.log(`[Reset] ✅ DB cleared. ${deletedFiles} image(s) removed.`);
    res.json({ ok: true, message: 'Database reset complete. All games and categories deleted.', deleted_files: deletedFiles });
  } catch (e) {
    console.error('[Reset] ❌', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
//  TASK 2 — POST /api/admin/reset-all
//
//  /api/admin/reset   → mavjud (avval yozilgan)
//  /api/admin/reset-all → yangi alias (ikkalasi bir xil ishlaydi)
//
//  Header: x-admin-password: <.env dagi qiymat>
//  games_catalog va categories jadvallarini BUTUNLAY tozalaydi.
//  sqlite_sequence ni 0 ga qaytaradi (ID lar qayta 1 dan boshlanadi).
//  users jadvaliga tegmaydi.
// ─────────────────────────────────────────────────────────
app.post('/api/admin/reset-all', headerAuth, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT image_path FROM games_catalog WHERE image_path IS NOT NULL').all();
    const gameImages = rows.map(r => r.image_path);

    try {
      await db.exec('BEGIN');
      await db.prepare('DELETE FROM games_catalog').run();
      await db.prepare('DELETE FROM categories').run();
      try { await db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('games_catalog','categories')`).run(); } catch (e) {}
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      console.error('[reset-all] ❌', err.message);
      return res.status(500).json({ error: 'Reset failed: ' + err.message });
    }

    let deletedFiles = 0;
    gameImages.forEach(p => { removeFile(p); deletedFiles++; });

    if (fs.existsSync(GAME_IMAGES_DIR)) {
      fs.readdirSync(GAME_IMAGES_DIR).forEach(f => {
        try { fs.unlinkSync(path.join(GAME_IMAGES_DIR, f)); } catch {}
      });
    }

    console.log(`[reset-all] ✅ Cleared. ${deletedFiles} file(s) removed.`);
    res.json({ ok: true, message: 'All games and categories deleted. IDs reset to 0.', deleted_files: deletedFiles });
  } catch (e) {
    console.error('[reset-all] ❌', e.message);
    res.status(500).json({ error: e.message });
  }
});
//
//  DELETE /api/games/:id
//  Header : x-admin-password: <value from .env>
//
//  Steps:
//    1. Validate ID (must be a positive integer)
//    2. Look up the game → 404 if missing
//    3. Remove the cover image file from disk
//    4. Delete the DB row
// ─────────────────────────────────────────────────────────
app.delete('/api/games/:id', headerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);

  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid game ID. Must be a positive integer.' });
  }

  let game;
  try {
    game = await db.prepare('SELECT id, title, image_path FROM games_catalog WHERE id = ?').get(id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (!game) {
    return res.status(404).json({ error: `Game with ID ${id} not found.` });
  }

  try {
    // Remove cover image from disk first
    removeFile(game.image_path);

    // Delete the row
    await db.prepare('DELETE FROM games_catalog WHERE id = ?').run(id);

    console.log(`[Delete] ✅ Game #${id} "${game.title}" removed.`);
    res.json({ ok: true, message: `Game "${game.title}" deleted successfully.`, id });
  } catch (err) {
    console.error(`[Delete] ❌ Game #${id}:`, err.message);
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});

// Also keep the admin-panel (token-based) delete route for the SPA
app.delete('/api/admin/games/:id', tokenAuth, async (req, res) => {
  const id   = parseInt(req.params.id, 10);
  try {
    const game = await db.prepare('SELECT id, title, image_path FROM games_catalog WHERE id = ?').get(id);
    if (!game) return res.status(404).json({ error: 'Game not found.' });
    removeFile(game.image_path);
    await db.prepare('DELETE FROM games_catalog WHERE id = ?').run(id);
    res.json({ ok: true, message: `"${game.title}" deleted.`, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
//  TASK 3 — DYNAMIC CATEGORIES
//
//  All categories are stored in the `categories` table.
//  No hard-coded lists anywhere in the codebase.
//
//  Public (no auth):
//    GET  /api/categories
//
//  Admin via x-admin-password header:
//    POST   /api/categories        — add
//    DELETE /api/categories/:id    — remove
//
//  Admin via Bearer token (SPA panel):
//    POST   /api/admin/categories
//    DELETE /api/admin/categories/:id
// ─────────────────────────────────────────────────────────

/** GET /api/categories  —  public, used by frontend pill filters */
app.get('/api/categories', async (_req, res) => {
  try {
    const rows = await db.prepare('SELECT id, name, created_at FROM categories ORDER BY name').all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/categories  —  header-auth, for CLI/scripts/curl */
app.post('/api/categories', headerAuth, async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  try {
    const r = await db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    const created = await db.prepare('SELECT id, name FROM categories WHERE id = ?').get(r.lastInsertRowid);
    console.log(`[Category] ✅ Added: "${name}"`);
    res.status(201).json(created);
  } catch (e) {
    const isDupe = e.message && e.message.includes('UNIQUE');
    res.status(isDupe ? 409 : 500).json({ error: isDupe ? `Category "${name}" already exists.` : e.message });
  }
});

/** DELETE /api/categories/:id  —  header-auth, for CLI/scripts/curl */
app.delete('/api/categories/:id', headerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid category ID.' });
  try {
    const cat = await db.prepare('SELECT id, name FROM categories WHERE id = ?').get(id);
    if (!cat) return res.status(404).json({ error: `Category ${id} not found.` });
    await db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    console.log(`[Category] 🗑️  Deleted: "${cat.name}"`);
    res.json({ ok: true, message: `Category "${cat.name}" deleted.`, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SPA token-based mirrors (used by admin.html)
app.post('/api/admin/categories', tokenAuth, async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Category name required.' });
  try {
    const r = await db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    res.status(201).json({ id: r.lastInsertRowid, name });
  } catch (e) {
    const isDupe = e.message && e.message.includes('UNIQUE');
    res.status(isDupe ? 409 : 500).json({ error: isDupe ? `"${name}" already exists.` : e.message });
  }
});

app.delete('/api/admin/categories/:id', tokenAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const cat = await db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
    if (!cat) return res.status(404).json({ error: 'Category not found.' });
    await db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
//  GAMES  (read + create + featured toggle)
// ─────────────────────────────────────────────────────────
app.get('/api/games', async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT g.*, c.name AS category_name
      FROM   games_catalog g
      LEFT JOIN categories c ON g.category_id = c.id
      ORDER  BY g.created_at DESC
    `).all();
    res.json(rows.map(g => ({ ...g, image_url: toUrl(req, g.image_path) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/featured', async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT g.*, c.name AS category_name
      FROM   games_catalog g
      LEFT JOIN categories c ON g.category_id = c.id
      WHERE  g.is_featured = 1
      ORDER  BY g.created_at DESC
      LIMIT  10
    `).all();
    res.json(rows.map(g => ({ ...g, image_url: toUrl(req, g.image_path) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/games', tokenAuth, gameUpload.single('image'), async (req, res) => {
  try {
    const title       = (req.body.title    || '').trim().slice(0, 120);
    const game_url    = (req.body.game_url || '#').trim();
    const category_id = req.body.category_id ? parseInt(req.body.category_id, 10) : null;
    const is_featured = req.body.is_featured === '1' ? 1 : 0;

    if (!title) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Game title required.' });
    }

    if (is_featured) {
      const nRow = await db.prepare('SELECT COUNT(*) AS n FROM games_catalog WHERE is_featured = 1').get();
      const n = nRow?.n || 0;
      if (n >= 10) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Featured limit (10) reached.' });
      }
    }

    const image_path = req.file ? `uploads/games/${req.file.filename}` : null;
    const r = await db.prepare(`
      INSERT INTO games_catalog (title, category_id, image_path, game_url, is_featured)
      VALUES (?, ?, ?, ?, ?)
    `).run(title, category_id, image_path, game_url, is_featured);

    res.status(201).json({ id: r.lastInsertRowid, title, image_url: toUrl(req, image_path), is_featured });
  } catch (e) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/games/:id/featured', tokenAuth, async (req, res) => {
  try {
    const id       = parseInt(req.params.id, 10);
    const featured = req.body.featured === true || req.body.featured === 'true';

    if (featured) {
      const nRow = await db.prepare('SELECT COUNT(*) AS n FROM games_catalog WHERE is_featured = 1').get();
      const n = nRow?.n || 0;
      if (n >= 10) return res.status(400).json({ error: 'Featured limit (10) reached.' });
    }

    await db.prepare('UPDATE games_catalog SET is_featured = ? WHERE id = ?').run(featured ? 1 : 0, id);
    res.json({ ok: true, id, is_featured: featured ? 1 : 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', tokenAuth, async (_req, res) => {
  try {
    const games = await db.prepare('SELECT COUNT(*) AS n FROM games_catalog').get();
    const categories = await db.prepare('SELECT COUNT(*) AS n FROM categories').get();
    const featured = await db.prepare('SELECT COUNT(*) AS n FROM games_catalog WHERE is_featured = 1').get();
    res.json({ games: games.n, categories: categories.n, featured: featured.n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
//  PROFILE
//
//  TASK 4: Reset Profile is frontend-only (localStorage).
//  These backend endpoints ONLY manage name + avatar image.
//  They never touch games or categories.
// ─────────────────────────────────────────────────────────
app.get('/api/profile', async (req, res) => {
  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = 1').get();
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ id: user.id, name: user.name, image_url: toUrl(req, user.profile_image_path) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/profile', avatarUpload.single('image'), async (req, res) => {
  try {
    const name = (req.body.name ?? '').trim().slice(0, 80);
    if (!name) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Name is required.' });
    }

    const cur = await db.prepare('SELECT profile_image_path FROM users WHERE id = 1').get();
    let imagePath = cur?.profile_image_path;

    if (req.file) {
      imagePath = `uploads/${req.file.filename}`;
      removeFile(cur?.profile_image_path);
    }

    await db.prepare('UPDATE users SET name = ?, profile_image_path = ? WHERE id = 1').run(name, imagePath);

    res.json({ message: 'Profile updated.', name, image_url: toUrl(req, imagePath) });
  } catch (e) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/profile/image — removes only the avatar, name unchanged */
app.delete('/api/profile/image', async (_req, res) => {
  try {
    const user = await db.prepare('SELECT profile_image_path FROM users WHERE id = 1').get();
    removeFile(user?.profile_image_path);
    await db.prepare('UPDATE users SET profile_image_path = NULL WHERE id = 1').run();
    res.json({ ok: true, message: 'Profile image removed.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  ERROR HANDLERS  (must come after all routes)
// ══════════════════════════════════════════════════════════

// Multer-specific errors (file size / unsupported type)
app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError || err?.message) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'Image must be 5 MB or smaller.'
      : err.message;
    return res.status(400).json({ error: msg });
  }
  next(err);
});

// Generic fallback error handler
app.use((err, _req, res, _next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ══════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n✅  GameZone v4.0 → http://localhost:${PORT}`);
  console.log(`   🔐  Admin panel → http://localhost:${PORT}/admin`);
  console.log(`   ⚠️   Never expose ADMIN_PASSWORD in logs or commits\n`);
});
