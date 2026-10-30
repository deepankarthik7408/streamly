const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 *  Database (Aiven MySQL)
 * ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ *
 *  Optional tables.  Every feature below checks whether its table
 *  exists.  If it doesn't (yet), the feature simply returns "no data"
 *  instead of failing, so you can add tables one at a time.
 *  The list is re-checked every minute; no restart needed.
 * ------------------------------------------------------------------ */
const OPTIONAL = ['users', 'title_media', 'title_stats', 'user_ratings', 'awards', 'title_awards', 'episodes',
  'watch_progress', 'my_list', 'title_views', 'notifications', 'collections', 'collection_titles', 'genre_art'];
let has = Object.fromEntries(OPTIONAL.map((t) => [t, false]));
async function refreshSchema() {
  try {
    const [r] = await pool.query('SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    const names = new Set(r.map((x) => String(x.n).toLowerCase()));
    has = Object.fromEntries(OPTIONAL.map((t) => [t, names.has(t)]));
  } catch (e) { console.error('schema check failed:', e.message); }
}
refreshSchema();
setInterval(refreshSchema, 60 * 1000).unref();

// run an optional query; on any failure return the fallback
const soft = async (fn, fallback) => { try { return await fn(); } catch (e) { console.error('optional query failed:', e.code || e.message); return fallback; } };

const JOINS = () =>
  (has.title_media ? ' LEFT JOIN title_media m ON m.show_id = t.show_id' : '') +
  (has.title_stats ? ' LEFT JOIN title_stats s ON s.show_id = t.show_id' : '');
const FT = () => 'titles t' + JOINS();
const SEL = () =>
  't.show_id, t.type, t.title, t.release_year, t.rating, t.duration_value, t.duration_unit, ' +
  (has.title_media ? 'm.poster_url, m.backdrop_url' : 'NULL AS poster_url, NULL AS backdrop_url') + ', ' +
  (has.title_stats ? 's.avg_rating, s.rating_count, s.match_percent' : 'NULL AS avg_rating, 0 AS rating_count, NULL AS match_percent');

async function byIds(ids) {
  ids = [...new Set((ids || []).map(Number))].filter(Boolean);
  if (!ids.length) return [];
  const [rows] = await pool.query(`SELECT ${SEL()} FROM ${FT()} WHERE t.show_id IN (?)`, [ids]);
  rows.sort((a, b) => ids.indexOf(a.show_id) - ids.indexOf(b.show_id));
  return rows;
}
// full detail rows (v_titles_full) plus poster / rating extras
async function fullByIds(ids) {
  ids = [...new Set((ids || []).map(Number))].filter(Boolean);
  if (!ids.length) return [];
  const [full] = await pool.query('SELECT * FROM v_titles_full WHERE show_id IN (?)', [ids]);
  const extras = new Map((await byIds(ids)).map((x) => [x.show_id, x]));
  return full.map((f) => ({ ...f, ...(extras.get(f.show_id) || {}) }))
    .sort((a, b) => ids.indexOf(a.show_id) - ids.indexOf(b.show_id));
}

/* ------------------------------------------------------------------ *
 *  Accounts – hardcoded for now (nothing is written to the database).
 *  Change the passwords here whenever you like.
 * ------------------------------------------------------------------ */
const USERS = {
  admin:  { password: 'Admin@123',  name: 'Administrator', role: 'admin'  },
  arjun:  { password: 'Arjun@123',  name: 'Arjun',         role: 'member' },
  priya:  { password: 'Priya@123',  name: 'Priya',         role: 'member' },
  karthik:{ password: 'Karthik@123',name: 'Karthik',       role: 'member' },
  divya:  { password: 'Divya@123',  name: 'Divya',         role: 'member' },
  rahul:  { password: 'Rahul@123',  name: 'Rahul',         role: 'member' },
};

// Set AUTH_SECRET in your environment so logins survive a restart.
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function makeToken(username) {
  const p = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${p}.${sign(p)}`;
}
function readToken(token) {
  if (!token) return null;
  const [p, s] = token.split('.');
  if (!p || !s) return null;
  const expected = sign(p);
  if (s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.exp > Date.now() && USERS[d.u] ? d.u : null;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
const cookieFlags = (req) => `HttpOnly; SameSite=Lax; Path=/${req.secure ? '; Secure' : ''}`;

// tiny in-memory login throttle: 8 attempts / 5 minutes / IP
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { n: 1, reset: now + 5 * 60 * 1000 }); return false; }
  a.n += 1;
  return a.n > 8;
}

/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error' }); });

app.use(express.json({ limit: '4kb' }));
app.get('/healthz', (_, res) => res.send('ok'));

app.use((req, _res, next) => {
  const username = readToken(parseCookies(req).sid);
  req.user = username ? { username, name: USERS[username].name, role: USERS[username].role } : null;
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (req, res) =>
  req.user ? res.sendFile(path.join(__dirname, 'private', 'app.html')) : res.redirect('/login'));
app.get('/login', (req, res) =>
  req.user ? res.redirect('/') : res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/api/login', (req, res) => {
  if (throttled(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const user = Object.prototype.hasOwnProperty.call(USERS, username) ? USERS[username] : null;
  const ok = safeEqual(password, user ? user.password : crypto.randomBytes(8).toString('hex'));
  if (!user || !ok) return res.status(401).json({ error: 'Incorrect username or password.' });
  attempts.delete(req.ip);
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(makeToken(username))}; Max-Age=${SESSION_MS / 1000}; ${cookieFlags(req)}`);
  res.json({ ok: true, role: user.role });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `sid=; Max-Age=0; ${cookieFlags(req)}`);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in required' })));
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));

