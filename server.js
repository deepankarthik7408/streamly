const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');

const u = new URL(process.env.DATABASE_URL || 'mysql://root@localhost:3306/netflix');
const pool = mysql.createPool({
  host: u.hostname,
  port: Number(u.port) || 3306,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: process.env.DB_NAME || u.pathname.slice(1) || 'netflix',
  ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: false },
  charset: 'utf8mb4',
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 5,
});

const COLS = 't.show_id, t.type, t.title, t.release_year, t.rating, t.duration_value, t.duration_unit';
const app = express();
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error' }); });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_, res) => res.send('ok'));
app.get('/api/config', (_, res) => res.json({ posters: !!process.env.TMDB_API_KEY }));

// Browse / search / filter (paginated)
app.get('/api/titles', wrap(async (req, res) => {
  const { type, genre, country, year, q, sort } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 24, 1), 60);
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const w = [], p = [];
  if (type === 'Movie' || type === 'TV Show') { w.push('t.type = ?'); p.push(type); }
  if (genre) {
    w.push('t.show_id IN (SELECT tg.show_id FROM title_genres tg JOIN genres g ON g.id = tg.genre_id WHERE g.name = ?)');
    p.push(genre);
  }
  if (country) {
    w.push('t.show_id IN (SELECT tc.show_id FROM title_countries tc JOIN countries c ON c.id = tc.country_id WHERE c.name = ?)');
    p.push(country);
  }
  if (parseInt(year)) { w.push('t.release_year = ?'); p.push(parseInt(year)); }
  if (q && q.trim()) {
    const like = `%${q.trim().replace(/[%_]/g, '\\$&')}%`;
    w.push(`(t.title LIKE ?
      OR t.show_id IN (SELECT x.show_id FROM title_actors x JOIN actors a ON a.id = x.actor_id WHERE a.name LIKE ?)
      OR t.show_id IN (SELECT x.show_id FROM title_directors x JOIN directors d ON d.id = x.director_id WHERE d.name LIKE ?))`);
    p.push(like, like, like);
  }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const order = { year: 't.release_year DESC, t.title', az: 't.title ASC' }[sort] || 't.date_added DESC, t.show_id DESC';
  const [items] = await pool.query(
    `SELECT ${COLS} FROM titles t ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...p, limit, (page - 1) * limit]);
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM titles t ${where}`, p);
  res.json({ total: n, page, items });
}));

// Single title with cast, directors, countries, genres
app.get('/api/titles/:id', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM v_titles_full WHERE show_id = ?', [parseInt(req.params.id) || 0]);
  rows.length ? res.json(rows[0]) : res.status(404).json({ error: 'Not found' });
}));

// Random featured title for the hero banner
app.get('/api/featured', wrap(async (_, res) => {
  const [[pick]] = await pool.query('SELECT show_id FROM titles WHERE release_year >= 2015 ORDER BY RAND() LIMIT 1');
  const [rows] = await pool.query('SELECT * FROM v_titles_full WHERE show_id = ?', [pick.show_id]);
  res.json(rows[0]);
}));

// Home page rows: recently added + top genres
app.get('/api/rows', wrap(async (_, res) => {
  const [genres] = await pool.query(
    `SELECT g.id, g.name FROM genres g JOIN title_genres tg ON tg.genre_id = g.id
     GROUP BY g.id, g.name ORDER BY COUNT(*) DESC LIMIT 10`);
  const [recent] = await pool.query(`SELECT ${COLS} FROM titles t ORDER BY t.date_added DESC, t.show_id DESC LIMIT 20`);
  const rows = [{ name: 'Recently Added', items: recent }];
  await Promise.all(genres.map(async (g) => {
    const [items] = await pool.query(
      `SELECT ${COLS} FROM titles t JOIN title_genres tg ON tg.show_id = t.show_id
       WHERE tg.genre_id = ? ORDER BY RAND() LIMIT 20`, [g.id]);
    rows.push({ name: g.name, genre: g.name, items });
  }));
  // keep genre rows in popularity order (Promise.all pushes in completion order)
  const order = genres.map((g) => g.name);
  rows.sort((a, b) => (a.genre ? order.indexOf(a.genre) + 1 : 0) - (b.genre ? order.indexOf(b.genre) + 1 : 0));
  res.set('Cache-Control', 'public, max-age=120');
  res.json(rows);
}));

// Filter dropdown options
app.get('/api/filters', wrap(async (_, res) => {
  const [genres] = await pool.query('SELECT name FROM genres ORDER BY name');
  const [countries] = await pool.query(
    `SELECT c.name FROM countries c JOIN title_countries tc ON tc.country_id = c.id
     GROUP BY c.id, c.name ORDER BY COUNT(*) DESC LIMIT 60`);
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ genres: genres.map((g) => g.name), countries: countries.map((c) => c.name) });
}));

// Optional posters via TMDB (set TMDB_API_KEY). Cached in memory.
const posterCache = new Map();
app.get('/api/poster', wrap(async (req, res) => {
  const key = process.env.TMDB_API_KEY;
  if (!key) return res.json({ url: null });
  const { title = '', year = '', type = 'Movie' } = req.query;
  const ck = `${type}|${title}|${year}`;
  if (!posterCache.has(ck)) {
    const kind = type === 'TV Show' ? 'tv' : 'movie';
    const yp = kind === 'tv' ? 'first_air_date_year' : 'year';
    let url = null;
    try {
      const r = await fetch(`https://api.themoviedb.org/3/search/${kind}?api_key=${key}&query=${encodeURIComponent(title)}&${yp}=${encodeURIComponent(year)}`);
      const d = await r.json();
      const hit = (d.results || []).find((x) => x.poster_path);
      if (hit) url = `https://image.tmdb.org/t/p/w342${hit.poster_path}`;
    } catch (e) { /* leave null */ }
    posterCache.set(ck, url);
  }
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ url: posterCache.get(ck) });
}));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Streamly running on http://localhost:${port}`));
