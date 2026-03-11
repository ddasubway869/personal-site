'use strict';
const express        = require('express');
const { getDb }      = require('../db');
const requireAuth    = require('../middleware/requireAuth');
const { search: spotifySearch } = require('../lib/spotify');

const router = express.Router();

// Merges dz_* alias rows into their Spotify counterparts (or vice-versa) by
// matching on normalised title+artist. Prefers the non-dz_ spotify_id for
// display so picks survive Spotify outages without splitting the count.
function mergeDzAliases(rows, limit) {
  const seen = new Map(); // key: 'lower(title)|lower(artist)'
  const out  = [];
  for (const row of rows) {
    const key = `${row.title.toLowerCase().trim()}|${row.artist.toLowerCase().trim()}`;
    if (seen.has(key)) {
      const existing = seen.get(key);
      existing.count += row.count;
      // Upgrade to real Spotify ID if we now have one
      if (row.spotifyId && !row.spotifyId.startsWith('dz_') && existing.spotifyId.startsWith('dz_')) {
        existing.spotifyId   = row.spotifyId;
        existing.coverUrl    = row.coverUrl    ?? existing.coverUrl;
        existing.releaseYear = row.releaseYear ?? existing.releaseYear;
      }
    } else {
      const entry = { ...row };
      seen.set(key, entry);
      out.push(entry);
    }
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit);
}

// Returns the ISO week key for a given Date, e.g. "2026-W10"
function isoWeekKey(date = new Date()) {
  // Copy date so we don't mutate the original
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number (Mon=1, Sun=7)
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo    = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ── POST /recommend ───────────────────────────────────────
// Body: { spotifyId, title, artist, coverUrl, releaseYear, note? }
// One recommendation per logged-in user per ISO week.
router.post('/', requireAuth, async (req, res) => {
  const { spotifyId, title, artist, coverUrl, releaseYear, note: rawNote } = req.body;

  if (!spotifyId || !title || !artist) {
    return res.status(400).json({ error: 'spotifyId, title and artist are required.' });
  }

  // note is optional; trim and cap at 150 chars
  const note = (typeof rawNote === 'string' && rawNote.trim())
    ? rawNote.trim().slice(0, 150)
    : null;

  const weekKey = isoWeekKey();

  // If this was a Deezer fallback pick, try to resolve it to the real Spotify ID
  // so picks stay unified once Spotify comes back up.
  let finalSpotifyId = spotifyId;
  if (spotifyId.startsWith('dz_')) {
    try {
      const { albums } = await spotifySearch(`${title} ${artist}`);
      const match = albums?.find(a =>
        a.title.toLowerCase().trim() === title.toLowerCase().trim()
      );
      if (match?.spotifyId) finalSpotifyId = match.spotifyId;
    } catch { /* Spotify still unavailable — keep dz_ id */ }
  }

  try {
    const db = await getDb();

    // Upsert the album into our local cache
    await db.run(
      `INSERT INTO albums (spotify_id, title, artist, cover_url, release_year)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(spotify_id) DO UPDATE
         SET title        = excluded.title,
             artist       = excluded.artist,
             cover_url    = excluded.cover_url,
             release_year = excluded.release_year`,
      finalSpotifyId, title, artist, coverUrl ?? null, releaseYear ?? null
    );

    const album = await db.get('SELECT id FROM albums WHERE spotify_id = ?', finalSpotifyId);

    // One recommendation per user per week — reject if they already picked
    const existing = await db.get(
      'SELECT id FROM recommendations WHERE user_id = ? AND week_key = ?',
      req.session.userId, weekKey
    );
    if (existing) {
      return res.status(409).json({ error: 'You have already made your pick this week.' });
    }

    await db.run(
      'INSERT INTO recommendations (user_id, album_id, week_key, note) VALUES (?, ?, ?, ?)',
      req.session.userId, album.id, weekKey, note
    );

    res.json({ ok: true, weekKey });
  } catch (err) {
    console.error('Recommend error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /recommendations?week=<key> ──────────────────────
// Returns albums ranked by number of recommendations for a given week.
// week defaults to the current ISO week.
router.get('/', async (req, res) => {
  const weekKey = req.query.week || isoWeekKey();

  try {
    const db   = await getDb();
    const rows = await db.all(
      `SELECT a.spotify_id   AS spotifyId,
              a.title,
              a.artist,
              a.cover_url    AS coverUrl,
              a.release_year AS releaseYear,
              COUNT(r.id)    AS count
       FROM   recommendations r
       JOIN   albums a ON a.id = r.album_id
       WHERE  r.week_key = ?
       GROUP  BY r.album_id
       ORDER  BY count DESC, MAX(r.created_at) DESC
       LIMIT  3`,
      weekKey
    );

    res.json({ weekKey, albums: mergeDzAliases(rows, 3) });
  } catch (err) {
    console.error('Recommendations fetch error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /recommendations/recent ──────────────────────────
// Returns this week's picks (excluding top 3), grouped by album,
// with pick counts, newest first. Up to 20 albums.
router.get('/recent', async (req, res) => {
  const weekKey = isoWeekKey();
  try {
    const db   = await getDb();
    const rows = await db.all(
      `SELECT a.spotify_id   AS spotifyId,
              a.title,
              a.artist,
              a.cover_url    AS coverUrl,
              a.release_year AS releaseYear,
              COUNT(r.id)    AS count
       FROM   recommendations r
       JOIN   albums a ON a.id = r.album_id
       WHERE  r.week_key = ?
         AND  r.album_id NOT IN (
           SELECT r2.album_id
           FROM   recommendations r2
           WHERE  r2.week_key = ?
           GROUP  BY r2.album_id
           ORDER  BY COUNT(r2.id) DESC
           LIMIT  3
         )
       GROUP  BY r.album_id
       ORDER  BY count DESC, MAX(r.created_at) DESC
       LIMIT  20`,
      weekKey, weekKey
    );
    res.json({ picks: mergeDzAliases(rows, 20) });
  } catch (err) {
    console.error('Recent picks error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /recommendations/me ───────────────────────────────
// Returns the current user's recommendation for the current week (if any).
router.get('/me', requireAuth, async (req, res) => {
  const weekKey = isoWeekKey();

  try {
    const db  = await getDb();
    const row = await db.get(
      `SELECT a.spotify_id   AS spotifyId,
              a.title,
              a.artist,
              a.cover_url    AS coverUrl,
              a.release_year AS releaseYear,
              r.note         AS note
       FROM   recommendations r
       JOIN   albums a ON a.id = r.album_id
       WHERE  r.user_id = ? AND r.week_key = ?`,
      req.session.userId, weekKey
    );

    res.json({ weekKey, recommendation: row ?? null });
  } catch (err) {
    console.error('Recommendations/me error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── PATCH /recommendations/note ───────────────────────────
// Updates the note on the current user's pick for the current week.
// Body: { note } (null or empty string clears it)
router.patch('/note', requireAuth, async (req, res) => {
  const weekKey  = isoWeekKey();
  const rawNote  = req.body.note;
  const note     = (typeof rawNote === 'string' && rawNote.trim())
    ? rawNote.trim().slice(0, 150)
    : null;

  try {
    const db     = await getDb();
    const result = await db.run(
      `UPDATE recommendations SET note = ? WHERE user_id = ? AND week_key = ?`,
      note, req.session.userId, weekKey
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'No pick found for this week.' });
    }
    res.json({ ok: true, note });
  } catch (err) {
    console.error('Note update error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
