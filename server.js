'use strict';
require('dotenv').config();

const express    = require('express');
const session    = require('express-session');
const path       = require('path');
const { getDb }  = require('./db');
const mailer               = require('./lib/mailer');
const authRoutes           = require('./routes/auth');
const spotifyRoutes        = require('./routes/spotify');
const recommendRoutes      = require('./routes/recommendations');
const albumRoutes          = require('./routes/albums');
const artistRoutes         = require('./routes/artists');
const playerRoutes         = require('./routes/player');
const feedbackRoutes       = require('./routes/feedback');
const adminRoutes          = require('./routes/admin');
const listenRoutes         = require('./routes/listens');
const userRoutes           = require('./routes/users');
const crateRoutes          = require('./routes/crate');
const listenLaterRoutes    = require('./routes/listenLater');
const communityRoutes      = require('./routes/community');
const likesRoutes          = require('./routes/likes');
const notifRoutes          = require('./routes/notifications');
const scheduler            = require('./lib/scheduler');

const supportRoutes         = require('./routes/support');
const settingsRoutes        = require('./routes/settings');

const app  = express();
const PORT = process.env.PORT || 3000;

async function start() {
  // Initialise DB and run migrations before accepting requests
  await getDb();

  const SqliteStore = require('./lib/sessionStore')(session);

  app.set('trust proxy', 1);

  // Webhook needs raw body — apply before express.json() for that path only
  app.use('/support/webhook', express.raw({ type: 'application/json' }));

  app.use(express.json());
  app.use(session({
    store:             new SqliteStore(),
    secret:            process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave:            false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
      secure:   process.env.NODE_ENV === 'production',
    },
  }));

  app.use(express.static(path.join(__dirname, 'public')));

  // ── Routes ──────────────────────────────────────────────
  app.use('/auth',            authRoutes);
  app.use('/search',          spotifyRoutes);
  app.use('/recommendations', recommendRoutes);
  app.use('/albums',          albumRoutes);
  app.use('/artists',         artistRoutes);
  app.use('/player',          playerRoutes);
  app.use('/feedback',        feedbackRoutes);
  app.use('/admin',           adminRoutes);
  app.use('/listens',         listenRoutes);

  // New album page — no conflict with /albums/:id API (plural)
  app.get('/album/:spotifyId', (_req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'album.html')));

  // Content-negotiation: browser gets profile.html, fetch() gets JSON from userRoutes
  app.get('/u/:username', (req, res, next) => {
    if (req.headers['accept']?.includes('text/html'))
      return res.sendFile(path.join(__dirname, 'public', 'profile.html'));
    next();
  });

  app.use('/support',         supportRoutes);
  app.use('/u',               userRoutes);
  app.use('/crate',           crateRoutes);
  app.use('/listen-later',    listenLaterRoutes);
  // Community page — members only (must be before the API router)
  app.get('/community', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'community.html'));
  });

  app.use('/community',       communityRoutes);
  app.use('/likes',           likesRoutes);

  // Content-negotiation: browser gets notifications.html, fetch() gets JSON from notifRoutes
  app.get('/notifications', (req, res, next) => {
    if (req.headers['accept']?.includes('text/html'))
      return res.sendFile(path.join(__dirname, 'public', 'notifications.html'));
    next();
  });

  app.use('/notifications',   notifRoutes);

  // Settings — serve HTML for browsers, API for fetch()
  app.get('/settings', (req, res, next) => {
    if (req.headers['accept']?.includes('text/html')) {
      if (!req.session.userId) return res.redirect('/');
      return res.sendFile(path.join(__dirname, 'public', 'settings.html'));
    }
    next();
  });
  app.use('/settings', settingsRoutes);

  // Archive — members only
  app.get('/archive', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'archive.html'));
  });
  app.use('/archive', archiveRoutes);

  // ── GET /stats — user stats for home screen ──────────────
  app.get('/stats', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    const db = await getDb();
    const userId = req.session.userId;

    // Total picks
    const { picks } = await db.get('SELECT COUNT(*) AS picks FROM recommendations WHERE user_id = ?', userId);

    // Collection size
    const { collection } = await db.get('SELECT COUNT(*) AS collection FROM crates WHERE user_id = ?', userId);

    // Streak: consecutive ISO weeks ending at current week
    const rows = await db.all(
      'SELECT DISTINCT week_key FROM recommendations WHERE user_id = ? ORDER BY week_key DESC',
      userId
    );
    let streak = 0;
    if (rows.length) {
      // Build expected week sequence going backwards from current week
      function isoWeekKey(date = new Date()) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
        return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
      }
      function prevWeek(key) {
        const [year, w] = key.split('-W').map(Number);
        const d = new Date(Date.UTC(year, 0, 1));
        d.setUTCDate(d.getUTCDate() + (w - 1) * 7 - (d.getUTCDay() || 7) + 1);
        d.setUTCDate(d.getUTCDate() - 7);
        return isoWeekKey(d);
      }
      const weekSet = new Set(rows.map(r => r.week_key));
      let cur = isoWeekKey();
      // Allow current week to be missing (in progress)
      if (!weekSet.has(cur)) cur = prevWeek(cur);
      while (weekSet.has(cur)) { streak++; cur = prevWeek(cur); }
    }

    res.json({ picks, collection, streak });
  });

  app.post('/contact', async (req, res) => {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    try {
      await mailer.sendMail({
        from:    `"${name}" <${process.env.SMTP_USER}>`,
        replyTo: email,
        to:      process.env.MAIL_TO,
        subject: `New message from ${name}`,
        text:    `Name: ${name}\nEmail: ${email}\n\n${message}`,
        html:    `<p><strong>Name:</strong> ${name}</p>
                  <p><strong>Email:</strong> ${email}</p>
                  <p><strong>Message:</strong><br>${message.replace(/\n/g, '<br>')}</p>`,
      });
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Mail error:', err.message);
      res.status(500).json({ error: 'Failed to send message.' });
    }
  });

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });

  scheduler.start();
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