app.get('/api/me', (req, res) => res.json(req.user));
app.get('/api/config', (_, res) => res.json({ posters: !!process.env.TMDB_API_KEY, features: has }));

/* ------------------------------------------------------------------ *
 *  Catalog API
 * ------------------------------------------------------------------ */
app.get('/api/titles', wrap(async (req, res) => {
  const { type, genre, country, rating, year, q, sort } = req.query;
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
  if (rating) { w.push('t.rating = ?'); p.push(String(rating)); }
  if (parseInt(year)) { w.push('t.release_year = ?'); p.push(parseInt(year)); }
  if (q && q.trim()) {
    const like = `%${q.trim().replace(/[%_]/g, '\\$&')}%`;
    w.push(`(t.title LIKE ?
      OR t.show_id IN (SELECT x.show_id FROM title_actors x JOIN actors a ON a.id = x.actor_id WHERE a.name LIKE ?)
      OR t.show_id IN (SELECT x.show_id FROM title_directors x JOIN directors d ON d.id = x.director_id WHERE d.name LIKE ?))`);
    p.push(like, like, like);
  }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const orders = { year: 't.release_year DESC, t.title', az: 't.title ASC' };
  if (has.title_stats) orders.rating = 's.avg_rating DESC, s.rating_count DESC, t.title';
  const order = orders[sort] || 't.date_added DESC, t.show_id DESC';
  const [items] = await pool.query(
    `SELECT ${SEL()} FROM ${FT()} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...p, limit, (page - 1) * limit]);
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM titles t ${where}`, p);
  res.json({ total: n, page, items });
}));

app.get('/api/titles/bulk', wrap(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((x) => parseInt(x)).filter(Boolean).slice(0, 200);
  res.json(await byIds(ids));
}));

// One title: details + my rating + awards
app.get('/api/titles/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id) || 0;
  const [t] = await fullByIds([id]);
  if (!t) return res.status(404).json({ error: 'Not found' });
  t.my_rating = has.user_ratings
    ? await soft(async () => { const [r] = await pool.query('SELECT stars FROM user_ratings WHERE username = ? AND show_id = ?', [req.user.username, id]); return r[0] ? r[0].stars : null; }, null)
    : null;
  t.awards = has.title_awards && has.awards
    ? await soft(async () => (await pool.query(
        `SELECT a.name, ta.category, ta.award_year, ta.result FROM title_awards ta JOIN awards a ON a.id = ta.award_id
         WHERE ta.show_id = ? ORDER BY ta.result = 'won' DESC, ta.award_year DESC`, [id]))[0], [])
    : [];
  res.json(t);
}));

app.get('/api/titles/:id/similar', wrap(async (req, res) => {
  const id = parseInt(req.params.id) || 0;
  const [ids] = await pool.query(
    `SELECT tg.show_id FROM title_genres tg
      WHERE tg.genre_id IN (SELECT genre_id FROM title_genres WHERE show_id = ?) AND tg.show_id <> ?
      GROUP BY tg.show_id ORDER BY COUNT(*) DESC, RAND() LIMIT 12`, [id, id]);
  res.json(await byIds(ids.map((x) => x.show_id)));
}));

