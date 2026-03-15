'use strict';
const express             = require('express');
const router              = express.Router();
const { getDb }           = require('../db');
const requireAuth         = require('../middleware/requireAuth');
const { checkContent }    = require('../middleware/contentFilter');

const uname = u => u.username || u.email.split('@')[0];

const VALID_CATEGORIES = new Set(['discussion', 'feature-request', 'bug', 'question', 'feedback']);

// ── GET /community/posts ──────────────────────────────────────
router.get('/posts', requireAuth, async (req, res) => {
  try {
    const db          = await getDb();
    const userId      = req.session?.userId ?? null;
    const catFilter   = req.query.category && VALID_CATEGORIES.has(req.query.category)
      ? req.query.category : null;
    const adminFilter = req.query.adminReplied === '1';

    const conditions = [];
    const queryParams = [];
    if (catFilter)   { conditions.push('p.category = ?'); queryParams.push(catFilter); }
    if (adminFilter) { conditions.push(
      'EXISTS (SELECT 1 FROM community_replies ar JOIN users au ON au.id = ar.user_id WHERE ar.post_id = p.id AND au.is_admin = 1)'
    ); }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // For actionable categories, surface most-liked posts first
    const LIKES_FIRST = new Set(['feedback', 'feature-request', 'bug']);
    const orderClause = (catFilter && LIKES_FIRST.has(catFilter))
      ? 'ORDER BY p.pinned DESC, likeCount DESC, p.created_at DESC'
      : 'ORDER BY p.pinned DESC, p.created_at DESC';

    const posts  = await db.all(
      `SELECT p.id, p.body, p.category, p.pinned, p.status, p.created_at AS createdAt,
              COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS username,
              u.is_supporter AS isSupporter,
              (SELECT COUNT(*) FROM community_replies r    WHERE r.post_id = p.id) AS replyCount,
              (SELECT COUNT(*) FROM community_post_likes l WHERE l.post_id = p.id) AS likeCount,
              EXISTS (SELECT 1 FROM community_replies ar JOIN users au ON au.id = ar.user_id
                      WHERE ar.post_id = p.id AND au.is_admin = 1) AS hasAdminReply
       FROM community_posts p JOIN users u ON u.id = p.user_id
       ${whereClause}
       ${orderClause} LIMIT 100`,
      ...queryParams
    );
    if (userId && posts.length) {
      const ids     = posts.map(p => p.id);
      const liked   = await db.all(
        `SELECT post_id FROM community_post_likes WHERE user_id = ? AND post_id IN (${ids.map(() => '?').join(',')})`,
        userId, ...ids
      );
      const likedSet = new Set(liked.map(l => l.post_id));
      posts.forEach(p => { p.isLiked = likedSet.has(p.id); });
    } else {
      posts.forEach(p => { p.isLiked = false; });
    }
    res.json({ posts });
  } catch (err) {
    console.error('GET /community/posts', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /community/posts/:id/replies ─────────────────────────
router.get('/posts/:id/replies', requireAuth, async (req, res) => {
  try {
    const db     = await getDb();
    const userId = req.session?.userId ?? null;
    const replies = await db.all(
      `SELECT r.id, r.body, r.created_at AS createdAt, r.parent_reply_id AS parentReplyId,
              COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS username,
              (SELECT COUNT(*) FROM community_reply_likes l WHERE l.reply_id = r.id) AS likeCount,
              (SELECT COUNT(*) FROM community_reply_likes l WHERE l.reply_id = r.id AND l.user_id = ?) AS isLiked
       FROM community_replies r JOIN users u ON u.id = r.user_id
       WHERE r.post_id = ? ORDER BY r.created_at ASC`,
      userId, req.params.id
    );
    res.json({ replies });
  } catch (err) {
    console.error('GET /community/posts/:id/replies', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /community/posts ─────────────────────────────────────
router.post('/posts', requireAuth, async (req, res) => {
  try {
    const body     = (req.body.body || '').trim();
    const category = VALID_CATEGORIES.has(req.body.category) ? req.body.category : 'discussion';
    if (!body)              return res.status(400).json({ error: 'Post body is required.' });
    if (body.length > 1000) return res.status(400).json({ error: 'Max 1000 characters.' });
    const _check1 = checkContent(body);
    if (_check1.flagged) return res.status(400).json({ error: _check1.message });

    const db   = await getDb();
    const r    = await db.run(
      'INSERT INTO community_posts (user_id, body, category) VALUES (?, ?, ?)',
      req.session.userId, body, category
    );
    const user = await db.get('SELECT username, email FROM users WHERE id = ?', req.session.userId);
    res.json({
      post: {
        id:         r.lastID,
        body,
        category,
        createdAt:  Math.floor(Date.now() / 1000),
        username:   uname(user),
        replyCount: 0,
        likeCount:  0,
        isLiked:    false,
      },
    });
  } catch (err) {
    console.error('POST /community/posts', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /community/posts/:id/reply ──────────────────────────
router.post('/posts/:id/reply', requireAuth, async (req, res) => {
  try {
    const body = (req.body.body || '').trim();
    if (!body)              return res.status(400).json({ error: 'Reply body is required.' });
    if (body.length > 1000) return res.status(400).json({ error: 'Max 1000 characters.' });
    const _check2 = checkContent(body);
    if (_check2.flagged) return res.status(400).json({ error: _check2.message });

    const db   = await getDb();
    const post = await db.get('SELECT id FROM community_posts WHERE id = ?', req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });

    const parentReplyId = req.body.parentReplyId ? parseInt(req.body.parentReplyId, 10) : null;
    const r    = await db.run(
      'INSERT INTO community_replies (user_id, post_id, body, parent_reply_id) VALUES (?, ?, ?, ?)',
      req.session.userId, post.id, body, parentReplyId
    );
    const user = await db.get('SELECT username, email FROM users WHERE id = ?', req.session.userId);
    res.json({
      reply: {
        id:            r.lastID,
        body,
        createdAt:     Math.floor(Date.now() / 1000),
        username:      uname(user),
        parentReplyId: parentReplyId,
        likeCount:     0,
        isLiked:       false,
      },
    });
  } catch (err) {
    console.error('POST /community/posts/:id/reply', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /community/posts/:id/pin ────────────────────────── (admin only)
router.post('/posts/:id/pin', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Forbidden.' });
  try {
    const db   = await getDb();
    const post = await db.get('SELECT id, pinned FROM community_posts WHERE id = ?', req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    const newPinned = post.pinned ? 0 : 1;
    await db.run('UPDATE community_posts SET pinned = ? WHERE id = ?', newPinned, post.id);
    res.json({ pinned: newPinned });
  } catch (err) {
    console.error('POST /community/posts/:id/pin', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /community/feed ───────────────────────────────────
router.get('/feed', requireAuth, async (req, res) => {
  try {
    const db    = await getDb();
    const userId = req.session.userId;
    const items = await db.all(
      `SELECT 'pick'  AS type,
              COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS username,
              u.is_supporter AS isSupporter,
              a.spotify_id   AS spotifyId,
              a.title,
              a.artist,
              a.cover_url    AS coverUrl,
              a.release_year AS releaseYear,
              r.note,
              r.week_key     AS weekKey,
              r.created_at   AS createdAt,
              r.id           AS sourceId,
              (SELECT COUNT(*) FROM recommendation_likes rl WHERE rl.recommendation_id = r.id)                    AS likeCount,
              (SELECT COUNT(*) FROM recommendation_likes rl WHERE rl.recommendation_id = r.id AND rl.user_id = ?) AS isLiked
       FROM   recommendations r
       JOIN   users u        ON u.id = r.user_id
       JOIN   albums a       ON a.id = r.album_id
       LEFT   JOIN user_follows f ON f.following_id = r.user_id AND f.follower_id = ?
       WHERE  (f.id IS NOT NULL OR r.user_id = ?)

       UNION ALL

       SELECT 'collect' AS type,
              COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS username,
              u.is_supporter AS isSupporter,
              a.spotify_id   AS spotifyId,
              a.title,
              a.artist,
              a.cover_url    AS coverUrl,
              a.release_year AS releaseYear,
              NULL AS note,
              NULL AS weekKey,
              c.created_at   AS createdAt,
              NULL AS sourceId,
              0    AS likeCount,
              0    AS isLiked
       FROM   crates c
       JOIN   users u        ON u.id = c.user_id
       JOIN   albums a       ON a.id = c.album_id
       LEFT   JOIN user_follows f ON f.following_id = c.user_id AND f.follower_id = ?
       WHERE  (f.id IS NOT NULL OR c.user_id = ?)

       UNION ALL

       SELECT 'comment' AS type,
              COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS username,
              u.is_supporter AS isSupporter,
              a.spotify_id   AS spotifyId,
              a.title,
              a.artist,
              a.cover_url    AS coverUrl,
              a.release_year AS releaseYear,
              cm.body        AS note,
              NULL           AS weekKey,
              cm.created_at  AS createdAt,
              cm.id          AS sourceId,
              (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = cm.id)                    AS likeCount,
              (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = cm.id AND cl.user_id = ?) AS isLiked
       FROM   comments cm
       JOIN   users u        ON u.id = cm.user_id
       JOIN   albums a       ON a.id = cm.album_id
       LEFT   JOIN user_follows f ON f.following_id = cm.user_id AND f.follower_id = ?
       WHERE  (f.id IS NOT NULL OR cm.user_id = ?)

       ORDER  BY createdAt DESC LIMIT 100`,
      userId, userId, userId,
      userId, userId,
      userId, userId, userId
    );
    res.json({ items });
  } catch (err) {
    console.error('GET /community/feed', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── DELETE /community/posts/:id ───────────────────────────── (admin only)
router.delete('/posts/:id', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Forbidden.' });
  try {
    const db   = await getDb();
    const post = await db.get('SELECT id FROM community_posts WHERE id = ?', req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    await db.run('DELETE FROM community_posts WHERE id = ?', post.id);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /community/posts/:id', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── PATCH /community/posts/:id/status ────────────────────── (admin only)
const VALID_STATUSES = new Set(['planned', 'resolved', 'declined']);
router.patch('/posts/:id/status', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Forbidden.' });
  const status = req.body.status || null;
  if (status !== null && !VALID_STATUSES.has(status))
    return res.status(400).json({ error: 'Invalid status.' });
  try {
    const db   = await getDb();
    const post = await db.get('SELECT id FROM community_posts WHERE id = ?', req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    await db.run('UPDATE community_posts SET status = ? WHERE id = ?', status, post.id);
    res.json({ status });
  } catch (err) {
    console.error('PATCH /community/posts/:id/status', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
