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

// ---- Resend (email) config ----
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = 'FX Pro Investment <noreply@fxproinvestment.com>';

// ---- Referral config ----
const REFERRAL_RATE = 0.07; // 7% commission on every referred deposit (single level)
const REFERRAL_MILESTONES = [
  { count: 5, bonus: 50 },
  { count: 10, bonus: 75 },
  { count: 15, bonus: 150 },
];

// ---- Monthly competition ----
// Ranked by the VOLUME each referrer brings in during the calendar month,
// not by how many people they sign up. Volume-based keeps this a commission
// scheme rather than a recruitment reward, and the cost is capped at the
// prize pool below no matter how big the month gets.
const COMPETITION_PRIZES = [
  { rank: 1, prize: 500 },
  { rank: 2, prize: 300 },
  { rank: 3, prize: 150 },
];
const COMPETITION_MIN_VOLUME = 500; // must bring at least this much to place

// ---- Points & tiers ----
// Points are STATUS ONLY. They are never converted into cash or withdrawable
// balance. That distinction is what keeps this a loyalty programme rather than
// another payment for recruiting people.
const POINTS_PER_DOLLAR_INVESTED = 1;   // $500 package  -> 500 pts
const POINTS_PER_ACTIVE_REFERRAL = 250; // each invitee who actually invests
const POINTS_PER_PACKAGE_OPENED  = 100; // one-off bonus for each new package

const TIERS = [
  { key: 'bronze',   name: 'Bronze',   min: 0,     icon: '🥉', color: '#CD7F32' },
  { key: 'silver',   name: 'Silver',   min: 1000,  icon: '🥈', color: '#BEC8D7' },
  { key: 'gold',     name: 'Gold',     min: 3000,  icon: '🥇', color: '#F5C842' },
  { key: 'platinum', name: 'Platinum', min: 8000,  icon: '💎', color: '#5FE1E6' },
  { key: 'diamond',  name: 'Diamond',  min: 20000, icon: '👑', color: '#B98CFF' },
];

function tierFor(points) {
  let current = TIERS[0];
  for (const t of TIERS) if (points >= t.min) current = t;
  const idx = TIERS.findIndex(t => t.key === current.key);
  const next = TIERS[idx + 1] || null;
  return {
    ...current,
    next: next ? { name: next.name, icon: next.icon, min: next.min } : null,
    pointsToNext: next ? Math.max(0, next.min - points) : 0,
    progress: next
      ? Math.min(100, Math.round(((points - current.min) / (next.min - current.min)) * 100))
      : 100,
  };
}

// ---- Default package catalogue ----
// These are only the seed values. Once the server has run once, the real
// numbers live in the package_settings table and are edited from the admin panel.
const DEFAULT_PACKAGES = [
  { amount: 100,   min: 1.30, max: 2.00, days: 175 },
  { amount: 250,   min: 1.50, max: 2.20, days: 182 },
  { amount: 500,   min: 1.70, max: 2.40, days: 190 },
  { amount: 1000,  min: 1.90, max: 2.60, days: 197 },
  { amount: 2000,  min: 2.10, max: 2.80, days: 205 },
  { amount: 5000,  min: 2.30, max: 3.00, days: 215 },
  { amount: 10000, min: 2.40, max: 3.10, days: 230 },
  { amount: 25000, min: 3.00, max: 5.00, days: 270 },
];
const VALID_AMOUNTS = DEFAULT_PACKAGES.map(p => p.amount);

// In-memory cache of package_settings, refreshed whenever the admin saves.
let PKG_SETTINGS = {};
async function loadPackageSettings() {
  const r = await pool.query('SELECT * FROM package_settings ORDER BY amount ASC');
  const map = {};
  for (const row of r.rows) {
    map[Number(row.amount)] = {
      amount: Number(row.amount),
      minRate: Number(row.min_rate),
      maxRate: Number(row.max_rate),
      durationDays: Number(row.duration_days),
      active: row.active !== false,
    };
  }
  PKG_SETTINGS = map;
  return map;
}

function settingsFor(amount) {
  const a = Number(amount);
  if (PKG_SETTINGS[a]) return PKG_SETTINGS[a];
  const d = DEFAULT_PACKAGES.find(p => p.amount === a) || DEFAULT_PACKAGES[0];
  return { amount: a, minRate: d.min, maxRate: d.max, durationDays: d.days, active: true };
}

function durationFor(amount) {
  return settingsFor(amount).durationDays;
}

