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

// Demo accounts above can be switched off once real accounts exist: DISABLE_DEMO_ACCOUNTS=true
const DEMO_OFF = String(process.env.DISABLE_DEMO_ACCOUNTS || '').toLowerCase() === 'true';
// Anyone signing up / signing in with one of these emails becomes an admin: ADMIN_EMAILS=you@gmail.com,other@x.com
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));

// Set AUTH_SECRET in your environment so logins survive a restart.
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function makeToken(extra) {
  const p = Buffer.from(JSON.stringify({ ...extra, exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${p}.${sign(p)}`;
}
// returns the signed payload, or null if missing / forged / expired
function readToken(token) {
  if (!token) return null;
  const [p, s] = token.split('.');
  if (!p || !s) return null;
  const expected = sign(p);
  if (s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (!(d.exp > Date.now())) return null;
    return d.g || (!DEMO_OFF && USERS[d.u]) ? d : null;
  } catch { return null; }
}
function userFromToken(d) {
  if (!d) return null;
  if (d.g) return { username: d.u, name: d.n || 'Member', role: d.r === 'admin' ? 'admin' : 'member', email: d.e || null, picture: d.p || null };
  return { username: d.u, name: USERS[d.u].name, role: USERS[d.u].role };
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
  req.user = userFromToken(readToken(parseCookies(req).sid));
  next();
});

// never hand the app page to someone who isn't signed in, wherever the file was placed
app.use((req, res, next) => (/^\/(app|index)\.html$/i.test(req.path) && !req.user ? res.redirect('/login') : next()));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// The signed-in app page. Looks in a few places so a misplaced folder doesn't break it.
const fs = require('fs');
const APP_CANDIDATES = [
  path.join(__dirname, 'private', 'app.html'),
  path.join(__dirname, 'app.html'),
  path.join(__dirname, 'public', 'app.html'),
];
app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const file = APP_CANDIDATES.find((f) => fs.existsSync(f));
  if (!file) {
    return res.status(500).type('text').send(
      'Signed in, but app.html was not found.\nPut it at:\n  ' + APP_CANDIDATES[0] +
      '\n\n(server.js looked in:\n  ' + APP_CANDIDATES.join('\n  ') + ')');
  }
  res.sendFile(file);
});
app.get('/login', (req, res) =>
  req.user ? res.redirect('/') : res.sendFile(path.join(__dirname, 'public', 'login.html')));

/* ------------------------------------------------------------------ *
 *  Accounts: sign up, sign in (email + password) and Google.
 *  Real accounts live in the `users` table (see database/accounts.sql).
 *  Passwords are stored only as salted scrypt hashes.
 * ------------------------------------------------------------------ */
const scryptAsync = (pw, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scryptAsync(pw, salt)).toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64'), got = await scryptAsync(pw, Buffer.from(s, 'base64'));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
let DUMMY_HASH = null;   // used so unknown emails take as long to reject as wrong passwords
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function startSession(req, res, u) {
  const token = makeToken({ u: u.username, g: 1, n: u.display_name, e: u.email || '', p: u.avatar_url || '', r: u.role });
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(token)}; Max-Age=${SESSION_MS / 1000}; ${cookieFlags(req)}`);
}
// promote to admin when the email is listed in ADMIN_EMAILS
async function resolveRole(u) {
  const want = ADMIN_EMAILS.has(String(u.email || '').toLowerCase()) ? 'admin' : (u.role === 'admin' ? 'admin' : 'member');
  if (u.id && want !== u.role) await soft(() => pool.query('UPDATE users SET role = ? WHERE id = ?', [want, u.id]), null);
  return want;
}
const tooMany = (res) => res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });

app.get('/api/auth-config', (_, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID_PUBLIC(), signup: !!has.users, demo: !DEMO_OFF }));

