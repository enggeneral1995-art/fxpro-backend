const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fxpro_secret_2025';

// In-memory storage (temporary)
const users = [];
const investments = [];

// Register
app.post('/api/register', async (req, res) => {
  const { name, email, phone, password, referralCode } = req.body;
  if (users.find(u => u.email === email))
    return res.status(400).json({ error: 'Email already exists' });
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now().toString(),
    name, email, phone,
    password: hash,
    referralCode: 'REF' + Date.now(),
    referredBy: referralCode || null,
    balance: 0,
    totalProfit: 0,
    packages: [],
    createdAt: new Date()
  };
  users.push(user);
  const token = jwt.sign({ id: user.id }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name, email, referralCode: user.referralCode } });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Wrong password' });
  const token = jwt.sign({ id: user.id }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name: user.name, email, referralCode: user.referralCode } });
});

// Get profile
app.get('/api/profile', auth, (req, res) => {
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ ...user, password: undefined });
});

// Add package
app.post('/api/invest', auth, (req, res) => {
  const { amount } = req.body;
  const validAmounts = [100, 250, 500, 1000, 2000, 5000, 10000, 25000];
  if (!validAmounts.includes(amount))
    return res.status(400).json({ error: 'Invalid package amount' });
  const user = users.find(u => u.id === req.userId);
  const pkg = { id: Date.now().toString(), amount, dailyProfit: 0, totalProfit: 0, createdAt: new Date(), active: true };
  user.packages.push(pkg);
  res.json({ message: 'Package added', package: pkg });
});

// Distribute daily profit (admin)
app.post('/api/admin/distribute', (req, res) => {
  const { adminKey, rate } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  if (rate < 1.70 || rate > 2.65) return res.status(400).json({ error: 'Invalid rate' });
  users.forEach(user => {
    user.packages.forEach(pkg => {
      if (pkg.active) {
        const profit = (pkg.amount * rate) / 100;
        pkg.dailyProfit = profit;
        pkg.totalProfit += profit;
        user.balance += profit;
        user.totalProfit += profit;
      }
    });
  });
  res.json({ message: `Profit distributed at ${rate}%` });
});

// Get all users (admin)
app.get('/api/admin/users', (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  res.json(users.map(u => ({ ...u, password: undefined })));
});

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

app.listen(PORT, () => console.log(`FX Pro server running on port ${PORT}`));

