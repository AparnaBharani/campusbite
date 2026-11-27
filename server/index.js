import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { createClient } from 'redis';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createCache } from './cache.js';
import { runMigrations } from './db.js';
import { configuredRole, createOtp, hashSecret, isAllowedStudentEmail, normalizeEmail, parseRoleEmails, secretsMatch } from './auth.js';
import { GATES } from './locations.js';
import { predictDemand } from './recommendations.js';
import { getSearchModelState, searchMenuItems, SEARCH_MODEL_ID, warmSearchModel } from './search.js';

const { Pool } = pg;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET;
const domains = (process.env.ALLOWED_STUDENT_DOMAINS || 'cb.students.amrita.edu')
  .split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean);

if (!domains.length || domains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain))) {
  throw new Error('ALLOWED_STUDENT_DOMAINS must be a comma-separated list of valid exact domains.');
}
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters.');
}
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  throw new Error('DATABASE_URL and REDIS_URL are required.');
}
if (process.env.NODE_ENV === 'production' && !process.env.SMTP_HOST) {
  throw new Error('SMTP_HOST is required in production so sign-in codes can be delivered.');
}

const roleEmails = parseRoleEmails(process.env.ROLE_EMAILS);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DATABASE_POOL_MAX || 20) });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (error) => console.error('Redis connection error:', error.message));
await redis.connect();
await runMigrations(pool, path.join(root, 'migrations'));

const cache = createCache(redis);
warmSearchModel().catch((error) => {
  console.error('Could not preload the campus dish search model:', error);
});
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || '127.0.0.1',
  port: Number(process.env.SMTP_PORT || 1025),
  secure: process.env.SMTP_SECURE === 'true',
  requireTLS: process.env.NODE_ENV === 'production',
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  } : undefined,
});
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://unpkg.com https://*.tile.openstreetmap.org",
    "connect-src 'self'",
  ].join('; '));
  next();
});
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    const expectedOrigin = process.env.APP_ORIGIN || `http://localhost:${port}`;
    if (origin && new URL(origin).origin !== new URL(expectedOrigin).origin) {
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    }
    if (req.get('x-requested-with') !== 'CampusBite') {
      return res.status(403).json({ error: 'A same-site request header is required.' });
    }
  }
  next();
});

function safeEqualHex(value, expected) {
  return secretsMatch(value, expected);
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  const entry = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `campus_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `campus_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

async function authenticate(req, res, next) {
  const token = getCookie(req, 'campus_session');
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  const tokenHash = hashSecret(token, sessionSecret);
  const result = await pool.query(
    `SELECT u.id, u.email, u.role, u.canteen_id
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  if (!result.rowCount) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Your session expired. Sign in again.' });
  }
  req.user = result.rows[0];
  next();
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'This page is not available for your role.' });
    next();
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function enforceRateLimit(key, limit, seconds) {
  const current = Number(await redis.eval(
    "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count",
    { keys: [key], arguments: [String(seconds)] },
  ));
  return current <= limit;
}

app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
app.get('/api/config', (req, res) => res.json({ studentDomains: domains }));
app.get('/health/ready', asyncRoute(async (req, res) => {
  await Promise.all([pool.query('SELECT 1'), redis.ping()]);
  res.json({ status: 'ready' });
}));

app.post('/api/auth/request-code', asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const assignment = configuredRole(email, roleEmails);
  if (!assignment && !isAllowedStudentEmail(email, domains)) {
    return res.status(403).json({ error: `Use your college email ending in @${domains.join(' or @')}.` });
  }
  if (!await enforceRateLimit(`otp-request-ip:${hashSecret(req.ip || 'unknown', sessionSecret)}`, 20, 900)) {
    return res.status(429).json({ error: 'Too many sign-in requests from this network. Try again later.' });
  }
  const rateKey = `otp-request:${hashSecret(email, sessionSecret)}`;
  if (!await enforceRateLimit(rateKey, 3, 900)) {
    return res.status(429).json({ error: 'Too many codes requested. Wait 15 minutes and try again.' });
  }

  await pool.query('DELETE FROM auth_challenges WHERE expires_at <= now()');
  const otp = createOtp();
  await pool.query(
    `INSERT INTO auth_challenges (email, code_hash, expires_at, attempts, created_at)
     VALUES ($1, $2, now() + interval '10 minutes', 0, now())
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
    [email, hashSecret(otp, sessionSecret)],
  );
  await mailer.sendMail({
    from: process.env.SMTP_FROM || 'CampusBite <no-reply@campusbite.local>',
    to: email,
    subject: 'Your CampusBite sign-in code',
    text: `Your CampusBite sign-in code is ${otp}. It expires in 10 minutes. If you did not request it, ignore this email.`,
  });
  res.json({ message: 'A sign-in code was sent to your college email.' });
}));

