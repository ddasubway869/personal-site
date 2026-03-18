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

    const unsubToken = crypto.randomBytes(24).toString('hex');
    const { lastID: userId } = await db.run(
      'INSERT INTO users (email, password_hash, username, unsubscribe_token) VALUES (?, ?, ?, ?)', email, hash, username, unsubToken
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
router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ user: null });
  const db  = await getDb();
  const row = await db.get('SELECT seen_splash_v2 FROM users WHERE id = ?', req.session.userId);
  res.json({ user: {
    id:            req.session.userId,
    email:         req.session.email,
    username:      req.session.username || req.session.email?.split('@')[0],
    isAdmin:       !!req.session.isAdmin,
    isSupporter:   !!req.session.isSupporter,
    seenSplash:    !!(row?.seen_splash_v2),
  }});
});

// ── POST /auth/splash-seen ─────────────────────────────────
router.post('/splash-seen', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ ok: false });
  const db = await getDb();
  await db.run('UPDATE users SET seen_splash_v2 = 1 WHERE id = ?', req.session.userId);
  res.json({ ok: true });
});

// ── GET /auth/unsubscribe?token=... ────────────────────────
router.get('/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token.');
  const db  = await getDb();
  const user = await db.get('SELECT id, email, email_opt_out FROM users WHERE unsubscribe_token = ?', token);
  if (!user) return res.status(404).send('Invalid or expired unsubscribe link.');
  if (!user.email_opt_out) {
    await db.run('UPDATE users SET email_opt_out = 1 WHERE id = ?', user.id);
  }
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — ARVL</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d0d;color:#f5f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem;text-align:center}.card{max-width:380px}.brand{font-size:1.1rem;font-weight:700;letter-spacing:-.03em;margin-bottom:2rem;display:block;text-decoration:none;color:inherit}h1{font-size:1.4rem;font-weight:700;margin-bottom:.75rem}p{color:#888;font-size:.9rem;line-height:1.6}a{color:#f5f4f0;margin-top:1.5rem;display:inline-block;font-size:.85rem}</style>
</head><body><div class="card"><a href="/" class="brand">ARVL</a><h1>You're unsubscribed.</h1><p>We've removed ${user.email} from our weekly emails. Your account is still active — you can log in any time.</p><a href="/">Back to ARVL</a></div></body></html>`);
});

// ── POST /auth/forgot ─────────────────────────────────────
router.post('/forgot', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const db   = await getDb();
  const user = await db.get('SELECT id, email, username FROM users WHERE email = ?', email.toLowerCase().trim());
  // Always respond OK so we don't leak whether an email exists
  if (!user) return res.json({ ok: true });

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour
  await db.run(
    'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
    user.id, token, expiresAt
  );

  const BASE_URL  = process.env.BASE_URL || 'https://arvl.app';
  const resetUrl  = `${BASE_URL}/auth/reset?token=${token}`;
  const name      = user.username || user.email.split('@')[0];

  await mailer.sendMail({
    from:    `"ARVL" <${process.env.MAIL_FROM}>`,
    to:      user.email,
    subject: 'Reset your ARVL password',
    text:    `Hey ${name},\n\nClick the link below to reset your password. It expires in 1 hour.\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
    html:    `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f;padding:48px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
      <tr><td style="padding-bottom:32px;text-align:center;">
        <span style="font-size:22px;font-weight:700;letter-spacing:-.5px;color:#fff;">ARVL</span>
      </td></tr>
      <tr><td style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:40px 36px;">
        <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#666;">Account</p>
        <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#fff;">Reset your password</h1>
        <p style="margin:0 0 32px;font-size:15px;line-height:1.65;color:#999;">Hey ${name}, click below to set a new password. This link expires in 1 hour.</p>
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="background:#fff;border-radius:8px;">
            <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#0f0f0f;text-decoration:none;border-radius:8px;">Reset password</a>
          </td>
        </tr></table>
        <p style="margin:24px 0 0;font-size:13px;color:#555;">If you didn't request this, you can ignore this email.</p>
      </td></tr>
      <tr><td style="padding-top:24px;text-align:center;">
        <p style="margin:0;font-size:12px;color:#333;">© 2026 ARVL</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`,
  });

  res.json({ ok: true });
});

