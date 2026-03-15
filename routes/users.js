'use strict';
const express     = require('express');
const { getDb }   = require('../db');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

// GET /u/:username — member profile (members only)
router.get('/:username', requireAuth, async (req, res) => {
  const { username } = req.params;

  try {
    const db   = await getDb();
    const user = await db.get(
      `SELECT id,
              COALESCE(username, SUBSTR(email, 1, INSTR(email, '@') - 1)) AS username,
              is_supporter,
              created_at AS createdAt
       FROM   users
       WHERE  LOWER(COALESCE(username, SUBSTR(email, 1, INSTR(email, '@') - 1))) = LOWER(?)`,
      username
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const isSelf = req.session.userId === user.id;

    const [followRow, followCountRow] = await Promise.all([
      db.get('SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = ?', req.session.userId, user.id),
      db.get('SELECT COUNT(*) AS cnt FROM user_follows WHERE following_id = ?', user.id),
    ]);
    const isFollowing   = !!followRow;
    const followerCount = followCountRow?.cnt ?? 0;

    const [picks, crate, listenLater] = await Promise.all([
      db.all(
        `SELECT r.week_key     AS weekKey,
                a.spotify_id   AS spotifyId,
                a.title,
                a.artist,
                a.cover_url    AS coverUrl,
                a.release_year AS releaseYear,
                a.genre,
                r.note
         FROM   recommendations r
         JOIN   albums a ON a.id = r.album_id
         WHERE  r.user_id = ?
         ORDER  BY r.week_key DESC, r.created_at DESC`,
        user.id
      ),
      db.all(
        `SELECT a.spotify_id   AS spotifyId,
                a.title,
                a.artist,
                a.cover_url    AS coverUrl,
                a.release_year AS releaseYear,
                a.genre
         FROM   crates c
         JOIN   albums a ON a.id = c.album_id
         WHERE  c.user_id = ?
         ORDER  BY a.artist ASC, a.title ASC`,
        user.id
      ),
      isSelf ? db.all(
        `SELECT a.spotify_id   AS spotifyId,
                a.title,
                a.artist,
                a.cover_url    AS coverUrl,
                a.release_year AS releaseYear,
                a.genre
         FROM   listen_later ll
         JOIN   albums a ON a.id = ll.album_id
         WHERE  ll.user_id = ?
         ORDER  BY ll.created_at DESC`,
        user.id
      ) : Promise.resolve([]),
    ]);

    res.json({ username: user.username, isSupporter: !!user.is_supporter, createdAt: user.createdAt, picks, crate, listenLater, isSelf, isFollowing, followerCount });
  } catch (err) {
    console.error('User profile error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST /u/:username/follow — toggle follow/unfollow
router.post('/:username/follow', requireAuth, async (req, res) => {
  const { username } = req.params;
  try {
    const db     = await getDb();
    const target = await db.get(
      `SELECT id FROM users
       WHERE LOWER(COALESCE(username, SUBSTR(email, 1, INSTR(email, '@') - 1))) = LOWER(?)`,
      username
    );
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.id === req.session.userId) return res.status(400).json({ error: 'Cannot follow yourself.' });

    const existing = await db.get(
      'SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?',
      req.session.userId, target.id
    );
    if (existing) {
      await db.run('DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?',
                   req.session.userId, target.id);
      return res.json({ following: false });
    }
    await db.run('INSERT INTO user_follows (follower_id, following_id) VALUES (?, ?)',
                 req.session.userId, target.id);
    res.json({ following: true });
  } catch (err) {
    console.error('POST /u/:username/follow', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
