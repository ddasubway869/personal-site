'use strict';
const express     = require('express');
const { getDb }   = require('../db');
const { getAlbum } = require('../lib/spotify');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

// ── TheAudioDB — album description (falls back to artist bio) ────────────
// Both functions use the free demo key "2"; returns null on timeout / no match.

async function getAlbumDescription(artist, title) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 4000);
  try {
    const url = `https://www.theaudiodb.com/api/v1/json/2/searchalbum.php` +
                `?s=${encodeURIComponent(artist)}&a=${encodeURIComponent(title)}`;
    const res  = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.album?.[0]?.strDescriptionEN?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

async function getArtistBio(artist) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 4000);
  try {
    const url = `https://www.theaudiodb.com/api/v1/json/2/search.php` +
                `?s=${encodeURIComponent(artist)}`;
    const res  = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.artists?.[0]?.strBiographyEN?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

// ── Song.link — translates a Spotify album URL → Apple Music URL ──────────
// Returns null if the request times out (5 s) or song.link has no match.
async function getAppleMusicUrl(spotifyId) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 5000);
  try {
    const songLinkUrl =
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(`https://open.spotify.com/album/${spotifyId}`)}`;
    const res  = await fetch(songLinkUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.linksByPlatform?.appleMusic?.url ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

// Returns ISO week key for current week, e.g. "2026-W10"
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo    = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// How long a cached album detail is considered fresh (7 days, in seconds)
const DETAIL_CACHE_TTL_S = 7 * 24 * 60 * 60;

// ── Deezer album fetcher — used when spotifyId starts with "dz_" ──────────
async function fetchDeezerAlbum(deezerId) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(`https://api.deezer.com/album/${encodeURIComponent(deezerId)}`, { signal: ac.signal });
    clearTimeout(tid);
    if (!r.ok) return null;
    const data = await r.json();
    if (data.error) return null;

    return {
      spotifyId:   `dz_${deezerId}`,
      title:       data.title        ?? '',
      artist:      data.artist?.name ?? '',
      artists:     [{ id: null, name: data.artist?.name ?? '' }],
      coverUrl:    data.cover_medium || data.cover || null,
      releaseYear: data.release_date ? String(data.release_date).slice(0, 4) : null,
      tracks: (data.tracks?.data ?? []).map((t, i) => ({
        id:          String(t.id),
        name:        t.title         ?? '',
        trackNumber: t.track_position || (i + 1),
        durationMs:  (t.duration || 0) * 1000,
        previewUrl:  t.preview        || null,
        artist:      t.artist?.name   || data.artist?.name || '',
      })),
      _deezer: true,
    };
  } catch {
    clearTimeout(tid);
    return null;
  }
}

