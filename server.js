const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fxpro_secret_2025';

// ---- NOWPayments config ----
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://web-production-079d9.up.railway.app';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://fxproinvestment.com';

// ---- PostgreSQL connection ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ---- Create tables on startup (safe to re-run) ----
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      email         TEXT UNIQUE,
      phone         TEXT,
      password      TEXT,
      referral_code TEXT,
      referred_by   TEXT,
      balance       NUMERIC DEFAULT 0,
      total_profit  NUMERIC DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS packages (
      id           TEXT PRIMARY KEY,
      user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
      amount       NUMERIC,
      daily_profit NUMERIC DEFAULT 0,
      total_profit NUMERIC DEFAULT 0,
      active       BOOLEAN DEFAULT TRUE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id         TEXT PRIMARY KEY,
      user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
      amount     NUMERIC,
      status     TEXT DEFAULT 'waiting',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database tables ready');
}

// ---- Helpers ----
function shapePackage(row) {
  return {
    id: row.id,
    amount: Number(row.amount),
    dailyProfit: Number(row.daily_profit),
    totalProfit: Number(row.total_profit),
    createdAt: row.created_at,
    active: row.active,
  };
}

async function getUserWithPackages(userId) {
  const u = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!u.rows.length) return null;
  const user = u.rows[0];
  const pkgs = await pool.query(
    'SELECT * FROM packages WHERE user_id = $1 ORDER BY created_at ASC',
    [userId]
  );
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    referralCode: user.referral_code,
    referredBy: user.referred_by,
    balance: Number(user.balance),
    totalProfit: Number(user.total_profit),
    packages: pkgs.rows.map(shapePackage),
    createdAt: user.created_at,
  };
}

// Sort object keys recursively (needed for NOWPayments IPN signature)
function sortObject(obj) {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, key) => {
      acc[key] = sortObject(obj[key]);
      return acc;
    }, {});
  }
  return obj;
}

// ---- Register ----
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, password, referralCode } = req.body;
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length)
      return res.status(400).json({ error: 'Email already exists' });

    const hash = await bcrypt.hash(password, 10);
    const id = Date.now().toString();
    const refCode = 'REF' + Date.now();

    await pool.query(
      `INSERT INTO users (id, name, email, phone, password, referral_code, referred_by, balance, total_profit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,0)`,
      [id, name, email, phone, hash, refCode, referralCode || null]
    );

    const token = jwt.sign({ id }, JWT_SECRET);
    res.json({ token, user: { id, name, email, referralCode: refCode } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Login ----
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!r.rows.length) return res.status(400).json({ error: 'User not found' });
    const user = r.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id }, JWT_SECRET);
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, referralCode: user.referral_code },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Get profile ----
app.get('/api/profile', auth, async (req, res) => {
  try {
    const user = await getUserWithPackages(req.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Add package directly (kept for compatibility) ----
app.post('/api/invest', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    const validAmounts = [100, 250, 500, 1000, 2000, 5000, 10000, 25000];
    if (!validAmounts.includes(amount))
      return res.status(400).json({ error: 'Invalid package amount' });

    const pkgId = Date.now().toString();
    await pool.query(
      `INSERT INTO packages (id, user_id, amount, daily_profit, total_profit, active)
       VALUES ($1,$2,$3,0,0,TRUE)`,
      [pkgId, req.userId, amount]
    );
    res.json({
      message: 'Package added',
      package: { id: pkgId, amount, dailyProfit: 0, totalProfit: 0, active: true },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Create a USDT payment for a package (NOWPayments) ----
app.post('/api/payment/create', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    const validAmounts = [100, 250, 500, 1000, 2000, 5000, 10000, 25000];
    if (!validAmounts.includes(amount))
      return res.status(400).json({ error: 'Invalid package amount' });
    if (!NOWPAYMENTS_API_KEY)
      return res.status(500).json({ error: 'Payment not configured' });

    const orderId = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);

    // Save a pending payment record
    await pool.query(
      `INSERT INTO payments (id, user_id, amount, status) VALUES ($1,$2,$3,'waiting')`,
      [orderId, req.userId, amount]
    );

    // Create hosted invoice at NOWPayments
    const npRes = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: 'usd',
        order_id: orderId,
        order_description: `FX Pro Investment package $${amount}`,
        ipn_callback_url: `${BACKEND_URL}/api/payment/webhook`,
        success_url: `${FRONTEND_URL}/?paid=1`,
        cancel_url: `${FRONTEND_URL}/?cancelled=1`,
      }),
    });

    const data = await npRes.json();
    if (!npRes.ok || !data.invoice_url) {
      console.error('NOWPayments error:', data);
      return res.status(502).json({ error: 'Could not create payment', details: data });
    }

    res.json({ payment_url: data.invoice_url, order_id: orderId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- NOWPayments IPN webhook (payment status updates) ----
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const sig = req.headers['x-nowpayments-sig'];
    if (!NOWPAYMENTS_IPN_SECRET || !sig)
      return res.status(401).json({ error: 'Missing signature' });

    const hmac = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET);
    hmac.update(JSON.stringify(sortObject(req.body)));
    const digest = hmac.digest('hex');
    if (digest !== sig)
      return res.status(401).json({ error: 'Invalid signature' });

    const { order_id, payment_status } = req.body;

    if (payment_status === 'finished' || payment_status === 'confirmed') {
      const p = await pool.query('SELECT * FROM payments WHERE id = $1', [order_id]);
      if (p.rows.length && p.rows[0].status !== 'finished') {
        const pay = p.rows[0];
        const pkgId = Date.now().toString();
        await pool.query(
          `INSERT INTO packages (id, user_id, amount, daily_profit, total_profit, active)
           VALUES ($1,$2,$3,0,0,TRUE)`,
          [pkgId, pay.user_id, pay.amount]
        );
        await pool.query('UPDATE payments SET status = $1 WHERE id = $2', ['finished', order_id]);
        console.log(`Payment ${order_id} finished, package activated for user ${pay.user_id}`);
      }
    } else if (order_id) {
      await pool.query('UPDATE payments SET status = $1 WHERE id = $2', [payment_status, order_id]);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Distribute daily profit (admin) ----
app.post('/api/admin/distribute', async (req, res) => {
  try {
    const { adminKey, rate } = req.body;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });
    if (rate < 1.70 || rate > 2.65)
      return res.status(400).json({ error: 'Invalid rate' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pkgs = await client.query('SELECT * FROM packages WHERE active = TRUE');
      for (const pkg of pkgs.rows) {
        const profit = (Number(pkg.amount) * rate) / 100;
        await client.query(
          'UPDATE packages SET daily_profit = $1, total_profit = total_profit + $1 WHERE id = $2',
          [profit, pkg.id]
        );
        await client.query(
          'UPDATE users SET balance = balance + $1, total_profit = total_profit + $1 WHERE id = $2',
          [profit, pkg.user_id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ message: `Profit distributed at ${rate}%` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Get all users (admin) ----
app.get('/api/admin/users', async (req, res) => {
  try {
    const { adminKey } = req.query;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });

    const users = await pool.query('SELECT id FROM users ORDER BY created_at ASC');
    const result = [];
    for (const row of users.rows) {
      result.push(await getUserWithPackages(row.id));
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Auth middleware ----
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ---- Start server after DB is ready ----
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`FX Pro server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to init database:', err);
    process.exit(1);
  });
