'use strict';
const express   = require('express');
const router    = express.Router();
const { getDb } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

// ── POST /feedback ────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { category, message } = req.body;
  const valid = ['bug', 'feature', 'general'];
  if (!valid.includes(category)) {
    return res.status(400).json({ error: 'Invalid category.' });
  }
  if (!message || message.trim().length < 3) {
    return res.status(400).json({ error: 'Message too short.' });
  }
  try {
    const db = await getDb();
    await db.run(
      'INSERT INTO feedback (user_id, category, message) VALUES (?, ?, ?)',
      req.session.userId, category, message.trim().slice(0, 2000)
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Feedback error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /feedback/admin ───────────────────────────────────
router.get('/admin', async (req, res) => {
  if (req.query.secret !== process.env.SESSION_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db   = await getDb();
    const rows = await db.all(`
      SELECT f.id, f.category, f.message,
             datetime(f.created_at, 'unixepoch') AS submitted_at,
             COALESCE(u.username, u.email) AS user
      FROM   feedback f
      LEFT JOIN users u ON u.id = f.user_id
      ORDER  BY f.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Feedback admin error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