// ── GET /albums/:spotifyId ────────────────────────────────
// Returns album metadata + tracks. Serves from DB cache when available so the
// panel still works even when Spotify is rate-limited.
// Also handles dz_ prefixed IDs (Deezer fallback) when Spotify is unavailable.
router.get('/:spotifyId', async (req, res) => {
  const { spotifyId } = req.params;

  // ── Deezer album path (dz_ prefix) ───────────────────────────────────────
  if (spotifyId.startsWith('dz_')) {
    try {
      const deezerId   = spotifyId.slice(3);
      const [albumData, db] = await Promise.all([fetchDeezerAlbum(deezerId), getDb()]);
      if (!albumData) return res.status(502).json({ error: 'Could not load album from Deezer.' });

      const weekKey = isoWeekKey();
      const [pickRow, albumDesc, artistBio, pickNotes] = await Promise.all([
        db.get(
          `SELECT COUNT(r.id) AS count FROM recommendations r JOIN albums a ON a.id = r.album_id WHERE a.spotify_id = ? AND r.week_key = ?`,
          spotifyId, weekKey
        ),
        getAlbumDescription(albumData.artist, albumData.title),
        getArtistBio(albumData.artist),
        db.all(
          `SELECT COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username, r.note
           FROM   recommendations r JOIN users u ON u.id = r.user_id JOIN albums a ON a.id = r.album_id
           WHERE  a.spotify_id = ? AND r.note IS NOT NULL AND trim(r.note) != ''
           ORDER  BY r.created_at DESC LIMIT 6`,
          spotifyId
        ),
      ]);

      const description       = albumDesc || artistBio || null;
      const descriptionSource = albumDesc ? 'album' : (artistBio ? 'artist' : null);

      return res.json({
        album:             albumData,
        tracks:            albumData.tracks,
        weekPickCount:     pickRow?.count ?? 0,
        appleMusicUrl:     null,
        description,
        descriptionSource,
        pickNotes,
        _deezer:           true,
      });
    } catch (err) {
      console.error('Deezer album fetch error:', err.message);
      return res.status(502).json({ error: 'Could not load album from Deezer.' });
    }
  }

  try {
    const db      = await getDb();
    const weekKey = isoWeekKey();

    // ── Phase 1: try DB cache first ──────────────────────
    const dbRow = await db.get(
      `SELECT title, artist, cover_url, release_year, tracks_json, artists_json
       FROM   albums
       WHERE  spotify_id = ?
         AND  tracks_json IS NOT NULL
         AND  detail_cached_at > unixepoch() - ?`,
      spotifyId, DETAIL_CACHE_TTL_S
    );

    let albumData;
    let fromCache = false;

    if (dbRow) {
      // Serve from DB — no Spotify call needed
      albumData = {
        spotifyId,
        title:       dbRow.title,
        artist:      dbRow.artist,
        artists:     JSON.parse(dbRow.artists_json || '[]'),
        coverUrl:    dbRow.cover_url,
        releaseYear: dbRow.release_year,
        tracks:      JSON.parse(dbRow.tracks_json),
      };
      fromCache = true;
    } else {
      // Fetch from Spotify and cache the result
      albumData = await getAlbum(spotifyId);

      db.run(
        `INSERT INTO albums
           (spotify_id, title, artist, cover_url, release_year,
            tracks_json, artists_json, detail_cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(spotify_id) DO UPDATE
           SET title            = excluded.title,
               artist           = excluded.artist,
               cover_url        = excluded.cover_url,
               release_year     = excluded.release_year,
               tracks_json      = excluded.tracks_json,
               artists_json     = excluded.artists_json,
               detail_cached_at = excluded.detail_cached_at`,
        spotifyId,
        albumData.title,
        albumData.artist,
        albumData.coverUrl,
        albumData.releaseYear,
        JSON.stringify(albumData.tracks),
        JSON.stringify(albumData.artists ?? []),
      ).catch(() => {});
    }

    // ── Phase 2 — all derived lookups run in parallel ────
    const [pickRow, appleMusicUrl, albumDesc, artistBio, pickNotes] = await Promise.all([
      db.get(
        `SELECT COUNT(r.id) AS count
         FROM   recommendations r
         JOIN   albums a ON a.id = r.album_id
         WHERE  a.spotify_id = ? AND r.week_key = ?`,
        spotifyId, weekKey
      ),
      getAppleMusicUrl(spotifyId),
      getAlbumDescription(albumData.artist, albumData.title),
      getArtistBio(albumData.artist),
      db.all(
        `SELECT COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username,
                r.note
         FROM   recommendations r
         JOIN   users  u ON u.id  = r.user_id
         JOIN   albums a ON a.id  = r.album_id
         WHERE  a.spotify_id = ?
           AND  r.note IS NOT NULL AND trim(r.note) != ''
         ORDER  BY r.created_at DESC
         LIMIT  6`,
        spotifyId
      ),
    ]);

    const description       = albumDesc || artistBio || null;
    const descriptionSource = albumDesc ? 'album' : (artistBio ? 'artist' : null);

    res.json({
      album:             albumData,
      tracks:            albumData.tracks,
      weekPickCount:     pickRow?.count ?? 0,
      appleMusicUrl,
      description,
      descriptionSource,
      pickNotes,
      _cached:           fromCache,
    });
  } catch (err) {
    console.error('Album fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load album.' });
  }
});