app.post('/api/auth/verify-code', asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the email and six-digit code.' });
  }
  if (!await enforceRateLimit(`otp-verify-ip:${hashSecret(req.ip || 'unknown', sessionSecret)}`, 30, 900)) {
    return res.status(429).json({ error: 'Too many verification attempts from this network. Try again later.' });
  }
  if (!await enforceRateLimit(`otp-verify:${hashSecret(email, sessionSecret)}`, 10, 900)) {
    return res.status(429).json({ error: 'Too many attempts. Request a new code later.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const challenge = await client.query(
      'SELECT code_hash, attempts FROM auth_challenges WHERE email = $1 AND expires_at > now() FOR UPDATE',
      [email],
    );
    if (!challenge.rowCount || challenge.rows[0].attempts >= 5 ||
      !safeEqualHex(hashSecret(code, sessionSecret), challenge.rows[0].code_hash)) {
      if (challenge.rowCount) {
        await client.query('UPDATE auth_challenges SET attempts = attempts + 1 WHERE email = $1', [email]);
      }
      await client.query('COMMIT');
      return res.status(401).json({ error: 'That code is invalid or expired. Request a new one and try again.' });
    }
    const assignment = configuredRole(email, roleEmails);
    if (!assignment && !isAllowedStudentEmail(email, domains)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This account is not permitted to sign in.' });
    }
    const role = assignment?.role || 'student';
    const canteenId = assignment?.canteenId || null;
    const userResult = await client.query(
      `INSERT INTO users (email, role, canteen_id) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, canteen_id = EXCLUDED.canteen_id
       RETURNING id, email, role, canteen_id`,
      [email, role, canteenId],
    );
    await client.query('DELETE FROM auth_challenges WHERE email = $1', [email]);
    const token = randomBytes(32).toString('hex');
    await client.query('DELETE FROM sessions WHERE expires_at <= now()');
    await client.query(
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval \'7 days\')',
      [hashSecret(token, sessionSecret), userResult.rows[0].id],
    );
    await client.query('COMMIT');
    setSessionCookie(res, token);
    res.json({ user: userResult.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }));
app.post('/api/auth/logout', authenticate, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [
    hashSecret(getCookie(req, 'campus_session'), sessionSecret),
  ]);
  clearSessionCookie(res);
  res.json({ message: 'Signed out.' });
}));

app.get('/api/menu', authenticate, asyncRoute(async (req, res) => {
  if (req.user.role === 'canteen') {
    const { rows } = await pool.query(
      `SELECT id::int AS id, canteen_id, name, category, price_paise, is_veg, available, rating
       FROM menu_items WHERE canteen_id = $1 ORDER BY name`,
      [req.user.canteen_id],
    );
    return res.json({ items: rows });
  }
  res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=30');
  const cached = await cache.get('menu:available');
  if (cached) return res.json({ items: cached });
  const { rows } = await pool.query(
    `SELECT id::int AS id, canteen_id, name, category, price_paise, is_veg, available, rating
     FROM menu_items WHERE available = true ORDER BY canteen_id, name`,
  );
  await cache.set('menu:available', rows, 60);
  res.json({ items: rows });
}));

