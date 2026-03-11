'use strict';
const express     = require('express');
const { getDb }   = require('../db');
const requireAuth = require('../middleware/requireAuth');
const mailer      = require('../lib/mailer');
const { buildEmail, isoWeekKey } = require('../lib/scheduler');

const router   = express.Router();
const BASE_URL = process.env.BASE_URL || 'https://arvl.app';

// ── POST /listens/:spotifyId — toggle "I'm listening" ─────
router.post('/:spotifyId', requireAuth, async (req, res) => {
  const { spotifyId } = req.params;
  const weekKey = isoWeekKey();

  try {
    const db    = await getDb();
    const album = await db.get(
      'SELECT id, title, artist FROM albums WHERE spotify_id = ?',
      spotifyId
    );
    if (!album) return res.status(404).json({ error: 'Album not found.' });

    // Already listened this week — do nothing
    const existing = await db.get(
      'SELECT id FROM listens WHERE user_id = ? AND album_id = ? AND week_key = ?',
      req.session.userId, album.id, weekKey
    );
    if (existing) return res.json({ ok: true });

    await db.run(
      'INSERT INTO listens (user_id, album_id, week_key) VALUES (?, ?, ?)',
      req.session.userId, album.id, weekKey
    );

    const { n } = await db.get(
      'SELECT COUNT(*) AS n FROM listens WHERE album_id = ? AND week_key = ?',
      album.id, weekKey
    );

    // First listen this week → email the picker (but not if they're listening to their own pick)
    if (n === 1) {
      const picker = await db.get(
        `SELECT u.email
         FROM   recommendations r
         JOIN   users u ON u.id = r.user_id
         WHERE  r.album_id = ? AND r.week_key = ? AND r.user_id != ?`,
        album.id, weekKey, req.session.userId
      );

      if (picker) {
        mailer.sendMail({
          from:    `"ARVL" <${process.env.MAIL_FROM}>`,
          to:      picker.email,
          subject: `A member is listening to your pick`,
          text:    `Someone just put on ${album.title} by ${album.artist}. Your taste is spreading.\n\n→ ${BASE_URL}`,
          html:    buildEmail({
            eyebrow:  'Your pick',
            heading:  `Someone is listening.`,
            body:     `A member just put on <em>${album.title}</em> by ${album.artist}. Your taste is spreading.`,
            ctaLabel: 'Go to ARVL',
          }),
        }).catch(err => console.error('[listens] Email error:', err.message));
      }
    }

    res.json({ listening: true, count: n });
  } catch (err) {
    console.error('Listen toggle error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