// ── GET /albums/:spotifyId/comments ──────────────────────
// Returns all comments for an album, newest first.
router.get('/:spotifyId/comments', async (req, res) => {
  const { spotifyId } = req.params;

  try {
    const db   = await getDb();
    const rows = await db.all(
      `SELECT c.id,
              c.body,
              c.created_at                                                          AS createdAt,
              COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1))    AS username
       FROM   comments c
       JOIN   users  u ON u.id = c.user_id
       JOIN   albums a ON a.id = c.album_id
       WHERE  a.spotify_id = ?
       ORDER  BY c.created_at DESC`,
      spotifyId
    );
    res.json({ comments: rows });
  } catch (err) {
    console.error('Comments fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load comments.' });
  }
});

// ── POST /albums/:spotifyId/comments ─────────────────────
// Post a comment. Body: { body, title, artist, coverUrl, releaseYear }
// (title/artist/etc. allow us to upsert the album cache without a separate fetch)
router.post('/:spotifyId/comments', requireAuth, async (req, res) => {
  const { spotifyId } = req.params;
  const { body, title, artist, coverUrl, releaseYear } = req.body;

  if (!body || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'Comment body is required.' });
  }
  if (body.length > 1000) {
    return res.status(400).json({ error: 'Comment must be 1000 characters or fewer.' });
  }

  try {
    const db = await getDb();

    // Upsert album so we always have a local album_id to foreign-key against
    await db.run(
      `INSERT INTO albums (spotify_id, title, artist, cover_url, release_year)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(spotify_id) DO UPDATE
         SET title        = excluded.title,
             artist       = excluded.artist,
             cover_url    = excluded.cover_url,
             release_year = excluded.release_year`,
      spotifyId,
      title       ?? spotifyId,
      artist      ?? '',
      coverUrl    ?? null,
      releaseYear ?? null
    );

    const album = await db.get('SELECT id FROM albums WHERE spotify_id = ?', spotifyId);

    await db.run(
      'INSERT INTO comments (user_id, album_id, body) VALUES (?, ?, ?)',
      req.session.userId, album.id, body.trim()
    );

    // Fetch the saved comment with username to return to client
    const saved = await db.get(
      `SELECT c.id, c.body, c.created_at AS createdAt,
              COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username
       FROM   comments c
       JOIN   users u ON u.id = c.user_id
       WHERE  c.user_id = ? AND c.album_id = ?
       ORDER  BY c.id DESC LIMIT 1`,
      req.session.userId, album.id
    );

    res.json({ ok: true, comment: saved });
  } catch (err) {
    console.error('Comment post error:', err.message);
    res.status(500).json({ error: 'Failed to post comment.' });
  }
});

// ── GET /albums/:spotifyId/rating ─────────────────────────
// Returns community average (derived from track_ratings) + the logged-in user's own average.
router.get('/:spotifyId/rating', async (req, res) => {
  const { spotifyId } = req.params;
  try {
    const db = await getDb();

    // Average of each user's per-track average → community album score
    const agg = await db.get(
      `SELECT ROUND(AVG(user_avg), 1) AS average,
              COUNT(*)                AS count
       FROM (
         SELECT AVG(rating) AS user_avg
         FROM   track_ratings
         WHERE  album_spotify_id = ?
         GROUP  BY user_id
       )`,
      spotifyId
    );

    // Current user's own average across their rated tracks for this album
    let userRating = null;
    if (req.session?.userId) {
      const row = await db.get(
        `SELECT ROUND(AVG(rating), 1) AS avg
         FROM   track_ratings
         WHERE  user_id = ? AND album_spotify_id = ?`,
        req.session.userId, spotifyId
      );
      userRating = row?.avg ?? null;
    }

    res.json({
      average:    agg?.average ?? null,
      count:      agg?.count   ?? 0,
      userRating,
    });
  } catch (err) {
    console.error('Rating fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load rating.' });
  }
});