app.get('/api/search', authenticate, allowRoles('student'), asyncRoute(async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (query.length < 2 || query.length > 120 || !/[\p{L}\p{N}]/u.test(query)) {
    return res.status(400).json({ error: 'Search must contain 2–120 letters or numbers.' });
  }
  if (getSearchModelState() !== 'ready') {
    if (getSearchModelState() === 'failed') {
      warmSearchModel().catch((error) => {
        console.error('Could not retry loading the campus dish search model:', error);
      });
    }
    return res.status(503).json({
      error: getSearchModelState() === 'loading'
        ? 'Smart search is loading its local model. Please try again shortly.'
        : 'Smart search could not load its local model. Please try again shortly.',
    });
  }

  const queryHash = createHash('sha256')
    .update(`${SEARCH_MODEL_ID}:${query.toLocaleLowerCase()}`)
    .digest('hex');
  const cacheKey = `search:results:v2:${queryHash}`;
  const cached = await cache.get(cacheKey);
  if (cached) {
    res.set('Cache-Control', 'private, max-age=30');
    return res.json(cached);
  }

  let menu = await cache.get('menu:available');
  if (!menu) {
    const result = await pool.query(
      `SELECT id::int AS id, canteen_id, name, category, price_paise, is_veg, available, rating
       FROM menu_items WHERE available = true ORDER BY canteen_id, name`,
    );
    menu = result.rows;
    await cache.set('menu:available', menu, 60);
  }
  const result = {
    model: SEARCH_MODEL_ID,
    mode: 'semantic-hybrid',
    items: await searchMenuItems(query, menu),
  };
  await cache.set(cacheKey, result, 60);
  res.set('Cache-Control', 'private, max-age=30');
  res.json(result);
}));

