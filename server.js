const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fxpro_secret_2025';

// ---- PostgreSQL connection ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ---- Create tables on startup (runs once, safe to re-run) ----
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
  console.log('Database tables ready');
}

// ---- Helpers to shape data like the old in-memory format ----
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

// ---- Add package (invest) ----
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