// ── POST /albums/:spotifyId/rating ────────────────────────
// Submit or update a rating. Body: { rating, title, artist, coverUrl, releaseYear }
router.post('/:spotifyId/rating', requireAuth, async (req, res) => {
  const { spotifyId } = req.params;
  const { rating, title, artist, coverUrl, releaseYear } = req.body;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be an integer between 1 and 5.' });
  }

  try {
    const db = await getDb();

    await db.run(
      `INSERT INTO albums (spotify_id, title, artist, cover_url, release_year)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(spotify_id) DO UPDATE
         SET title        = excluded.title,
             artist       = excluded.artist,
             cover_url    = excluded.cover_url,
             release_year = excluded.release_year`,
      spotifyId, title ?? spotifyId, artist ?? '', coverUrl ?? null, releaseYear ?? null
    );

    const album = await db.get('SELECT id FROM albums WHERE spotify_id = ?', spotifyId);

    await db.run(
      `INSERT INTO ratings (user_id, album_id, rating)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, album_id) DO UPDATE SET rating = excluded.rating`,
      req.session.userId, album.id, rating
    );

    // Return updated aggregate
    const agg = await db.get(
      `SELECT ROUND(AVG(r.rating), 1) AS average, COUNT(r.id) AS count
       FROM   ratings r WHERE r.album_id = ?`,
      album.id
    );

    res.json({ ok: true, average: agg.average, count: agg.count, userRating: rating });
  } catch (err) {
    console.error('Rating post error:', err.message);
    res.status(500).json({ error: 'Failed to save rating.' });
  }
});

// ── GET /albums/:spotifyId/track-ratings ─────────────────
// Returns the logged-in user's track ratings for this album.
router.get('/:spotifyId/track-ratings', async (req, res) => {
  const { spotifyId } = req.params;
  if (!req.session?.userId) return res.json({ ratings: [] });
  try {
    const db   = await getDb();
    const rows = await db.all(
      `SELECT track_spotify_id AS trackId, rating
       FROM   track_ratings
       WHERE  user_id = ? AND album_spotify_id = ?`,
      req.session.userId, spotifyId
    );
    res.json({ ratings: rows });
  } catch (err) {
    console.error('Track ratings fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load track ratings.' });
  }
});

// ── POST /albums/:spotifyId/track-ratings ─────────────────
// Save or update a single track rating.
router.post('/:spotifyId/track-ratings', requireAuth, async (req, res) => {
  const { spotifyId } = req.params;
  const { trackId, rating } = req.body;

  if (!trackId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'trackId and rating (1–5) are required.' });
  }

  try {
    const db = await getDb();

    // Save track rating
    await db.run(
      `INSERT INTO track_ratings (user_id, album_spotify_id, track_spotify_id, rating)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, track_spotify_id) DO UPDATE SET rating = excluded.rating`,
      req.session.userId, spotifyId, trackId, rating
    );

    // Return updated community average derived directly from track_ratings
    const agg = await db.get(
      `SELECT ROUND(AVG(user_avg), 1) AS average, COUNT(*) AS count
       FROM (
         SELECT AVG(rating) AS user_avg
         FROM   track_ratings
         WHERE  album_spotify_id = ?
         GROUP  BY user_id
       )`,
      spotifyId
    );

    res.json({ ok: true, average: agg?.average ?? null, count: agg?.count ?? 0 });
  } catch (err) {
    console.error('Track rating post error:', err.message);
    res.status(500).json({ error: 'Failed to save track rating.' });
  }
});

module.exports = router;