app.get('/api/recommendations', authenticate, allowRoles('student'), asyncRoute(async (req, res) => {
  const now = new Date();
  const campusParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const campusWeekday = campusParts.find((part) => part.type === 'weekday').value;
  const campusHour = campusParts.find((part) => part.type === 'hour').value;
  const cacheKey = `recommendations:${req.user.id}:${campusWeekday}:${campusHour}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);
  const [history, preferences] = await Promise.all([
    pool.query(
      `SELECT menu_item_id, occurred_at, quantity
       FROM demand_history WHERE occurred_at >= now() - interval '28 days'`,
    ),
    pool.query(
      `SELECT DISTINCT oi.menu_item_id
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.student_id = $1 AND o.created_at >= now() - interval '180 days'`,
      [req.user.id],
    ),
  ]);
  const rows = history.rows;
  const preferred = new Set(preferences.rows.map((row) => Number(row.menu_item_id)));
  const scores = predictDemand(rows, now).map((item) => ({
    ...item,
    predicted_demand: Math.round(item.predicted_demand * (preferred.has(item.menu_item_id) ? 1.15 : 1) * 10) / 10,
  }));
  const { rows: menu } = await pool.query(
    `SELECT id::int AS id, canteen_id, name, category, price_paise, is_veg, rating
     FROM menu_items WHERE available = true AND id = ANY($1::bigint[])`,
    [scores.map((item) => item.menu_item_id)],
  );
  const menuById = new Map(menu.map((item) => [Number(item.id), item]));
  const result = {
    generated_at: now.toISOString(),
    model: 'weekday-hour seasonal demand (28-day lookback)',
    items: scores.slice(0, 4).flatMap((score) => {
      const item = menuById.get(score.menu_item_id);
      return item ? [{ ...item, predicted_demand: score.predicted_demand, confidence: score.confidence }] : [];
    }),
  };
  await cache.set(cacheKey, result, 300);
  res.json(result);
}));

app.post('/api/orders', authenticate, allowRoles('student'), asyncRoute(async (req, res) => {
  const { items, gate } = req.body || {};
  if (!Array.isArray(items) || items.length < 1 || items.length > 20 || !GATES[gate]) {
    return res.status(400).json({ error: 'Choose menu items and a campus delivery gate.' });
  }
  const quantities = new Map();
  for (const row of items) {
    const id = Number(row?.id);
    const quantity = Number(row?.quantity);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
      return res.status(400).json({ error: 'Each item must have a valid ID and a quantity from 1 to 20.' });
    }
    quantities.set(id, (quantities.get(id) || 0) + quantity);
  }
  if ([...quantities.values()].some((quantity) => quantity > 20)) {
    return res.status(400).json({ error: 'An item quantity cannot exceed 20.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: menu } = await client.query(
      'SELECT id, canteen_id, name, price_paise FROM menu_items WHERE id = ANY($1::bigint[]) AND available = true FOR SHARE',
      [[...quantities.keys()]],
    );
    if (menu.length !== quantities.size) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'One or more items are unavailable. Refresh the menu and try again.' });
    }
    if (new Set(menu.map((item) => item.canteen_id)).size !== 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Please place separate orders for different canteens.' });
    }
    const subtotal = menu.reduce((sum, item) => sum + item.price_paise * quantities.get(Number(item.id)), 0);
    const total = subtotal + 2700;
    const orderResult = await client.query(
      'INSERT INTO orders (student_id, canteen_id, gate, total_paise) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.user.id, menu[0].canteen_id, gate, total],
    );
    for (const item of menu) {
      await client.query(
        'INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price_paise, quantity) VALUES ($1, $2, $3, $4, $5)',
        [orderResult.rows[0].id, item.id, item.name, item.price_paise, quantities.get(Number(item.id))],
      );
      await client.query(
        'INSERT INTO demand_history (menu_item_id, occurred_at, quantity, source) VALUES ($1, now(), $2, $3)',
        [item.id, quantities.get(Number(item.id)), 'order'],
      );
    }
    await client.query("DELETE FROM demand_history WHERE occurred_at < now() - interval '28 days'");
    await client.query('COMMIT');
    res.status(201).json({ order_id: orderResult.rows[0].id, total_paise: total });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

function orderScope(user) {
  if (user.role === 'student') return { sql: 'o.student_id = $1', values: [user.id] };
  if (user.role === 'canteen') return { sql: 'o.canteen_id = $1', values: [user.canteen_id] };
  if (user.role === 'rider') return { sql: 'o.rider_id = $1', values: [user.id] };
  return { sql: 'true', values: [] };
}

app.get('/api/orders', authenticate, allowRoles('student', 'canteen', 'rider', 'admin'), asyncRoute(async (req, res) => {
  const scope = orderScope(req.user);
  const { rows } = await pool.query(
    `SELECT o.id, o.canteen_id, o.rider_id, o.gate, o.status, o.total_paise, o.created_at, o.updated_at,
       COALESCE(json_agg(json_build_object('name', oi.item_name, 'quantity', oi.quantity, 'price_paise', oi.unit_price_paise))
         FILTER (WHERE oi.order_id IS NOT NULL), '[]'::json) AS items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE ${scope.sql}
     GROUP BY o.id
     ORDER BY o.created_at DESC LIMIT 100`,
    scope.values,
  );
  res.json({ orders: rows });
}));

app.patch('/api/orders/:id/status', authenticate, allowRoles('canteen', 'rider'), asyncRoute(async (req, res) => {
  const transitions = req.user.role === 'canteen'
    ? { ACCEPTED: 'PLACED', PREPARING: 'ACCEPTED', READY: 'PREPARING' }
    : { PICKED_UP: 'ASSIGNED', OUT_FOR_DELIVERY: 'PICKED_UP', DELIVERED: 'OUT_FOR_DELIVERY' };
  const { status } = req.body || {};
  const expected = transitions[status];
  if (!expected) return res.status(400).json({ error: 'That status transition is not available.' });
  const params = req.user.role === 'canteen'
    ? [req.params.id, req.user.canteen_id, expected, status]
    : [req.params.id, req.user.id, expected, status];
  const condition = req.user.role === 'canteen'
    ? 'id = $1 AND canteen_id = $2 AND status = $3'
    : 'id = $1 AND rider_id = $2 AND status = $3';
  const result = await pool.query(
    `UPDATE orders SET status = $4, updated_at = now() WHERE ${condition} RETURNING id`,
    params,
  );
  if (!result.rowCount) return res.status(409).json({ error: 'This order cannot be updated from its current state.' });
  res.json({ message: 'Order status updated.' });
}));

app.post('/api/orders/:id/assign', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const riderId = req.body?.rider_id;
  if (typeof riderId !== 'string') return res.status(400).json({ error: 'Choose a rider.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rider = await client.query('SELECT id FROM users WHERE id = $1 AND role = $2 FOR UPDATE', [riderId, 'rider']);
    const activeOrder = rider.rowCount ? await client.query(
      `SELECT id FROM orders WHERE rider_id = $1 AND status IN ('ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY') LIMIT 1`,
      [riderId],
    ) : { rowCount: 0 };
    const result = rider.rowCount && !activeOrder.rowCount ? await client.query(
      `UPDATE orders SET rider_id = $2, status = 'ASSIGNED', updated_at = now()
       WHERE id = $1 AND status = 'READY' RETURNING id`,
      [req.params.id, riderId],
    ) : { rowCount: 0 };
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Order is not ready or the selected rider is unavailable.' });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.json({ message: 'Rider assigned.' });
}));

app.get('/api/riders', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email,
       EXISTS (SELECT 1 FROM orders o WHERE o.rider_id = u.id
         AND o.status IN ('ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY')) AS busy
     FROM users u WHERE u.role = 'rider' ORDER BY u.email`,
  );
  res.json({ riders: rows });
}));

