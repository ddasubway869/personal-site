'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { getDb } = require('../db');
const mailer   = require('../lib/mailer');

const router = express.Router();

const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;
const TOKEN_TTL   = 24 * 60 * 60; // 24 hours in seconds

// ── POST /auth/register ───────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, username } = req.body;

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters (letters, numbers, _ or -).' });
  }

  try {
    const db = await getDb();

    const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    const takenName = await db.get('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', username);
    if (takenName) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const hash   = await bcrypt.hash(password, 12);
    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL;

    const { lastID: userId } = await db.run(
      'INSERT INTO users (email, password_hash, username) VALUES (?, ?, ?)', email, hash, username
    );
    await db.run(
      'INSERT INTO verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      userId, token, expiry
    );

    const verifyUrl = `${process.env.BASE_URL}/auth/verify/${token}`;
    try {
      await mailer.sendMail({
        from:    `"ARVL" <${process.env.MAIL_FROM}>`,
        to:      email,
        subject: 'Verify your ARVL account',
        text:    `Hey ${username},\n\nThanks for joining ARVL. Click the link below to verify your email address:\n\n${verifyUrl}\n\nThis link expires in 24 hours. If you didn't create an account, you can safely ignore this email.\n\n— ARVL`,
        html:    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Verify your ARVL account</title>
</head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f;padding:48px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

          <tr>
            <td style="padding-bottom:32px;text-align:center;">
              <span style="font-size:22px;font-weight:700;letter-spacing:-.5px;color:#ffffff;">ARVL</span>
            </td>
          </tr>

          <tr>
            <td style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:40px 36px;">
              <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#666;">Welcome aboard</p>
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#ffffff;line-height:1.3;">Verify your email, ${username}</h1>
              <p style="margin:0 0 32px;font-size:15px;line-height:1.65;color:#999;">
                You're one step away. Click below to confirm your email address and activate your ARVL account.
              </p>

              <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr>
                  <td style="background:#ffffff;border-radius:8px;">
                    <a href="${verifyUrl}"
                       style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#0f0f0f;text-decoration:none;border-radius:8px;">
                      Verify my account
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 16px;font-size:13px;color:#555;line-height:1.6;">
                Or copy and paste this link into your browser:
              </p>
              <p style="margin:0 0 24px;font-size:12px;color:#555;word-break:break-all;">
                <a href="${verifyUrl}" style="color:#888;text-decoration:underline;">${verifyUrl}</a>
              </p>
              <p style="margin:0;font-size:13px;color:#444;line-height:1.6;">
                This link expires in 24 hours. If you didn't create a ARVL account, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding-top:24px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#333;">© 2026 ARVL</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
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
      req.session.userId      = user.id;
      req.session.email       = user.email;
      req.session.username    = user.username || user.email.split('@')[0];
      req.session.isAdmin     = !!user.is_admin;
      req.session.isSupporter = !!user.is_supporter;
      res.json({ message: 'Logged in.', email: user.email, username: req.session.username, isAdmin: !!user.is_admin });
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
  res.json({ user: {
    id:          req.session.userId,
    email:       req.session.email,
    username:    req.session.username || req.session.email?.split('@')[0],
    isAdmin:     !!req.session.isAdmin,
    isSupporter: !!req.session.isSupporter,
  }});
});

module.exports = router;
