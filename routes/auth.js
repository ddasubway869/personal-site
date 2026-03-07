'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { getDb } = require('../db');
const mailer   = require('../lib/mailer');

const router = express.Router();

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_TTL = 24 * 60 * 60; // 24 hours in seconds

// ── POST /auth/register ───────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    const db       = await getDb();
    const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const hash   = await bcrypt.hash(password, 12);
    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL;

    const { lastID: userId } = await db.run(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)', email, hash
    );
    await db.run(
      'INSERT INTO verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      userId, token, expiry
    );

    const verifyUrl = `${process.env.BASE_URL}/auth/verify/${token}`;
    try {
      await mailer.sendMail({
        from:    `"Spinrate" <${process.env.MAIL_FROM}>`,
        to:      email,
        subject: 'Verify your Spinrate account',
        text:    `Click the link below to verify your account:\n\n${verifyUrl}\n\nExpires in 24 hours.`,
        html:    `<p>Click below to verify your account:</p>
                  <p><a href="${verifyUrl}">${verifyUrl}</a></p>
                  <p>Expires in 24 hours.</p>`,
      });
    } catch (err) {
      console.error('Verification email failed:', err.message);
    }

    res.status(201).json({ message: 'Account created. Check your email to verify.' });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /auth/verify/:token ───────────────────────────────
router.get('/verify/:token', async (req, res) => {
  try {
    const db  = await getDb();
    const row = await db.get(
      'SELECT user_id, expires_at FROM verification_tokens WHERE token = ?',
      req.params.token
    );

    if (!row) return res.status(400).send('Invalid or already used verification link.');
    if (Math.floor(Date.now() / 1000) > row.expires_at) {
      await db.run('DELETE FROM verification_tokens WHERE token = ?', req.params.token);
      return res.status(400).send('Verification link expired. Please register again.');
    }

    await db.run('UPDATE users SET verified = 1 WHERE id = ?', row.user_id);
    await db.run('DELETE FROM verification_tokens WHERE token = ?', req.params.token);

    res.redirect('/?verified=1');
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).send('Server error.');
  }
});

// ── POST /auth/login ──────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.' });
  }

  try {
    const db   = await getDb();
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);

    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

    if (!user.verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in.' });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error.' });
      req.session.userId = user.id;
      req.session.email  = user.email;
      res.json({ message: 'Logged in.', email: user.email });
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /auth/logout ─────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out.' });
  });
});

// ── GET /auth/me ──────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ user: null });
  res.json({ user: { id: req.session.userId, email: req.session.email } });
});

module.exports = router;