app.patch('/api/menu/:id/availability', authenticate, allowRoles('canteen'), asyncRoute(async (req, res) => {
  if (typeof req.body?.available !== 'boolean') return res.status(400).json({ error: 'Availability must be true or false.' });
  const result = await pool.query(
    'UPDATE menu_items SET available = $3 WHERE id = $1 AND canteen_id = $2 RETURNING id',
    [req.params.id, req.user.canteen_id, req.body.available],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Menu item not found for this canteen.' });
  await cache.deleteByPrefix('menu:');
  await cache.deleteByPrefix('recommendations:');
  await cache.deleteByPrefix('search:');
  res.json({ message: 'Menu availability updated.' });
}));

app.post('/api/menu', authenticate, allowRoles('canteen'), asyncRoute(async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const category = req.body?.category;
  const priceRupees = Number(req.body?.price_rupees);
  const isVeg = req.body?.is_veg;
  if (name.length < 2 || name.length > 80 ||
    !['Rolls', 'Meals', 'Snacks', 'Drinks'].includes(category) ||
    !Number.isSafeInteger(priceRupees) || priceRupees < 1 || priceRupees > 10000 ||
    typeof isVeg !== 'boolean') {
    return res.status(400).json({ error: 'Enter a dish name, category, whole-rupee price, and dietary type.' });
  }
  const result = await pool.query(
    `INSERT INTO menu_items (canteen_id, name, category, price_paise, is_veg)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id::int AS id, canteen_id, name, category, price_paise, is_veg, available, rating`,
    [req.user.canteen_id, name, category, priceRupees * 100, isVeg],
  );
  await cache.deleteByPrefix('menu:');
  await cache.deleteByPrefix('recommendations:');
  await cache.deleteByPrefix('search:');
  res.status(201).json({ item: result.rows[0] });
}));

app.get('/api/analytics', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const [totals, fleet] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total_orders,
      count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
      count(*) FILTER (WHERE status = 'READY')::int AS ready
      FROM orders`),
    pool.query(`SELECT count(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM orders o WHERE o.rider_id = u.id AND o.status IN ('ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY')
    ))::int AS available, count(*)::int AS total_riders FROM users u WHERE u.role = 'rider'`),
  ]);
  res.json({ ...totals.rows[0], ...fleet.rows[0] });
}));

app.use(express.static(path.join(root, 'public'), {
  index: 'index.html',
  maxAge: '10m',
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-store');
    else if (process.env.NODE_ENV !== 'production') res.setHeader('Cache-Control', 'no-store');
  },
}));
app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules', 'leaflet', 'dist'), {
  maxAge: '1d',
  immutable: false,
}));
app.get('/{*path}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(root, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error('Request failed:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`CampusBite listening on port ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await Promise.all([pool.end(), redis.quit()]);
      process.exit(0);
    });
  });
}