// Create an account with email + password
app.post('/api/signup', async (req, res) => {
  if (!has.users) return res.status(501).json({ error: 'Account creation isn’t set up yet (the users table is missing).' });
  if (throttled(req.ip)) return tooMany(res);
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 60);
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!EMAIL_RE.test(email) || email.length > 255) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Your password must be at least 8 characters.' });
  if (password.length > 128) return res.status(400).json({ error: 'That password is too long (128 characters max).' });
  try {
    const [ex] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (ex.length) return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
    const u = { username: 'u_' + crypto.randomBytes(8).toString('hex'), display_name: name, email, avatar_url: '', role: ADMIN_EMAILS.has(email) ? 'admin' : 'member' };
    await pool.query(
      'INSERT INTO users (username, display_name, email, password_hash, role, last_login_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [u.username, u.display_name, u.email, await hashPassword(password), u.role]);
    attempts.delete(req.ip);
    startSession(req, res, u);
    res.json({ ok: true, role: u.role });
  } catch (e) {
    console.error('Sign-up failed:', e.code || '', e.message);
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
    if (e.code === 'ER_BAD_FIELD_ERROR') return res.status(500).json({ error: 'The users table needs updating. Run database/accounts.sql.' });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Sign in with email (or username) + password
app.post('/api/login', async (req, res) => {
  if (throttled(req.ip)) return tooMany(res);
  const b = req.body || {};
  const id = String(b.email || b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!id || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  const bad = () => res.status(401).json({ error: 'Incorrect email or password.' });
  try {
    // demo accounts from the USERS block at the top of this file
    if (!DEMO_OFF && Object.prototype.hasOwnProperty.call(USERS, id)) {
      if (!safeEqual(password, USERS[id].password)) return bad();
      attempts.delete(req.ip);
      res.setHeader('Set-Cookie', `sid=${encodeURIComponent(makeToken({ u: id }))}; Max-Age=${SESSION_MS / 1000}; ${cookieFlags(req)}`);
      return res.json({ ok: true, role: USERS[id].role });
    }
    const [rows] = has.users ? await pool.query('SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1', [id, id]) : [[]];
    const u = rows[0];
    if (!u) {
      DUMMY_HASH = DUMMY_HASH || await hashPassword('not-a-real-password');
      await verifyPassword(password, DUMMY_HASH);
      return bad();
    }
    if (!u.is_active) return res.status(403).json({ error: 'This account has been disabled.' });
    if (!u.password_hash) return res.status(401).json({ error: 'This account uses Google. Choose “Continue with Google”.' });
    if (!(await verifyPassword(password, u.password_hash))) return bad();
    u.role = await resolveRole(u);
    await soft(() => pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [u.id]), null);
    attempts.delete(req.ip);
    startSession(req, res, u);
    res.json({ ok: true, role: u.role });
  } catch (e) {
    console.error('Sign-in failed:', e.code || '', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ---- Sign in with Google (needs GOOGLE_CLIENT_ID) ---- */
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
let jwks = { keys: [], at: 0 };
async function googleKeys() {
  if (jwks.keys.length && Date.now() - jwks.at < 3600e3) return jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error(`could not fetch Google keys (${r.status})`);
  jwks = { keys: (await r.json()).keys || [], at: Date.now() };
  return jwks.keys;
}
async function verifyGoogleToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error('unexpected algorithm');
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error('bad signature');
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(p.iss)) throw new Error('wrong issuer');
  if (p.aud !== GOOGLE_CLIENT_ID) throw new Error('token was issued for a different app');
  if (!(p.exp * 1000 > Date.now())) throw new Error('token expired');
  if (!p.sub || p.email_verified === false) throw new Error('account not verified');
  return p;
}
const GOOGLE_CLIENT_ID_PUBLIC = () => GOOGLE_CLIENT_ID || null;
app.post('/api/login/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(501).json({ error: 'Google sign-in is not set up yet.' });
  if (throttled(req.ip)) return tooMany(res);
  try {
    const p = await verifyGoogleToken(req.body && req.body.credential);
    const email = String(p.email || '').toLowerCase();
    const name = String(p.name || email.split('@')[0] || 'Member').slice(0, 60);
    let u = { username: `g_${p.sub}`, display_name: name, email, avatar_url: p.picture || '', role: 'member' };
    if (has.users) {
      const [rows] = await pool.query('SELECT * FROM users WHERE google_sub = ? OR (email = ? AND ? <> \'\') LIMIT 1', [p.sub, email, email]);
      if (rows[0]) {
        u = rows[0];
        if (!u.is_active) return res.status(403).json({ error: 'This account has been disabled.' });
        // link Google to an existing email account the first time, and refresh the photo
        await pool.query('UPDATE users SET google_sub = COALESCE(google_sub, ?), avatar_url = ?, last_login_at = NOW() WHERE id = ?', [p.sub, p.picture || u.avatar_url, u.id]);
        u.avatar_url = p.picture || u.avatar_url;
      } else {
        u.role = ADMIN_EMAILS.has(email) ? 'admin' : 'member';
        await pool.query(
          `INSERT INTO users (username, display_name, email, password_hash, google_sub, avatar_url, role, last_login_at)
           VALUES (?, ?, ?, '', ?, ?, ?, NOW())`,
          [u.username, u.display_name, email || null, p.sub, p.picture || null, u.role]);
      }
    }
    u.role = await resolveRole(u);
    attempts.delete(req.ip);
    startSession(req, res, u);
    res.json({ ok: true, role: u.role });
  } catch (e) {
    console.error('Google sign-in failed:', e.code || '', e.message);
    res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
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
  const members = has.users ? await soft(async () => {
    const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM users');
    const [recent] = await pool.query(
      `SELECT display_name, email, role, (google_sub IS NOT NULL) AS google, created_at, last_login_at
         FROM users ORDER BY created_at DESC LIMIT 10`);
    return { total: Number(c.n), recent };
  }, { total: 0, recent: [] }) : null;
  // which optional tables exist and how many rows they hold
  const tables = [];
  for (const name of OPTIONAL) {
    let rows = null;
    if (has[name]) rows = await soft(async () => Number((await pool.query(`SELECT COUNT(*) AS n FROM \`${name}\``))[0][0].n), null);
    tables.push({ name, exists: !!has[name], rows });
  }
  res.json({
    total: Number(tot.total), movies: Number(tot.movies), shows: Number(tot.shows),
    byYear, genres, countries, ratings, tables, members,
    accounts: DEMO_OFF ? [] : Object.entries(USERS).map(([username, v]) => ({ username, name: v.name, role: v.role })),
  });
}));

/* ------------------------------------------------------------------ *
 *  Optional posters via TMDB (set TMDB_API_KEY). Only used when a title
 *  has no poster_url in title_media.
 * ------------------------------------------------------------------ */
const posterCache = new Map();
app.get('/api/poster', wrap(async (req, res) => {
  const key = (process.env.TMDB_API_KEY || '').trim();
  if (!key) return res.json({ url: null, backdrop: null, hero: null });
  const { title = '', year = '', type = 'Movie' } = req.query;
  const ck = `${type}|${title}|${year}`;
  if (!posterCache.has(ck)) {
    const kind = type === 'TV Show' ? 'tv' : 'movie';
    const yp = kind === 'tv' ? 'first_air_date_year' : 'year';
    const isToken = key.startsWith('eyJ');              // v4 "Read Access Token" or v3 "API Key" both work
    const headers = { accept: 'application/json', ...(isToken ? { Authorization: `Bearer ${key}` } : {}) };
    const url = `https://api.themoviedb.org/3/search/${kind}?query=${encodeURIComponent(title)}&${yp}=${encodeURIComponent(year)}` +
      (isToken ? '' : `&api_key=${encodeURIComponent(key)}`);
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`TMDB answered ${r.status} (check TMDB_API_KEY)`);
      const d = await r.json();
      const list = d.results || [];
      const hit = list.find((x) => x.poster_path) || list[0];
      const img = (p, size) => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);
      posterCache.set(ck, hit
        ? { url: img(hit.poster_path, 'w342'), backdrop: img(hit.backdrop_path, 'w780'), hero: img(hit.backdrop_path, 'w1280') }
        : { url: null, backdrop: null, hero: null });
    } catch (e) {
      console.error('TMDB lookup failed:', e.message);   // not cached, so it retries next time
      return res.json({ url: null, backdrop: null, hero: null });
    }
  }
  res.set('Cache-Control', 'private, max-age=86400');
  res.json(posterCache.get(ck));
}));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Streamly running on http://localhost:${port}`);
  pool.query('SELECT COUNT(*) AS n FROM titles')
    .then(([[r]]) => console.log(`Database OK – ${r.n} titles found`))
    .catch((e) => console.error('DATABASE PROBLEM:', e.code || '', e.message));
});