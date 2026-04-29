require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  try {
    const res = await pool.query('SELECT id, title, image_path, game_url FROM games_catalog ORDER BY id');
    console.log('Found', res.rowCount, 'rows');
    res.rows.forEach(r => console.log(r));
  } catch (e) {
    console.error('Error querying DB:', e.message);
  } finally {
    await pool.end();
  }
})();
