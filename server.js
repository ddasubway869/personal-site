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

const app  = express();
const PORT = process.env.PORT || 3000;

async function start() {
  // Initialise DB and run migrations before accepting requests
  await getDb();

  const SqliteStore = require('./lib/sessionStore')(session);

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

  // TEMP: one-time cleanup — remove after use
  app.get('/admin/clear-unverified', async (req, res) => {
    if (req.query.secret !== process.env.SESSION_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const db = await getDb();
    const { changes } = await db.run(
      'DELETE FROM users WHERE verified = 0 OR verified IS NULL'
    );
    await db.run('DELETE FROM verification_tokens');
    res.json({ deleted: changes });
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
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