// ── GET /auth/reset?token=... ──────────────────────────────
router.get('/reset', async (req, res) => {
  const { token } = req.query;
  const invalid = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ARVL</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d0d;color:#f5f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem;text-align:center}.card{max-width:380px}.brand{font-size:1.1rem;font-weight:700;letter-spacing:-.03em;margin-bottom:2rem;display:block;text-decoration:none;color:inherit}h1{font-size:1.4rem;font-weight:700;margin-bottom:.75rem}p{color:#888;font-size:.9rem;line-height:1.6}a{color:#f5f4f0;margin-top:1.5rem;display:inline-block;font-size:.85rem}</style>
</head><body><div class="card"><a href="/" class="brand">ARVL</a><h1>Link expired.</h1><p>This password reset link is invalid or has already been used. Request a new one from the login screen.</p><a href="/">Back to ARVL</a></div></body></html>`;

  if (!token) return res.status(400).send(invalid);
  const db  = await getDb();
  const row = await db.get(
    'SELECT id FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?',
    token, Math.floor(Date.now() / 1000)
  );
  if (!row) return res.status(400).send(invalid);

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset password — ARVL</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0d0d;color:#f5f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem;}
  .card{width:100%;max-width:380px;}
  .brand{font-size:1.1rem;font-weight:700;letter-spacing:-.03em;margin-bottom:2rem;display:block;text-decoration:none;color:inherit;}
  h1{font-size:1.4rem;font-weight:700;margin-bottom:.5rem;}
  p{color:#888;font-size:.875rem;margin-bottom:1.5rem;}
  .field{display:flex;flex-direction:column;gap:.4rem;margin-bottom:1rem;}
  label{font-size:.8rem;color:#aaa;}
  input{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;color:#f5f4f0;font-size:.9375rem;padding:.65rem .85rem;outline:none;width:100%;font-family:inherit;}
  input:focus{border-color:#555;}
  .btn{width:100%;background:#f5f4f0;color:#0d0d0d;border:none;border-radius:8px;font-size:.9375rem;font-weight:600;padding:.75rem;cursor:pointer;font-family:inherit;margin-top:.5rem;}
  .btn:hover{background:#ddd;}
  .status{font-size:.85rem;margin-top:.75rem;min-height:1.2em;}
  .err{color:#ef5350;} .ok{color:#4caf50;}
</style>
</head><body>
<div class="card">
  <a href="/" class="brand">ARVL</a>
  <h1>Set a new password</h1>
  <p>Choose something you'll remember.</p>
  <form id="reset-form">
    <input type="hidden" id="token" value="${token}">
    <div class="field">
      <label for="new-pass">New password</label>
      <input id="new-pass" type="password" placeholder="At least 8 characters" autocomplete="new-password" required minlength="8">
    </div>
    <div class="field">
      <label for="confirm-pass">Confirm password</label>
      <input id="confirm-pass" type="password" placeholder="Same again" autocomplete="new-password" required minlength="8">
    </div>
    <button type="submit" class="btn" id="submit-btn">Update password</button>
    <p class="status" id="status"></p>
  </form>
</div>
<script>
  document.getElementById('reset-form').addEventListener('submit', async e => {
    e.preventDefault();
    const pass    = document.getElementById('new-pass').value;
    const confirm = document.getElementById('confirm-pass').value;
    const status  = document.getElementById('status');
    const btn     = document.getElementById('submit-btn');
    if (pass !== confirm) { status.textContent = 'Passwords do not match.'; status.className = 'status err'; return; }
    btn.disabled = true; btn.textContent = 'Updating...';
    try {
      const r = await fetch('/auth/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: document.getElementById('token').value, password: pass }),
      });
      const d = await r.json();
      if (!r.ok) { status.textContent = d.error; status.className = 'status err'; btn.disabled = false; btn.textContent = 'Update password'; return; }
      status.textContent = 'Password updated. Redirecting...';
      status.className = 'status ok';
      setTimeout(() => { window.location.href = '/'; }, 1500);
    } catch { status.textContent = 'Something went wrong.'; status.className = 'status err'; btn.disabled = false; btn.textContent = 'Update password'; }
  });
</script>
</body></html>`);
});

// ── POST /auth/reset ───────────────────────────────────────
router.post('/reset', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8)
    return res.status(400).json({ error: 'Invalid request.' });

  const db  = await getDb();
  const row = await db.get(
    'SELECT id, user_id FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?',
    token, Math.floor(Date.now() / 1000)
  );
  if (!row) return res.status(400).json({ error: 'This link has expired. Please request a new one.' });

  const hash = await bcrypt.hash(password, 12);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, row.user_id);
  await db.run('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', row.id);

  res.json({ ok: true });
});

module.exports = router;
