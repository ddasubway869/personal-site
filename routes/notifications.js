'use strict';
const express     = require('express');
const router      = express.Router();
const { getDb }   = require('../db');
const requireAuth = require('../middleware/requireAuth');

// ── GET /notifications ────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const db     = await getDb();
    const userId = req.session.userId;

    const me     = await db.get('SELECT username, email FROM users WHERE id = ?', userId);
    const myName = me.username || me.email.split('@')[0];

    // ── Likes ──────────────────────────────────────────────
    const [commentLikes, recLikes, postLikes, replyLikes] = await Promise.all([
      // Likes on my album comments
      db.all(
        `SELECT 'comment_like' AS type,
                cl.comment_id         AS contentId,
                COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS fromUsername,
                SUBSTR(c.body, 1, 80) AS contentSnippet,
                a.spotify_id          AS spotifyId,
                a.title               AS albumTitle,
                a.cover_url           AS coverUrl,
                cl.created_at         AS createdAt
         FROM   comment_likes cl
         JOIN   users u    ON u.id  = cl.user_id
         JOIN   comments c ON c.id  = cl.comment_id
         JOIN   albums a   ON a.id  = c.album_id
         WHERE  c.user_id = ? AND cl.user_id != ?
         ORDER  BY cl.created_at DESC LIMIT 100`,
        userId, userId
      ),
      // Likes on my pick notes
      db.all(
        `SELECT 'rec_like' AS type,
                rl.recommendation_id  AS contentId,
                COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS fromUsername,
                SUBSTR(r.note, 1, 80) AS contentSnippet,
                a.spotify_id          AS spotifyId,
                a.title               AS albumTitle,
                a.cover_url           AS coverUrl,
                rl.created_at         AS createdAt
         FROM   recommendation_likes rl
         JOIN   users u           ON u.id = rl.user_id
         JOIN   recommendations r ON r.id = rl.recommendation_id
         JOIN   albums a          ON a.id = r.album_id
         WHERE  r.user_id = ? AND rl.user_id != ?
           AND  r.note IS NOT NULL AND trim(r.note) != ''
         ORDER  BY rl.created_at DESC LIMIT 100`,
        userId, userId
      ),
      // Likes on my discussion posts
      db.all(
        `SELECT 'post_like' AS type,
                pl.post_id            AS contentId,
                COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS fromUsername,
                SUBSTR(p.body, 1, 80) AS contentSnippet,
                NULL AS spotifyId,
                NULL AS albumTitle,
                NULL AS coverUrl,
                pl.created_at AS createdAt
         FROM   community_post_likes pl
         JOIN   users u              ON u.id = pl.user_id
         JOIN   community_posts p    ON p.id = pl.post_id
         WHERE  p.user_id = ? AND pl.user_id != ?
         ORDER  BY pl.created_at DESC LIMIT 100`,
        userId, userId
      ),
      // Likes on my discussion replies
      db.all(
        `SELECT 'reply_like' AS type,
                rl.reply_id           AS contentId,
                COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS fromUsername,
                SUBSTR(r.body, 1, 80) AS contentSnippet,
                NULL AS spotifyId,
                NULL AS albumTitle,
                NULL AS coverUrl,
                rl.created_at AS createdAt
         FROM   community_reply_likes rl
         JOIN   users u               ON u.id = rl.user_id
         JOIN   community_replies r   ON r.id = rl.reply_id
         WHERE  r.user_id = ? AND rl.user_id != ?
         ORDER  BY rl.created_at DESC LIMIT 100`,
        userId, userId
      ),
    ]);

    const likes = [...commentLikes, ...recLikes, ...postLikes, ...replyLikes]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);

    // ── Mentions ───────────────────────────────────────────
    // Replies that start with @myName (case-insensitive)
    const mentions = await db.all(
      `SELECT COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS fromUsername,
              r.id                  AS replyId,
              r.body,
              SUBSTR(p.body, 1, 60) AS postSnippet,
              p.id                  AS postId,
              r.created_at          AS createdAt
       FROM   community_replies r
       JOIN   users u             ON u.id = r.user_id
       JOIN   community_posts p   ON p.id = r.post_id
       WHERE  LOWER(r.body) LIKE LOWER(?) AND r.user_id != ?
       ORDER  BY r.created_at DESC LIMIT 50`,
      `@${myName}%`, userId
    );

    res.json({ likes, mentions });
  } catch (err) {
    console.error('GET /notifications', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /notifications/count?since=<unix_ts> ─────────────
// Returns count of new likes + mentions since the given timestamp.
router.get('/count', requireAuth, async (req, res) => {
  try {
    const db     = await getDb();
    const userId = req.session.userId;
    const since  = parseInt(req.query.since, 10) || 0;

    const me     = await db.get('SELECT username, email FROM users WHERE id = ?', userId);
    const myName = me.username || me.email.split('@')[0];

    const [likesRow, mentionsRow] = await Promise.all([
      db.get(
        `SELECT COUNT(*) AS n FROM (
           SELECT cl.created_at FROM comment_likes cl
           JOIN comments c ON c.id = cl.comment_id
           WHERE c.user_id = ? AND cl.user_id != ? AND cl.created_at > ?
           UNION ALL
           SELECT rl.created_at FROM recommendation_likes rl
           JOIN recommendations r ON r.id = rl.recommendation_id
           WHERE r.user_id = ? AND rl.user_id != ? AND rl.created_at > ?
             AND r.note IS NOT NULL AND trim(r.note) != ''
           UNION ALL
           SELECT pl.created_at FROM community_post_likes pl
           JOIN community_posts p ON p.id = pl.post_id
           WHERE p.user_id = ? AND pl.user_id != ? AND pl.created_at > ?
           UNION ALL
           SELECT rll.created_at FROM community_reply_likes rll
           JOIN community_replies r ON r.id = rll.reply_id
           WHERE r.user_id = ? AND rll.user_id != ? AND rll.created_at > ?
         )`,
        userId, userId, since,
        userId, userId, since,
        userId, userId, since,
        userId, userId, since
      ),
      db.get(
        `SELECT COUNT(*) AS n FROM community_replies r
         WHERE LOWER(r.body) LIKE LOWER(?) AND r.user_id != ? AND r.created_at > ?`,
        `@${myName}%`, userId, since
      ),
    ]);

    res.json({ count: (likesRow?.n ?? 0) + (mentionsRow?.n ?? 0) });
  } catch (err) {
    console.error('GET /notifications/count', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