// Unique id helper (avoids two packages colliding on the same millisecond)
function makeId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

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
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_id TEXT;`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS pay_address TEXT;`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS pay_amount TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id         TEXT PRIMARY KEY,
      user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
      amount     NUMERIC,
      address    TEXT,
      status     TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Columns for password reset codes
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ;`);
  // Columns + table for referral commissions & milestone bonuses
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_earnings NUMERIC DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS milestone_bonus NUMERIC DEFAULT 0;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_earnings (
      id             TEXT PRIMARY KEY,
      referrer_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
      referred_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
      deposit_amount NUMERIC,
      commission     NUMERIC,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ---- Package duration columns ----
  await pool.query(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS duration_days INTEGER DEFAULT 175;`);
  await pool.query(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS days_left INTEGER DEFAULT 175;`);
  // NEW: the exact moment a package stops earning. This is the source of truth.
  await pool.query(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`);
  // Marks packages created by the admin for testing, so they can be told apart
  // from real, paid packages and kept out of the public leaderboard.
  await pool.query(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE;`);

  // Backfill duration_days for old rows that were created before durations existed
  await pool.query(`
    UPDATE packages SET duration_days = CASE
      WHEN amount >= 25000 THEN 270
      WHEN amount >= 10000 THEN 230
      WHEN amount >= 5000  THEN 215
      WHEN amount >= 2000  THEN 205
      WHEN amount >= 1000  THEN 197
      WHEN amount >= 500   THEN 190
      WHEN amount >= 250   THEN 182
      ELSE 175 END
    WHERE duration_days IS NULL;
  `);

  // Backfill expires_at = created_at + duration_days for any package missing it
  const back = await pool.query(`
    UPDATE packages
       SET expires_at = created_at + (COALESCE(duration_days, 175) || ' days')::interval
     WHERE expires_at IS NULL
    RETURNING id;
  `);
  if (back.rows.length) {
    console.log(`Backfilled expires_at for ${back.rows.length} existing package(s)`);
  }

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_packages_active ON packages(active);`);

  // ---- Package settings: the single source of truth for rates + durations ----
  // Both the public site and the profit distribution read from here, so the
  // admin panel can actually change what investors see and what they get paid.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS package_settings (
      amount        INTEGER PRIMARY KEY,
      min_rate      NUMERIC NOT NULL,
      max_rate      NUMERIC NOT NULL,
      duration_days INTEGER NOT NULL,
      active        BOOLEAN DEFAULT TRUE,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed the defaults once. ON CONFLICT DO NOTHING means your edits are never
  // overwritten on the next deploy.
  for (const d of DEFAULT_PACKAGES) {
    await pool.query(
      `INSERT INTO package_settings (amount, min_rate, max_rate, duration_days, active)
       VALUES ($1,$2,$3,$4,TRUE)
       ON CONFLICT (amount) DO NOTHING`,
      [d.amount, d.min, d.max, d.days]
    );
  }

  // ---- Payout log: one row per calendar day. ----
  // The UNIQUE primary key is what makes automatic payouts safe: if the job
  // runs twice (restart, two instances, manual click), the second INSERT
  // fails and nobody gets paid twice.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payout_log (
      pay_date       DATE PRIMARY KEY,
      packages_paid  INTEGER,
      total_paid     NUMERIC,
      mode           TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ---- Competition winners: one row per month per winner ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS competition_winners (
      id          TEXT PRIMARY KEY,
      month       TEXT NOT NULL,
      user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
      rank        INTEGER,
      volume      NUMERIC,
      prize       NUMERIC,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (month, rank)
    );
  `);

  console.log('Database tables ready');
}

// ---- Expire any package whose end date has passed ----
// Safe to call as often as we like. This is what makes durations reliable:
// nothing depends on an admin remembering to click a button every day.
async function expireDuePackages(client) {
  const q = client || pool;
  const done = await q.query(`
    UPDATE packages
       SET active = FALSE, days_left = 0, daily_profit = 0
     WHERE active = TRUE AND expires_at IS NOT NULL AND expires_at <= NOW()
    RETURNING id, user_id, amount;
  `);
  if (done.rows.length) {
    for (const r of done.rows) {
      console.log(`Package ${r.id} ($${r.amount}) completed for user ${r.user_id}`);
    }
  }
  return done.rows.length;
}

// ---- Keep days_left in sync with expires_at (display only) ----
async function syncDaysLeft(client) {
  const q = client || pool;
  await q.query(`
    UPDATE packages
       SET days_left = GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - NOW())) / 86400))
     WHERE active = TRUE AND expires_at IS NOT NULL;
  `);
}

// ---- Helpers ----
function daysLeftFrom(expiresAt) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86400000);
}

function shapePackage(row) {
  const duration = row.duration_days != null ? Number(row.duration_days) : durationFor(row.amount);
  const computed = daysLeftFrom(row.expires_at);
  const daysLeft = computed != null
    ? computed
    : (row.days_left != null ? Number(row.days_left) : duration);
  const isActive = row.active && daysLeft > 0;
  return {
    id: row.id,
    amount: Number(row.amount),
    dailyProfit: isActive ? Number(row.daily_profit) : 0,
    totalProfit: Number(row.total_profit),
    createdAt: row.created_at,
    active: isActive,
    status: isActive ? 'active' : 'completed',
    durationDays: duration,
    daysLeft: daysLeft,
    expiresAt: row.expires_at,
    isTest: !!row.is_test,
    progress: duration > 0
      ? Math.min(100, Math.round(((duration - daysLeft) / duration) * 100))
      : 0,
  };
}

async function countActiveReferrals(client, userId) {
  const uc = await client.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
  if (!uc.rows.length) return 0;
  const code = uc.rows[0].referral_code;
  const r = await client.query(
    `SELECT COUNT(DISTINCT u.id) AS c
     FROM users u
     JOIN packages p ON p.user_id = u.id
     WHERE u.referred_by = $1`,
    [code]
  );
  return Number(r.rows[0].c || 0);
}

async function getUserWithPackages(userId) {
  const u = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!u.rows.length) return null;
  const user = u.rows[0];
  const pkgs = await pool.query(
    'SELECT * FROM packages WHERE user_id = $1 ORDER BY created_at ASC',
    [userId]
  );
  const invited = await pool.query(
    'SELECT COUNT(*) AS c FROM users WHERE referred_by = $1',
    [user.referral_code]
  );
  const activeRef = await pool.query(
    `SELECT COUNT(DISTINCT u.id) AS c FROM users u
     JOIN packages p ON p.user_id = u.id WHERE u.referred_by = $1`,
    [user.referral_code]
  );
  const shaped = pkgs.rows.map(shapePackage);

  // ---- points (derived, never stored, never cash) ----
  const realPkgs = pkgs.rows.filter(p => !p.is_test);
  const investedTotal = realPkgs.reduce((a, p) => a + Number(p.amount), 0);
  const activeRefCount = Number(activeRef.rows[0].c || 0);

  const ptsInvested = Math.round(investedTotal * POINTS_PER_DOLLAR_INVESTED);
  const ptsPackages = realPkgs.length * POINTS_PER_PACKAGE_OPENED;
  const ptsReferral = activeRefCount * POINTS_PER_ACTIVE_REFERRAL;
  const totalPoints = ptsInvested + ptsPackages + ptsReferral;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    referralCode: user.referral_code,
    referredBy: user.referred_by,
    balance: Number(user.balance),
    totalProfit: Number(user.total_profit),
    referralEarnings: Number(user.referral_earnings || 0),
    milestoneBonus: Number(user.milestone_bonus || 0),
    invitedCount: Number(invited.rows[0].c || 0),
    activeReferrals: Number(activeRef.rows[0].c || 0),
    packages: shaped,
    activePackages: shaped.filter(p => p.active).length,
    totalInvested: investedTotal,
    points: {
      total: totalPoints,
      fromInvestment: ptsInvested,
      fromPackages: ptsPackages,
      fromReferrals: ptsReferral,
      rules: {
        perDollar: POINTS_PER_DOLLAR_INVESTED,
        perPackage: POINTS_PER_PACKAGE_OPENED,
        perReferral: POINTS_PER_ACTIVE_REFERRAL,
      },
    },
    tier: tierFor(totalPoints),
    createdAt: user.created_at,
  };
}

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

// ---- Send an email via Resend ----
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY missing - cannot send email');
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Resend error:', data);
      return false;
    }
    return true;
  } catch (e) {
    console.error('sendEmail failed:', e);
    return false;
  }
}

// ---- Pay referral commission + milestone bonuses (inside a transaction) ----
async function payReferral(client, referredUserId, depositAmount) {
  const ru = await client.query('SELECT referred_by FROM users WHERE id = $1', [referredUserId]);
  const referrerCode = ru.rows.length ? ru.rows[0].referred_by : null;
  if (!referrerCode) return;

  const rr = await client.query('SELECT id FROM users WHERE referral_code = $1', [referrerCode]);
  if (!rr.rows.length) return;
  const referrerId = rr.rows[0].id;
  if (referrerId === referredUserId) return;

  const commission = Number(depositAmount) * REFERRAL_RATE;
  const cid = makeId('RE');
  await client.query(
    `INSERT INTO referral_earnings (id, referrer_id, referred_id, deposit_amount, commission)
     VALUES ($1,$2,$3,$4,$5)`,
    [cid, referrerId, referredUserId, depositAmount, commission]
  );
  await client.query(
    'UPDATE users SET balance = balance + $1, referral_earnings = referral_earnings + $1 WHERE id = $2',
    [commission, referrerId]
  );

  const activeCount = await countActiveReferrals(client, referrerId);
  const paidRow = await client.query('SELECT milestone_bonus FROM users WHERE id = $1', [referrerId]);
  const alreadyPaid = Number(paidRow.rows[0].milestone_bonus || 0);

  let totalDue = 0;
  for (const m of REFERRAL_MILESTONES) {
    if (activeCount >= m.count) totalDue += m.bonus;
  }
  const toPay = totalDue - alreadyPaid;
  if (toPay > 0) {
    await client.query(
      'UPDATE users SET balance = balance + $1, milestone_bonus = milestone_bonus + $1 WHERE id = $2',
      [toPay, referrerId]
    );
    console.log(`Milestone bonus $${toPay} paid to referrer ${referrerId} (active refs: ${activeCount})`);
  }

  console.log(`Referral commission $${commission.toFixed(2)} paid to ${referrerId} for deposit ${depositAmount}`);
}

// ---- Create a package row (shared by /api/invest and the payment webhook) ----
async function createPackage(client, userId, amount, isTest = false) {
  const pkgId = makeId('PK');
  const dur = durationFor(amount);
  const r = await client.query(
    `INSERT INTO packages
       (id, user_id, amount, daily_profit, total_profit, active, duration_days, days_left, expires_at, is_test)
     VALUES ($1,$2,$3,0,0,TRUE,$4::int,$4::int, NOW() + ($4::int * INTERVAL '1 day'), $5)
     RETURNING *`,
    [pkgId, userId, amount, dur, isTest]
  );
  return shapePackage(r.rows[0]);
}

// ---- Public: package catalogue (rates + durations) ----
// index.html reads this on load, so whatever the admin saves is what investors see.
app.get('/api/packages', async (req, res) => {
  try {
    const map = await loadPackageSettings();
    const list = Object.values(map)
      .filter(p => p.active)
      .sort((a, b) => a.amount - b.amount)
      .map(p => ({
        amount: p.amount,
        minRate: p.minRate,
        maxRate: p.maxRate,
        durationDays: p.durationDays,
      }));
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Admin: read every package setting (including disabled ones) ----
app.get('/api/admin/settings', async (req, res) => {
  try {
    const { adminKey } = req.query;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });
    const map = await loadPackageSettings();
    res.json(Object.values(map).sort((a, b) => a.amount - b.amount));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + (e.message || e) });
  }
});

// ---- Admin: update one package's rates / duration / visibility ----
// body: { adminKey, amount, minRate, maxRate, durationDays, active }
app.post('/api/admin/settings', async (req, res) => {
  try {
    const { adminKey, amount, minRate, maxRate, durationDays, active } = req.body;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });

    const amt = Number(amount);
    if (!VALID_AMOUNTS.includes(amt))
      return res.status(400).json({ error: 'Invalid package amount' });

    const min = Number(minRate);
    const max = Number(maxRate);
    const dur = Number(durationDays);

    if (!isFinite(min) || !isFinite(max) || min <= 0 || max <= 0)
      return res.status(400).json({ error: 'Rates must be positive numbers' });
    if (min > max)
      return res.status(400).json({ error: 'Min rate cannot be greater than max rate' });
    if (max > 10)
      return res.status(400).json({ error: 'Max daily rate above 10% is not allowed' });
    if (!Number.isInteger(dur) || dur < 1 || dur > 1000)
      return res.status(400).json({ error: 'Duration must be between 1 and 1000 days' });

    await pool.query(
      `UPDATE package_settings
          SET min_rate = $2, max_rate = $3, duration_days = $4, active = $5, updated_at = NOW()
        WHERE amount = $1`,
      [amt, min, max, dur, active !== false]
    );

    await loadPackageSettings();
    console.log(`ADMIN updated package $${amt}: ${min}%-${max}%, ${dur} days, active=${active !== false}`);

    res.json({ message: `Package $${amt} updated`, setting: settingsFor(amt) });
  } catch (e) {
    console.error('settings update failed:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || e) });
  }
});

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

    let referredBy = null;
    if (referralCode) {
      const rc = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
      if (rc.rows.length) referredBy = referralCode;
    }

    await pool.query(
      `INSERT INTO users (id, name, email, phone, password, referral_code, referred_by, balance, total_profit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,0)`,
      [id, name, email, phone, hash, refCode, referredBy]
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

// ---- Forgot password ----
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const r = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);

    if (r.rows.length) {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 15 * 60 * 1000);
      await pool.query(
        'UPDATE users SET reset_code = $1, reset_expires = $2 WHERE email = $3',
        [code, expires, email]
      );

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px">
          <h2 style="color:#0a1f44;margin:0 0 8px">FX Pro Investment</h2>
          <p style="color:#333;font-size:15px">You requested to reset your password. Use the verification code below:</p>
          <div style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#0a1f44;text-align:center;padding:16px 0">${code}</div>
          <p style="color:#666;font-size:13px">This code will expire in 15 minutes. If you did not request this, you can safely ignore this email.</p>
        </div>`;
      await sendEmail(email, 'Your FX Pro password reset code', html);
    }

    res.json({ message: 'If an account with that email exists, a reset code has been sent.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Reset password ----
app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword)
      return res.status(400).json({ error: 'Email, code and new password are required' });
    if (String(newPassword).length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const r = await pool.query(
      'SELECT reset_code, reset_expires FROM users WHERE email = $1',
      [email]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Invalid code' });

    const row = r.rows[0];
    if (!row.reset_code || row.reset_code !== String(code).trim())
      return res.status(400).json({ error: 'Invalid code' });
    if (!row.reset_expires || new Date(row.reset_expires) < new Date())
      return res.status(400).json({ error: 'Code has expired. Please request a new one.' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password = $1, reset_code = NULL, reset_expires = NULL WHERE email = $2',
      [hash, email]
    );

    res.json({ message: 'Password has been reset successfully. You can now log in.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Get profile ----
app.get('/api/profile', auth, async (req, res) => {
  try {
    await expireDuePackages();
    const user = await getUserWithPackages(req.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- My referrals (user) ----
// Shows the person who they invited and what each one earned them.
// Names and emails are partially masked: the referrer does not need the full
// contact details of everyone in their downline, and the invitee did not agree
// to share them.
app.get('/api/referrals', auth, async (req, res) => {
  try {
    const me = await pool.query(
      'SELECT referral_code, referral_earnings, milestone_bonus FROM users WHERE id = $1',
      [req.userId]
    );
    if (!me.rows.length) return res.status(404).json({ error: 'Not found' });

    const code = me.rows[0].referral_code;

    // everyone who signed up with my code + what they have earned me
    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.created_at,
              COUNT(DISTINCT p.id) FILTER (WHERE p.is_test = FALSE) AS pkg_count,
              COALESCE(SUM(DISTINCT p.amount) FILTER (WHERE p.is_test = FALSE), 0) AS invested,
              COALESCE((
                SELECT SUM(re.commission) FROM referral_earnings re
                 WHERE re.referrer_id = $2 AND re.referred_id = u.id
              ), 0) AS commission
         FROM users u
         LEFT JOIN packages p ON p.user_id = u.id
        WHERE u.referred_by = $1
        GROUP BY u.id, u.name, u.email, u.created_at
        ORDER BY u.created_at DESC`,
      [code, req.userId]
    );

    const maskEmail = (e) => {
      if (!e || !e.includes('@')) return '—';
      const [a, b] = e.split('@');
      const head = a.slice(0, 1);
      return head + '•••@' + b;
    };
    const firstName = (n) => {
      const t = (n || 'User').trim().split(/\s+/);
      return t[0] + (t[1] ? ' ' + t[1][0] + '.' : '');
    };

    const list = r.rows.map(row => ({
      name: firstName(row.name),
      email: maskEmail(row.email),
      joinedAt: row.created_at,
      invested: Number(row.invested || 0),
      hasInvested: Number(row.pkg_count || 0) > 0,
      commission: Number(row.commission || 0),
    }));

    const activeCount = list.filter(x => x.hasInvested).length;

    // what the next milestone is worth
    let nextMilestone = null;
    for (const m of REFERRAL_MILESTONES) {
      if (activeCount < m.count) {
        nextMilestone = { count: m.count, bonus: m.bonus, remaining: m.count - activeCount };
        break;
      }
    }

    res.json({
      referralCode: code,
      referralRate: REFERRAL_RATE * 100,
      invitedCount: list.length,
      activeCount,
      totalCommission: Number(me.rows[0].referral_earnings || 0),
      milestoneBonus: Number(me.rows[0].milestone_bonus || 0),
      totalEarned:
        Number(me.rows[0].referral_earnings || 0) + Number(me.rows[0].milestone_bonus || 0),
      nextMilestone,
      milestones: REFERRAL_MILESTONES,
      referrals: list,
    });
  } catch (e) {
    console.error('referrals failed:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || e) });
  }
});

// ---- Monthly competition helpers ----
function monthKey(d) {
  return (d || new Date()).toISOString().slice(0, 7); // YYYY-MM
}

function monthEnd(d) {
  const now = d || new Date();
  // first instant of next month, in UTC
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// Volume each referrer brought in during a given month.
async function competitionStandings(month) {
  const m = month || monthKey();
  const r = await pool.query(
    `SELECT re.referrer_id AS id,
            u.name,
            SUM(re.deposit_amount) AS volume,
            COUNT(DISTINCT re.referred_id) AS investors
       FROM referral_earnings re
       JOIN users u ON u.id = re.referrer_id
      WHERE to_char(re.created_at, 'YYYY-MM') = $1
      GROUP BY re.referrer_id, u.name
     HAVING SUM(re.deposit_amount) >= $2
      ORDER BY volume DESC, investors DESC
      LIMIT 20`,
    [m, COMPETITION_MIN_VOLUME]
  );

  return r.rows.map((row, i) => {
    const name = (row.name || 'User').trim().split(/\s+/);
    const display = name[0] + (name[1] ? ' ' + name[1][0] + '.' : '');
    const prizeRow = COMPETITION_PRIZES.find(p => p.rank === i + 1);
    return {
      rank: i + 1,
      userId: row.id,
      name: display,
      volume: Number(row.volume),
      investors: Number(row.investors),
      prize: prizeRow ? prizeRow.prize : 0,
    };
  });
}

// ---- Public/user: current month's competition ----
app.get('/api/competition', async (req, res) => {
  try {
    const month = monthKey();
    const standings = await competitionStandings(month);

    // if the caller is logged in, tell them where they stand
    let me = null;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const mine = standings.find(s => s.userId === decoded.id);
        if (mine) {
          me = { rank: mine.rank, volume: mine.volume, prize: mine.prize };
        } else {
          const v = await pool.query(
            `SELECT COALESCE(SUM(deposit_amount),0) AS v
               FROM referral_earnings
              WHERE referrer_id = $1 AND to_char(created_at,'YYYY-MM') = $2`,
            [decoded.id, month]
          );
          me = { rank: null, volume: Number(v.rows[0].v || 0), prize: 0 };
        }
      } catch (e) { /* not logged in - fine */ }
    }

    const endsAt = monthEnd();
    const msLeft = endsAt.getTime() - Date.now();

    res.json({
      month,
      prizes: COMPETITION_PRIZES,
      minVolume: COMPETITION_MIN_VOLUME,
      endsAt: endsAt.toISOString(),
      daysLeft: Math.max(0, Math.ceil(msLeft / 86400000)),
      standings: standings.map(({ userId, ...rest }) => rest), // don't expose user ids
      me,
    });
  } catch (e) {
    console.error('competition failed:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || e) });
  }
});

// ---- Past winners ----
app.get('/api/competition/winners', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT w.month, w.rank, w.volume, w.prize, u.name
         FROM competition_winners w
         LEFT JOIN users u ON u.id = w.user_id
        ORDER BY w.month DESC, w.rank ASC
        LIMIT 30`
    );
    res.json(r.rows.map(row => {
      const n = (row.name || 'User').trim().split(/\s+/);
      return {
        month: row.month,
        rank: row.rank,
        name: n[0] + (n[1] ? ' ' + n[1][0] + '.' : ''),
        volume: Number(row.volume),
        prize: Number(row.prize),
      };
    }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Admin: settle a month and pay the winners ----
// body: { adminKey, month }   month = 'YYYY-MM' (defaults to last month)
// Safe to call twice: the UNIQUE(month, rank) key blocks a second payout.
app.post('/api/admin/competition/settle', async (req, res) => {
  try {
    const { adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });

    let month = req.body.month;
    if (!month) {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() - 1);
      month = monthKey(d);
    }
    if (!/^\d{4}-\d{2}$/.test(month))
      return res.status(400).json({ error: 'Month must look like 2026-07' });

    const already = await pool.query('SELECT 1 FROM competition_winners WHERE month = $1 LIMIT 1', [month]);
    if (already.rows.length)
      return res.status(409).json({ error: `${month} has already been settled. Nobody was paid twice.` });

    const standings = await competitionStandings(month);
    const winners = standings.slice(0, COMPETITION_PRIZES.length).filter(w => w.prize > 0);

    if (!winners.length)
      return res.status(400).json({ error: `No one qualified for ${month}.` });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const w of winners) {
        await client.query(
          `INSERT INTO competition_winners (id, month, user_id, rank, volume, prize)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [makeId('CW'), month, w.userId, w.rank, w.volume, w.prize]
        );
        await client.query(
          `UPDATE users SET balance = balance + $1, milestone_bonus = milestone_bonus + $1
            WHERE id = $2`,
          [w.prize, w.userId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const total = winners.reduce((a, w) => a + w.prize, 0);
    console.log(`ADMIN settled competition ${month}: paid $${total} to ${winners.length} winner(s)`);

    res.json({
      message: `${month} settled — $${total} paid to ${winners.length} winner(s)`,
      month,
      totalPaid: total,
      winners: winners.map(({ userId, ...rest }) => rest),
    });
  } catch (e) {
    console.error('settle failed:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || e) });
  }
});

// ---- Leaderboard ----
app.get('/api/leaderboard', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.name,
             COUNT(DISTINCT ref.id) AS referrals,
             COALESCE(u.referral_earnings, 0) + COALESCE(u.milestone_bonus, 0) AS earned
      FROM users u
      JOIN users ref ON ref.referred_by = u.referral_code
      JOIN packages p ON p.user_id = ref.id AND p.is_test = FALSE
      GROUP BY u.id, u.name, u.referral_earnings, u.milestone_bonus
      ORDER BY referrals DESC, earned DESC
      LIMIT 10
    `);
    res.json(r.rows.map((row, i) => {
      const name = (row.name || 'User').trim();
      const parts = name.split(' ');
      const display = parts[0] + (parts[1] ? ' ' + parts[1][0] + '.' : '');
      return {
        rank: i + 1,
        name: display,
        referrals: Number(row.referrals),
        earned: Number(row.earned),
      };
    }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- SECURITY: /api/invest is permanently disabled ----
// This route used to create a package for any logged-in user without payment.
// Anyone with an account could have called it from the browser console and
// granted themselves a $25,000 package for free. Packages are now created in
// exactly two places: the verified NOWPayments webhook, and the admin-only
// grant route below.
app.post('/api/invest', auth, (req, res) => {
  console.warn(`Blocked /api/invest attempt by user ${req.userId}`);
  return res.status(403).json({ error: 'Packages can only be created by completing a payment.' });
});

// ---- Grant a package manually (ADMIN ONLY) ----
// Use this for your own testing, or to activate a package for a user who paid
// outside NOWPayments. Requires ADMIN_KEY - a normal user cannot reach it.
//
// body: { adminKey, email, amount, isTest?, payReferral? }
//   isTest      -> default true. Test packages are excluded from the leaderboard.
//   payReferral -> default false. Set true to also pay the 7% referral commission.
app.post('/api/admin/grant-package', async (req, res) => {
  try {
    const { adminKey, email, amount, isTest, payReferral: doRef } = req.body;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });

    const amt = Number(amount);
    if (!VALID_AMOUNTS.includes(amt))
      return res.status(400).json({ error: 'Invalid package amount' });
    if (!email)
      return res.status(400).json({ error: 'Email is required' });

    const u = await pool.query('SELECT id, name FROM users WHERE email = $1', [String(email).trim()]);
    if (!u.rows.length)
      return res.status(404).json({ error: 'No user with that email' });

    const userId = u.rows[0].id;
    const test = isTest === undefined ? true : !!isTest;

    const client = await pool.connect();
    let pkg;
    try {
      await client.query('BEGIN');
      pkg = await createPackage(client, userId, amt, test);
      if (doRef === true) {
        await payReferral(client, userId, amt);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log(`ADMIN granted ${test ? 'TEST ' : ''}package $${amt} to ${email}`);
    res.json({
      message: `${test ? 'Test package' : 'Package'} of $${amt} granted to ${email}`,
      package: pkg,
    });
  } catch (e) {
    console.error('grant-package failed:', e);
    // admin-only route, so it is safe (and much more useful) to return the real reason
    res.status(500).json({ error: 'Server error: ' + (e.message || e) });
  }
});

// ---- Delete a package (ADMIN ONLY) ----
// Handy for cleaning up test packages when you are done.
// This does NOT claw back profit already added to the user's balance.
app.post('/api/admin/delete-package', async (req, res) => {
  try {
    const { adminKey, packageId } = req.body;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });
    if (!packageId) return res.status(400).json({ error: 'packageId is required' });

    const r = await pool.query('DELETE FROM packages WHERE id = $1 RETURNING id, amount', [packageId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Package not found' });

    console.log(`ADMIN deleted package ${packageId}`);
    res.json({ message: `Package ${packageId} deleted` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Create a USDT payment for a package (NOWPayments) ----
app.post('/api/payment/create', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!VALID_AMOUNTS.includes(Number(amount)))
      return res.status(400).json({ error: 'Invalid package amount' });
    if (!NOWPAYMENTS_API_KEY)
      return res.status(500).json({ error: 'Payment not configured' });

    const orderId = makeId('ORD');

    await pool.query(
      `INSERT INTO payments (id, user_id, amount, status) VALUES ($1,$2,$3,'waiting')`,
      [orderId, req.userId, amount]
    );

    const npRes = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: 'usd',
        pay_currency: 'usdterc20',
        order_id: orderId,
        order_description: `FX Pro Investment package $${amount} (${durationFor(amount)} days)`,
        ipn_callback_url: `${BACKEND_URL}/api/payment/webhook`,
      }),
    });

    const data = await npRes.json();
    if (!npRes.ok || !data.pay_address) {
      console.error('NOWPayments error:', data);
      return res.status(502).json({ error: 'Could not create payment', details: data });
    }

    await pool.query(
      `UPDATE payments SET payment_id = $1, pay_address = $2, pay_amount = $3 WHERE id = $4`,
      [String(data.payment_id), data.pay_address, String(data.pay_amount), orderId]
    );

    res.json({
      order_id: orderId,
      payment_id: data.payment_id,
      pay_address: data.pay_address,
      pay_amount: data.pay_amount,
      pay_currency: data.pay_currency,
      price_amount: amount,
      duration_days: durationFor(amount),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Check payment status ----
app.get('/api/payment/status', auth, async (req, res) => {
  try {
    const { order_id } = req.query;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });
    const r = await pool.query(
      'SELECT status FROM payments WHERE id = $1 AND user_id = $2',
      [order_id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ status: r.rows[0].status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- NOWPayments IPN webhook ----
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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const p = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [order_id]);
        if (p.rows.length && p.rows[0].status !== 'finished') {
          const pay = p.rows[0];
          const pkg = await createPackage(client, pay.user_id, Number(pay.amount));
          await client.query('UPDATE payments SET status = $1 WHERE id = $2', ['finished', order_id]);
          await payReferral(client, pay.user_id, Number(pay.amount));
          console.log(
            `Payment ${order_id} finished. Package ${pkg.id} ($${pkg.amount}) activated for user ${pay.user_id}, ` +
            `runs ${pkg.durationDays} days, ends ${pkg.expiresAt}`
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
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

// ---- Is today a trading day? Mon-Fri in UTC. ----
function isTradingDay(d) {
  const day = (d || new Date()).getUTCDay(); // 0 = Sun, 6 = Sat
  return day >= 1 && day <= 5;
}

function todayKey(d) {
  return (d || new Date()).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// ---- THE payout engine. Used by both the automatic job and the admin button. ----
// `position`: null  -> random rate inside each package's own band
//             0-100 -> that point in each package's band
// `force`:    admin override to pay even on a weekend / even if already paid today
async function runPayout({ position = null, force = false, mode = 'auto' } = {}) {
  const date = todayKey();

  if (!force && !isTradingDay()) {
    return { skipped: true, reason: 'weekend', date };
  }

  await loadPackageSettings();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Claim today. If another run already claimed it, this throws and we bail
    // out — that is the whole point. No double payouts, ever.
    if (!force) {
      try {
        await client.query(
          `INSERT INTO payout_log (pay_date, packages_paid, total_paid, mode)
           VALUES ($1, 0, 0, $2)`,
          [date, mode]
        );
      } catch (e) {
        await client.query('ROLLBACK');
        return { skipped: true, reason: 'already_paid_today', date };
      }
    }

    // close out anything that reached its end date
    const completed = await expireDuePackages(client);

    // pay only packages still inside their duration
    const pkgs = await client.query(
      `SELECT * FROM packages
        WHERE active = TRUE
          AND (expires_at IS NULL OR expires_at > NOW())
        FOR UPDATE`
    );

    let paidCount = 0;
    let totalPaid = 0;
    const breakdown = {};

    for (const pkg of pkgs.rows) {
      const cfg = settingsFor(pkg.amount);
      const span = cfg.maxRate - cfg.minRate;
      const frac = position !== null ? (position / 100) : Math.random();
      const r = cfg.minRate + span * frac;
      const profit = (Number(pkg.amount) * r) / 100;

      await client.query(
        'UPDATE packages SET daily_profit = $1, total_profit = total_profit + $1 WHERE id = $2',
        [profit, pkg.id]
      );
      await client.query(
        'UPDATE users SET balance = balance + $1, total_profit = total_profit + $1 WHERE id = $2',
        [profit, pkg.user_id]
      );

      paidCount++;
      totalPaid += profit;
      const key = '$' + Number(pkg.amount);
      breakdown[key] = breakdown[key] || { count: 0, rate: Number(r.toFixed(3)) };
      breakdown[key].count++;
    }

    // record the real numbers
    await client.query(
      `INSERT INTO payout_log (pay_date, packages_paid, total_paid, mode)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (pay_date) DO UPDATE
         SET packages_paid = $2, total_paid = $3, mode = $4`,
      [date, paidCount, totalPaid, mode]
    );

    await syncDaysLeft(client);
    await client.query('COMMIT');

    console.log(`[payout ${mode}] ${date}: paid ${paidCount} package(s), $${totalPaid.toFixed(2)}, completed ${completed}`);

    return {
      skipped: false,
      date,
      packagesPaid: paidCount,
      packagesCompleted: completed,
      totalPaid: Number(totalPaid.toFixed(2)),
      breakdown,
      mode,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---- Distribute daily profit (admin) ----
// Only packages that have NOT reached their end date get paid.
// Expired packages are completed first, so they can never earn an extra day.
app.post('/api/admin/distribute', async (req, res) => {
  try {
    const { adminKey, rate, force } = req.body;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });

    let position = null;
    if (rate !== undefined && rate !== null && rate !== '') {
      position = Number(rate);
      if (!isFinite(position) || position < 0 || position > 100)
        return res.status(400).json({ error: 'Rate position must be between 0 and 100' });
    }

    const result = await runPayout({ position, force: force === true, mode: 'manual' });

    if (result.skipped) {
      const why = result.reason === 'weekend'
        ? 'Today is not a trading day (markets are closed Sat/Sun).'
        : 'Profit has already been paid today. Nothing was paid twice.';
      return res.status(409).json({ error: why, ...result });
    }

    res.json({
      message: position !== null
        ? `Profit distributed at ${position}% of each package's range`
        : `Profit distributed at a random rate inside each package's range`,
      ...result,
    });
  } catch (e) {
    console.error('distribute failed:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || e) });
  }
});

// ---- Payout history (admin) ----
app.get('/api/admin/payouts', async (req, res) => {
  try {
    const { adminKey } = req.query;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });
    const r = await pool.query(
      `SELECT * FROM payout_log ORDER BY pay_date DESC LIMIT 60`
    );
    res.json(r.rows.map(row => ({
      date: row.pay_date,
      packagesPaid: Number(row.packages_paid || 0),
      totalPaid: Number(row.total_paid || 0),
      mode: row.mode,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + (e.message || e) });
  }
});

// ---- Expiry check (admin) ----
// Kept for compatibility with the old admin panel button. It no longer
// "counts down" a day by hand - it just closes out anything past its end date.
// Durations now run off expires_at, so nothing breaks if this is never called.
app.post('/api/admin/tick-day', async (req, res) => {
  try {
    const { adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });

    const completed = await expireDuePackages();
    await syncDaysLeft();

    res.json({ message: `Expiry check done. ${completed} package(s) completed.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Package overview (admin) ----
app.get('/api/admin/packages', async (req, res) => {
  try {
    const { adminKey } = req.query;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });

    await expireDuePackages();

    const r = await pool.query(`
      SELECT p.*, u.name AS user_name, u.email AS user_email
        FROM packages p
        LEFT JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC
    `);
    res.json(r.rows.map(row => ({
      ...shapePackage(row),
      userName: row.user_name,
      userEmail: row.user_email,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Request a withdrawal (user) ----
app.post('/api/withdraw', auth, async (req, res) => {
  try {
    const { amount, address } = req.body;
    const amt = Number(amount);
    if (!amt || amt < 30)
      return res.status(400).json({ error: 'Minimum withdrawal is $30' });
    if (!address || String(address).trim().length < 10)
      return res.status(400).json({ error: 'Please enter a valid USDT (ERC20) address' });

    if (new Date().getUTCDay() !== 4)
      return res.status(400).json({ error: 'Withdrawals are only available on Thursdays (UTC).' });

    const u = await pool.query('SELECT balance FROM users WHERE id = $1', [req.userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const balance = Number(u.rows[0].balance);
    if (amt > balance)
      return res.status(400).json({ error: 'Amount exceeds your available balance' });

    const wid = makeId('WD');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amt, req.userId]);
      await client.query(
        `INSERT INTO withdrawals (id, user_id, amount, address, status) VALUES ($1,$2,$3,$4,'pending')`,
        [wid, req.userId, amt, String(address).trim()]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({
      message: 'Your withdrawal request has been submitted. Please allow up to 48 hours for it to be processed.',
      id: wid,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- List withdrawals (admin) ----
app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    const { adminKey } = req.query;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });

    const r = await pool.query(`
      SELECT w.id, w.amount, w.address, w.status, w.created_at,
             u.name AS user_name, u.email AS user_email
      FROM withdrawals w
      LEFT JOIN users u ON u.id = w.user_id
      ORDER BY w.created_at DESC
    `);
    res.json(r.rows.map(row => ({
      id: row.id,
      amount: Number(row.amount),
      address: row.address,
      status: row.status,
      createdAt: row.created_at,
      userName: row.user_name,
      userEmail: row.user_email,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Approve a withdrawal (admin) ----
app.post('/api/admin/withdraw/approve', async (req, res) => {
  try {
    const { adminKey, id } = req.body;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });
    const r = await pool.query('SELECT status FROM withdrawals WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    if (r.rows[0].status !== 'pending')
      return res.status(400).json({ error: 'Already processed' });
    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', ['approved', id]);
    res.json({ message: 'Withdrawal approved' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Reject a withdrawal (admin) -> refund balance ----
app.post('/api/admin/withdraw/reject', async (req, res) => {
  try {
    const { adminKey, id } = req.body;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });

    const r = await pool.query('SELECT user_id, amount, status FROM withdrawals WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    if (r.rows[0].status !== 'pending')
      return res.status(400).json({ error: 'Already processed' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE withdrawals SET status = $1 WHERE id = $2', ['rejected', id]);
      await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2',
        [Number(r.rows[0].amount), r.rows[0].user_id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ message: 'Withdrawal rejected and amount refunded' });
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

    await expireDuePackages();

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

// ---- Background jobs ----
// Everything below runs on its own. Nobody has to remember to click anything.
//
// The daily payout is protected by the payout_log primary key, so running this
// every hour is safe: the first successful run of the day claims the date and
// every later attempt is a no-op. A missed hour, a restart, or a redeploy
// cannot cause a double payment or a skipped day.
function startBackgroundJobs() {
  const run = async () => {
    // 1) close out packages that reached their end date
    try {
      const n = await expireDuePackages();
      await syncDaysLeft();
      if (n) console.log(`[expiry] completed ${n} package(s)`);
    } catch (e) {
      console.error('[expiry] failed:', e);
    }

    // 2) pay today's profit, if it is a trading day and it has not been paid yet
    try {
      const r = await runPayout({ position: null, force: false, mode: 'auto' });
      if (r.skipped && r.reason === 'already_paid_today') {
        // normal: this is the expected result for 23 of the 24 hourly runs
      } else if (r.skipped && r.reason === 'weekend') {
        // normal: markets are closed
      } else if (!r.skipped) {
        console.log(`[payout] AUTO paid ${r.packagesPaid} package(s), $${r.totalPaid}`);
      }
    } catch (e) {
      console.error('[payout] failed:', e);
    }
  };

  run();
  setInterval(run, 60 * 60 * 1000); // every hour
}

// ---- Start server after DB is ready ----
initDb()
  .then(() => loadPackageSettings())
  .then(() => {
    startBackgroundJobs();
    app.listen(PORT, () => console.log(`FX Pro server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to init database:', err);
    process.exit(1);
  });