app.get('/api/titles/:id/episodes', wrap(async (req, res) => {
  if (!has.episodes) return res.json([]);
  res.json(await soft(async () => (await pool.query(
    `SELECT season_no, episode_no, title, description, duration_min FROM episodes
     WHERE show_id = ? ORDER BY season_no, episode_no LIMIT 300`, [parseInt(req.params.id) || 0]))[0], []));
}));

// Rate a title (1-5 stars) and refresh its average
app.post('/api/titles/:id/rate', wrap(async (req, res) => {
  if (!has.user_ratings || !has.title_stats) return res.status(501).json({ error: 'Ratings are not set up yet' });
  const id = parseInt(req.params.id) || 0;
  const stars = Math.round(Number(req.body && req.body.stars));
  if (!id || !(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Stars must be 1 to 5' });
  await pool.query(
    `INSERT INTO user_ratings (username, show_id, stars) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE stars = VALUES(stars)`, [req.user.username, id, stars]);
  await pool.query(
    `INSERT INTO title_stats (show_id, avg_rating, rating_count)
     SELECT show_id, ROUND(AVG(stars), 1), COUNT(*) FROM user_ratings WHERE show_id = ? GROUP BY show_id
     ON DUPLICATE KEY UPDATE avg_rating = VALUES(avg_rating), rating_count = VALUES(rating_count)`, [id]);
  const [[s]] = await pool.query('SELECT avg_rating, rating_count FROM title_stats WHERE show_id = ?', [id]);
  res.json({ ok: true, my_rating: stars, ...s });
}));

// Hero banner titles (?n=1..8): your 'hero' collection if filled, otherwise random recent titles
app.get('/api/featured', wrap(async (req, res) => {
  const n = Math.min(Math.max(parseInt(req.query.n) || 1, 1), 8);
  let ids = [];
  if (n > 1 && has.collections && has.collection_titles) {
    ids = await soft(async () => (await pool.query(
      `SELECT ct.show_id FROM collection_titles ct JOIN collections c ON c.id = ct.collection_id
       WHERE c.slug = 'hero' AND c.is_active = 1 ORDER BY ct.position LIMIT ?`, [n]))[0].map((x) => x.show_id), []);
  }
  if (!ids.length) {
    const [picks] = await pool.query('SELECT show_id FROM titles WHERE release_year >= 2015 ORDER BY RAND() LIMIT ?', [n]);
    ids = picks.map((x) => x.show_id);
  }
  res.json(await fullByIds(ids));
}));

// Home rows. Rows flagged empty:true are shown as "no data yet" placeholders in the UI.
app.get('/api/rows', wrap(async (_, res) => {
  const [genres] = await pool.query(
    `SELECT g.id, g.name FROM genres g JOIN title_genres tg ON tg.genre_id = g.id
     GROUP BY g.id, g.name ORDER BY COUNT(*) DESC LIMIT 10`);
  const grab = async (where, order, extraJoin = '') =>
    (await pool.query(`SELECT ${SEL()} FROM ${FT()} ${extraJoin} ${where} ORDER BY ${order} LIMIT 20`))[0];

  const trending = has.title_stats
    ? await soft(() => grab(`WHERE t.type = 'Movie' AND s.trending_score > 0`, 's.trending_score DESC'), []) : [];
  const newShows = await grab(`WHERE t.type = 'TV Show'`, 't.release_year DESC, t.date_added DESC');
  const awarded = has.title_awards
    ? await soft(() => grab(`WHERE t.type = 'Movie' AND t.show_id IN (SELECT show_id FROM title_awards WHERE result = 'won')`, 't.release_year DESC'), []) : [];
  const recent = await grab('', 't.date_added DESC, t.show_id DESC');
  const binge = await grab(`WHERE t.type = 'TV Show' AND t.duration_value >= 3`, 'RAND()');
  const short = await grab(`WHERE t.type = 'Movie' AND t.duration_unit = 'min' AND t.duration_value <= 90`, 'RAND()');

  // your own curated rows (collections / collection_titles)
  let curated = [];
  if (has.collections && has.collection_titles) {
    curated = await soft(async () => {
      const [cols] = await pool.query(`SELECT id, name, slug FROM collections WHERE is_active = 1 AND slug <> 'hero' ORDER BY sort_order, id LIMIT 12`);
      const out = [];
      for (const c of cols) {
        const [ids] = await pool.query('SELECT show_id FROM collection_titles WHERE collection_id = ? ORDER BY position LIMIT 20', [c.id]);
        const items = await byIds(ids.map((x) => x.show_id));
        if (items.length) out.push({ name: c.name, items });
      }
      return out;
    }, []);
  }

  const genreRows = await Promise.all(genres.map(async (g) => ({
    name: g.name, genre: g.name,
    items: await grab('WHERE t.show_id IN (SELECT show_id FROM title_genres WHERE genre_id = ' + Number(g.id) + ')', 'RAND()'),
  })));

  const rows = [
    { name: 'Trending movies', type: 'Movie', items: trending, empty: !trending.length, hint: 'title_stats.trending_score' },
    { name: 'New release TV shows', type: 'TV Show', items: newShows, empty: !newShows.length },
    { name: 'Award-winning films', type: 'Movie', items: awarded, empty: !awarded.length, hint: 'title_awards' },
    ...curated,
    { name: 'Recently added', items: recent },
    { name: 'Series worth a weekend', items: binge },
    { name: 'Movies under 90 minutes', items: short },
    ...genreRows,
  ].filter((r) => r.items.length || r.empty);
  res.set('Cache-Control', 'private, max-age=30');
  res.json(rows);
}));

// Popular genre tiles (with optional artwork from genre_art)
app.get('/api/genres/popular', wrap(async (_, res) => {
  const art = has.genre_art ? ' LEFT JOIN genre_art ga ON ga.genre_id = g.id' : '';
  const [rows] = await pool.query(
    `SELECT g.name, ${has.genre_art ? 'ga.image_url' : 'NULL'} AS image_url FROM genres g
       JOIN title_genres tg ON tg.genre_id = g.id${art}
      GROUP BY g.id, g.name${has.genre_art ? ', ga.image_url' : ''} ORDER BY COUNT(*) DESC LIMIT 12`);
  res.json(rows);
}));

app.get('/api/filters', wrap(async (_, res) => {
  const [genres] = await pool.query('SELECT name FROM genres ORDER BY name');
  const [countries] = await pool.query(
    `SELECT c.name FROM countries c JOIN title_countries tc ON tc.country_id = c.id
     GROUP BY c.id, c.name ORDER BY COUNT(*) DESC LIMIT 60`);
  const [ratings] = await pool.query(
    `SELECT rating FROM titles WHERE rating IS NOT NULL AND rating <> '' GROUP BY rating ORDER BY COUNT(*) DESC LIMIT 14`);
  res.set('Cache-Control', 'private, max-age=3600');
  res.json({ genres: genres.map((g) => g.name), countries: countries.map((c) => c.name), ratings: ratings.map((r) => r.rating) });
}));

/* ------------------------------------------------------------------ *
 *  Per-user data (My List, recently viewed, continue watching, bell)
 * ------------------------------------------------------------------ */
app.get('/api/me/list', wrap(async (req, res) => {
  if (!has.my_list) return res.json({ ids: [] });
  const [r] = await pool.query('SELECT show_id FROM my_list WHERE username = ? ORDER BY added_at DESC LIMIT 500', [req.user.username]);
  res.json({ ids: r.map((x) => x.show_id) });
}));
app.put('/api/me/list/:id', wrap(async (req, res) => {
  if (!has.my_list) return res.status(501).json({ error: 'not set up' });
  await pool.query('INSERT IGNORE INTO my_list (username, show_id) VALUES (?, ?)', [req.user.username, parseInt(req.params.id) || 0]);
  res.json({ ok: true });
}));
app.delete('/api/me/list/:id', wrap(async (req, res) => {
  if (!has.my_list) return res.status(501).json({ error: 'not set up' });
  await pool.query('DELETE FROM my_list WHERE username = ? AND show_id = ?', [req.user.username, parseInt(req.params.id) || 0]);
  res.json({ ok: true });
}));

app.get('/api/me/recent', wrap(async (req, res) => {
  if (!has.title_views) return res.json({ ids: [] });
  const [r] = await pool.query(
    `SELECT show_id FROM title_views WHERE username = ? GROUP BY show_id ORDER BY MAX(viewed_at) DESC LIMIT 20`, [req.user.username]);
  res.json({ ids: r.map((x) => x.show_id) });
}));
app.post('/api/me/view/:id', wrap(async (req, res) => {
  if (!has.title_views) return res.status(501).json({ error: 'not set up' });
  await pool.query('INSERT INTO title_views (username, show_id) VALUES (?, ?)', [req.user.username, parseInt(req.params.id) || 0]);
  res.json({ ok: true });
}));

app.get('/api/me/continue', wrap(async (req, res) => {
  if (!has.watch_progress) return res.json([]);
  const [rows] = await pool.query(
    `SELECT ${SEL()}, w.progress_seconds, w.duration_seconds, w.season_no, w.episode_no
       FROM watch_progress w JOIN titles t ON t.show_id = w.show_id ${JOINS()}
      WHERE w.username = ? AND w.completed = 0 ORDER BY w.last_watched_at DESC LIMIT 20`, [req.user.username]);
  res.json(rows);
}));
// For a future player: POST {show_id, progress_seconds, duration_seconds, season_no?, episode_no?}
app.post('/api/me/progress', wrap(async (req, res) => {
  if (!has.watch_progress) return res.status(501).json({ error: 'not set up' });
  const b = req.body || {};
  const id = parseInt(b.show_id) || 0, prog = Math.max(0, parseInt(b.progress_seconds) || 0), total = Math.max(0, parseInt(b.duration_seconds) || 0);
  if (!id) return res.status(400).json({ error: 'show_id required' });
  const done = total > 0 && prog >= total * 0.95 ? 1 : 0;
  await pool.query(
    `INSERT INTO watch_progress (username, show_id, progress_seconds, duration_seconds, season_no, episode_no, completed)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE progress_seconds = VALUES(progress_seconds), duration_seconds = VALUES(duration_seconds),
       season_no = VALUES(season_no), episode_no = VALUES(episode_no), completed = VALUES(completed), last_watched_at = CURRENT_TIMESTAMP`,
    [req.user.username, id, prog, total, parseInt(b.season_no) || null, parseInt(b.episode_no) || null, done]);
  res.json({ ok: true });
}));

app.get('/api/notifications', wrap(async (req, res) => {
  if (!has.notifications) return res.json([]);
  res.json(await soft(async () => (await pool.query(
    `SELECT id, message, show_id, created_at FROM notifications
     WHERE username IS NULL OR username = ? ORDER BY created_at DESC LIMIT 15`, [req.user.username]))[0], []));
}));

/* ------------------------------------------------------------------ *
 *  Admin API
 * ------------------------------------------------------------------ */
app.get('/api/admin/stats', adminOnly, wrap(async (_, res) => {
  const [[tot]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(type = 'Movie') AS movies, SUM(type = 'TV Show') AS shows, MAX(release_year) AS maxYear FROM titles`);
  const maxYear = Number(tot.maxYear) || new Date().getFullYear();
  const [byYear] = await pool.query(
    `SELECT release_year AS name, COUNT(*) AS n FROM titles WHERE release_year > ? GROUP BY release_year ORDER BY release_year`, [maxYear - 14]);
  const [genres] = await pool.query(
    `SELECT g.name, COUNT(*) AS n FROM genres g JOIN title_genres tg ON tg.genre_id = g.id GROUP BY g.id, g.name ORDER BY n DESC LIMIT 8`);
  const [countries] = await pool.query(
    `SELECT c.name, COUNT(*) AS n FROM countries c JOIN title_countries tc ON tc.country_id = c.id GROUP BY c.id, c.name ORDER BY n DESC LIMIT 8`);
  const [ratings] = await pool.query(
    `SELECT rating AS name, COUNT(*) AS n FROM titles WHERE rating IS NOT NULL AND rating <> '' GROUP BY rating ORDER BY n DESC LIMIT 8`);
  // which optional tables exist and how many rows they hold
  const tables = [];
  for (const name of OPTIONAL) {
    let rows = null;
    if (has[name]) rows = await soft(async () => Number((await pool.query(`SELECT COUNT(*) AS n FROM \`${name}\``))[0][0].n), null);
    tables.push({ name, exists: !!has[name], rows });
  }
  res.json({
    total: Number(tot.total), movies: Number(tot.movies), shows: Number(tot.shows),
    byYear, genres, countries, ratings, tables,
    accounts: Object.entries(USERS).map(([username, v]) => ({ username, name: v.name, role: v.role })),
  });
}));

/* ------------------------------------------------------------------ *
 *  Optional posters via TMDB (set TMDB_API_KEY). Only used when a title
 *  has no poster_url in title_media.
 * ------------------------------------------------------------------ */
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
  res.set('Cache-Control', 'private, max-age=86400');
  res.json({ url: posterCache.get(ck) });
}));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Streamly running on http://localhost:${port}`));
