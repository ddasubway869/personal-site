'use strict';
const express     = require('express');
const { getDb }   = require('../db');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

// POST /listen-later/:spotifyId — toggle album in/out of listen later
router.post('/:spotifyId', requireAuth, async (req, res) => {
  const { spotifyId } = req.params;
  try {
    const db    = await getDb();
    const album = await db.get('SELECT id FROM albums WHERE spotify_id = ?', spotifyId);
    if (!album) return res.status(404).json({ error: 'Album not found.' });

    const existing = await db.get(
      'SELECT id FROM listen_later WHERE user_id = ? AND album_id = ?',
      req.session.userId, album.id
    );

    if (existing) {
      await db.run('DELETE FROM listen_later WHERE user_id = ? AND album_id = ?',
        req.session.userId, album.id);
      return res.json({ inListenLater: false });
    }

    await db.run('INSERT INTO listen_later (user_id, album_id) VALUES (?, ?)',
      req.session.userId, album.id);
    res.json({ inListenLater: true });
  } catch (err) {
    console.error('Listen later toggle error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
