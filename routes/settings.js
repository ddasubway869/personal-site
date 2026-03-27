'use strict';
const express     = require('express');
const { getDb }   = require('../db');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

// GET /settings/me — return current user's editable settings
router.get('/me', requireAuth, async (req, res) => {
  try {
    const db   = await getDb();
    const user = await db.get(
      `SELECT email, bio, email_opt_out AS emailOptOut
       FROM   users WHERE id = ?`,
      req.session.userId
    );
    if (!user) return res.status(404).json({ error: 'Not found.' });
    res.json(user);
  } catch (err) {
    console.error('GET /settings/me', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST /settings — save profile settings
router.post('/', requireAuth, async (req, res) => {
  const { bio, emailOptOut } = req.body;
  try {
    const db = await getDb();
    await db.run(
      `UPDATE users
       SET bio           = ?,
           email_opt_out = ?
       WHERE id = ?`,
      (bio ?? '').trim().slice(0, 200) || null,
      emailOptOut ? 1 : 0,
      req.session.userId
    );
    // Bust the session cache so initHeader re-fetches
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /settings', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});


module.exports = router;
