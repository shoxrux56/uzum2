require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  try {
    const res = await pool.query('SELECT id, image_path FROM games_catalog');
    for (const r of res.rows) {
      if (!r.image_path) continue;
      const abs = path.join(__dirname, '..', r.image_path);
      if (!fs.existsSync(abs)) {
        console.log('Missing file for id', r.id, 'path', r.image_path, ' — clearing field');
        await pool.query('UPDATE games_catalog SET image_path = NULL WHERE id = $1', [r.id]);
      }
    }
    console.log('Done.');
  } catch (e) {
    console.error(e.message);
  } finally {
    await pool.end();
  }
})();
