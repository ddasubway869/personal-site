'use strict';
const express     = require('express');
const { getDb }   = require('../db');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

// POST /crate/:spotifyId — toggle album in/out of crate
router.post('/:spotifyId', requireAuth, async (req, res) => {
  const { spotifyId } = req.params;
  try {
    const db    = await getDb();
    const album = await db.get('SELECT id FROM albums WHERE spotify_id = ?', spotifyId);
    if (!album) return res.status(404).json({ error: 'Album not found.' });

    const existing = await db.get(
      'SELECT id FROM crates WHERE user_id = ? AND album_id = ?',
      req.session.userId, album.id
    );

    if (existing) {
      await db.run('DELETE FROM crates WHERE user_id = ? AND album_id = ?',
        req.session.userId, album.id);
      return res.json({ inCrate: false });
    }

    await db.run('INSERT INTO crates (user_id, album_id) VALUES (?, ?)',
      req.session.userId, album.id);
    res.json({ inCrate: true });
  } catch (err) {
    console.error('Crate toggle error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /crate — current user's saved albums
router.get('/', requireAuth, async (req, res) => {
  try {
    const db   = await getDb();
    const rows = await db.all(
      `SELECT a.spotify_id  AS spotifyId,
              a.title,
              a.artist,
              a.cover_url   AS coverUrl,
              a.release_year AS releaseYear,
              c.created_at  AS savedAt
       FROM   crates c
       JOIN   albums a ON a.id = c.album_id
       WHERE  c.user_id = ?
       ORDER  BY c.created_at DESC`,
      req.session.userId
    );
    res.json({ albums: rows });
  } catch (err) {
    console.error('Crate fetch error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /crate/:username — another user's crate (members only)
router.get('/:username', requireAuth, async (req, res) => {
  const { username } = req.params;
  try {
    const db   = await getDb();
    const user = await db.get(
      `SELECT id FROM users
       WHERE  LOWER(COALESCE(username, SUBSTR(email, 1, INSTR(email, '@') - 1))) = LOWER(?)`,
      username
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const rows = await db.all(
      `SELECT a.spotify_id  AS spotifyId,
              a.title,
              a.artist,
              a.cover_url   AS coverUrl,
              a.release_year AS releaseYear,
              c.created_at  AS savedAt
       FROM   crates c
       JOIN   albums a ON a.id = c.album_id
       WHERE  c.user_id = ?
       ORDER  BY c.created_at DESC`,
      user.id
    );
    res.json({ albums: rows });
  } catch (err) {
    console.error('Crate fetch error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
