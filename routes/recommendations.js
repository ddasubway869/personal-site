'use strict';
const express        = require('express');
const { getDb }      = require('../db');
const requireAuth    = require('../middleware/requireAuth');
const { search: spotifySearch } = require('../lib/spotify');
const { checkContent }          = require('../middleware/contentFilter');

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

const VALID_GENRES = new Set([
  'Hip-Hop', 'R&B / Soul', 'Pop', 'Rock', 'Electronic',
  'Jazz', 'Classical', 'Folk & Country', 'Metal', 'World',
  'Ambient', 'Funk', 'Blues',
]);

// ── POST /recommend ───────────────────────────────────────
// Body: { spotifyId, title, artist, coverUrl, releaseYear, note?, genre? }
// One recommendation per logged-in user per ISO week.
router.post('/', requireAuth, async (req, res) => {
  const { spotifyId, title, artist, coverUrl, releaseYear, note: rawNote, genre: rawGenre } = req.body;

  if (!spotifyId || !title || !artist) {
    return res.status(400).json({ error: 'spotifyId, title and artist are required.' });
  }

  // note is optional; trim and cap at 150 chars
  const note = (typeof rawNote === 'string' && rawNote.trim())
    ? rawNote.trim().slice(0, 150)
    : null;

  const _chk1 = note && checkContent(note);
  if (_chk1?.flagged) return res.status(400).json({ error: _chk1.message });

  // genre is optional but core part must be from allowed list (format: "Core" or "Core, Sub")
  const coreGenre = typeof rawGenre === 'string' ? rawGenre.split(',')[0].trim() : null;
  const genre = (coreGenre && VALID_GENRES.has(coreGenre)) ? rawGenre.trim() : null;

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
      `INSERT INTO albums (spotify_id, title, artist, cover_url, release_year, genre)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(spotify_id) DO UPDATE
         SET title        = excluded.title,
             artist       = excluded.artist,
             cover_url    = excluded.cover_url,
             release_year = excluded.release_year,
             genre        = COALESCE(excluded.genre, albums.genre)`,
      finalSpotifyId, title, artist, coverUrl ?? null, releaseYear ?? null, genre
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

    // Auto-add to crate when a pick is submitted
    await db.run(
      'INSERT OR IGNORE INTO crates (user_id, album_id) VALUES (?, ?)',
      req.session.userId, album.id
    );

    res.json({ ok: true, weekKey });
  } catch (err) {
    console.error('Recommend error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /recommendations ─────────────────────────────────
// Returns top 3 albums ranked by community score (all-time):
//   picks × 3 + saves × 2 + listen-laters × 1
router.get('/', async (req, res) => {
  try {
    const db   = await getDb();
    const rows = await db.all(
      `SELECT a.spotify_id   AS spotifyId,
              a.title,
              a.artist,
              a.cover_url    AS coverUrl,
              a.release_year AS releaseYear,
              a.genre,
              (COUNT(DISTINCT r.id) * 3 +
               COUNT(DISTINCT c.id) * 2 +
               COUNT(DISTINCT ll.id) * 1) AS count
       FROM   albums a
       LEFT JOIN recommendations r  ON r.album_id  = a.id  AND r.created_at  >= strftime('%s', 'now', '-30 days')
       LEFT JOIN crates c           ON c.album_id  = a.id  AND c.created_at  >= strftime('%s', 'now', '-30 days')
       LEFT JOIN listen_later ll    ON ll.album_id = a.id  AND ll.created_at >= strftime('%s', 'now', '-30 days')
       GROUP  BY a.id
       HAVING count > 0
       ORDER  BY count DESC
       LIMIT  10`
    );

    res.json({ albums: mergeDzAliases(rows, 3) });
  } catch (err) {
    console.error('Recommendations fetch error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /recommendations/recent ──────────────────────────
// Returns this week's picks (excluding top 3), grouped by album,
// with pick counts, newest first. Up to 50 albums.
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
              a.genre,
              COUNT(r.id)    AS count
       FROM   recommendations r
       JOIN   albums a ON a.id = r.album_id
       WHERE  r.week_key = ?
       GROUP  BY r.album_id
       ORDER  BY count DESC, MAX(r.created_at) DESC
       LIMIT  50`,
      weekKey
    );
    res.json({ picks: mergeDzAliases(rows, 50) });
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
              a.genre,
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

  const _chk2 = note && checkContent(note);
  if (_chk2?.flagged) return res.status(400).json({ error: _chk2.message });

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
