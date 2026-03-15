'use strict';
const express     = require('express');
const router      = express.Router();
const { getDb }   = require('../db');
const requireAuth = require('../middleware/requireAuth');

// ── Generic toggle helper ─────────────────────────────────
// Try INSERT first; if UNIQUE constraint fires the row already exists → DELETE.
// This is atomic and race-safe (no separate SELECT step).
async function toggleLike(db, table, col, userId, targetId) {
  try {
    await db.run(`INSERT INTO ${table} (user_id, ${col}) VALUES (?, ?)`, userId, targetId);
    return true; // liked
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT') {
      await db.run(`DELETE FROM ${table} WHERE user_id = ? AND ${col} = ?`, userId, targetId);
      return false; // unliked
    }
    throw e;
  }
}

// ── POST /likes/comments/:commentId ──────────────────────
router.post('/comments/:commentId', requireAuth, async (req, res) => {
  const commentId = parseInt(req.params.commentId, 10);
  if (!commentId) return res.status(400).json({ error: 'Invalid comment ID.' });
  try {
    const db      = await getDb();
    const comment = await db.get('SELECT id FROM comments WHERE id = ?', commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    const liked = await toggleLike(db, 'comment_likes', 'comment_id', req.session.userId, commentId);
    const row   = await db.get('SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = ?', commentId);
    res.json({ liked, count: row.n });
  } catch (err) {
    console.error('POST /likes/comments/:id', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /likes/recommendations/:recId ───────────────────
router.post('/recommendations/:recId', requireAuth, async (req, res) => {
  const recId = parseInt(req.params.recId, 10);
  if (!recId) return res.status(400).json({ error: 'Invalid recommendation ID.' });
  try {
    const db  = await getDb();
    const rec = await db.get('SELECT id FROM recommendations WHERE id = ?', recId);
    if (!rec) return res.status(404).json({ error: 'Pick not found.' });
    const liked = await toggleLike(db, 'recommendation_likes', 'recommendation_id', req.session.userId, recId);
    const row   = await db.get('SELECT COUNT(*) AS n FROM recommendation_likes WHERE recommendation_id = ?', recId);
    res.json({ liked, count: row.n });
  } catch (err) {
    console.error('POST /likes/recommendations/:id', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /likes/posts/:postId ─────────────────────────────
router.post('/posts/:postId', requireAuth, async (req, res) => {
  const postId = parseInt(req.params.postId, 10);
  if (!postId) return res.status(400).json({ error: 'Invalid post ID.' });
  try {
    const db   = await getDb();
    const post = await db.get('SELECT id FROM community_posts WHERE id = ?', postId);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    const liked = await toggleLike(db, 'community_post_likes', 'post_id', req.session.userId, postId);
    const row   = await db.get('SELECT COUNT(*) AS n FROM community_post_likes WHERE post_id = ?', postId);
    res.json({ liked, count: row.n });
  } catch (err) {
    console.error('POST /likes/posts/:id', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /likes/replies/:replyId ──────────────────────────
router.post('/replies/:replyId', requireAuth, async (req, res) => {
  const replyId = parseInt(req.params.replyId, 10);
  if (!replyId) return res.status(400).json({ error: 'Invalid reply ID.' });
  try {
    const db    = await getDb();
    const reply = await db.get('SELECT id FROM community_replies WHERE id = ?', replyId);
    if (!reply) return res.status(404).json({ error: 'Reply not found.' });
    const liked = await toggleLike(db, 'community_reply_likes', 'reply_id', req.session.userId, replyId);
    const row   = await db.get('SELECT COUNT(*) AS n FROM community_reply_likes WHERE reply_id = ?', replyId);
    res.json({ liked, count: row.n });
  } catch (err) {
    console.error('POST /likes/replies/:id', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
