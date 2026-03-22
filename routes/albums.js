'use strict';
const express          = require('express');
const { getDb }        = require('../db');
const { getAlbum }     = require('../lib/spotify');
const requireAuth      = require('../middleware/requireAuth');
const { checkContent } = require('../middleware/contentFilter');

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

// ── GET /albums/:spotifyId/pickers ───────────────────────────────────────
// Returns all users who have ever picked this album, for the popover.
router.get('/:spotifyId/pickers', async (req, res) => {
  const { spotifyId } = req.params;
  try {
    const db = await getDb();
    // For dz_ albums, match by title+artist so picks under both IDs are included
    const albumRow = await db.get('SELECT title, artist FROM albums WHERE spotify_id = ?', spotifyId);
    const rows = albumRow ? await db.all(
      `SELECT COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username
       FROM   recommendations r
       JOIN   users u  ON u.id = r.user_id
       JOIN   albums a ON a.id = r.album_id
       WHERE  LOWER(a.title) = LOWER(?) AND LOWER(a.artist) = LOWER(?)
       ORDER  BY r.created_at DESC`,
      albumRow.title, albumRow.artist
    ) : [];
    res.json({ pickers: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /albums/also-by?artist=NAME&exclude=TITLE ────────────────────────
// Must be defined before /:spotifyId to avoid being swallowed by that route.
// Returns other albums by the same artist via Deezer (no auth required).
router.get('/also-by', async (req, res) => {
  const artist  = (req.query.artist  || '').trim();
  const exclude = (req.query.exclude || '').trim();
  if (!artist) return res.json({ albums: [] });

  const ac  = new AbortController();
  const tid = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(
      `https://api.deezer.com/search/album?q=artist:"${encodeURIComponent(artist)}"&limit=20`,
      { signal: ac.signal }
    );
    clearTimeout(tid);
    if (!r.ok) return res.json({ albums: [] });
    const data = await r.json();

    const artistLower = artist.toLowerCase();
    const seen   = new Set();
    const albums = (data.data || [])
      .filter(a => {
        if (a.record_type === 'single') return false;
        const key         = (a.title || '').toLowerCase().trim();
        const albumArtist = (a.artist?.name || '').toLowerCase();
        // Only include albums where the artist name closely matches
        if (!albumArtist.includes(artistLower) && !artistLower.includes(albumArtist)) return false;
        if (exclude && key === exclude.toLowerCase().trim()) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8)
      .map(a => ({
        spotifyId:   `dz_${a.id}`,
        title:       a.title,
        artist:      a.artist?.name ?? artist,
        coverUrl:    a.cover_medium ?? a.cover ?? null,
        releaseYear: a.release_date ? String(a.release_date).slice(0, 4) : null,
      }));

    res.json({ albums });
  } catch {
    clearTimeout(tid);
    res.json({ albums: [] });
  }
});

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

      // Upsert Deezer album into DB so crate/listen-later routes can find it
      await db.run(
        `INSERT INTO albums (spotify_id, title, artist, cover_url, release_year)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(spotify_id) DO UPDATE SET
           title=excluded.title, artist=excluded.artist,
           cover_url=excluded.cover_url, release_year=excluded.release_year`,
        albumData.spotifyId, albumData.title, albumData.artist,
        albumData.coverUrl ?? null, albumData.releaseYear ?? null
      );

      // Attach genre from DB (Deezer fetch doesn't include it)
      const dzGenreRow = await db.get('SELECT genre FROM albums WHERE spotify_id = ?', albumData.spotifyId);
      albumData.genre = dzGenreRow?.genre ?? null;

      const weekKey = isoWeekKey();
      const userId  = req.session?.userId ?? null;
      const [pickRow, albumDesc, artistBio, pickNotes, weekPickersRows, listenRow, userListenRow, userCrateRow, userListenLaterRow, totalPickRow, totalSaveRow, totalListenLaterRow] = await Promise.all([
        db.get(
          `SELECT COUNT(r.id) AS count FROM recommendations r JOIN albums a ON a.id = r.album_id WHERE a.spotify_id = ? AND r.week_key = ?`,
          spotifyId, weekKey
        ),
        getAlbumDescription(albumData.artist, albumData.title),
        getArtistBio(albumData.artist),
        db.all(
          `SELECT r.id,
                  COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username,
                  u.is_supporter AS isSupporter,
                  r.note,
                  (SELECT COUNT(*) FROM recommendation_likes rl WHERE rl.recommendation_id = r.id) AS likeCount
           FROM   recommendations r JOIN users u ON u.id = r.user_id JOIN albums a ON a.id = r.album_id
           WHERE  a.spotify_id = ? AND r.note IS NOT NULL AND trim(r.note) != ''
           ORDER  BY r.created_at DESC LIMIT 6`,
          spotifyId
        ),
        userId ? db.all(
          `SELECT COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username,
                  CASE WHEN uf.id IS NOT NULL THEN 1 ELSE 0 END AS isFollowing
           FROM   recommendations r
           JOIN   users u  ON u.id = r.user_id
           JOIN   albums a ON a.id = r.album_id
           LEFT   JOIN user_follows uf ON uf.follower_id = ? AND uf.following_id = u.id
           WHERE  a.spotify_id = ? AND r.week_key = ? AND r.user_id != ?
           ORDER  BY r.created_at ASC LIMIT 20`,
          userId, spotifyId, weekKey, userId
        ) : db.all(
          `SELECT COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username, 0 AS isFollowing
           FROM   recommendations r
           JOIN   users u  ON u.id = r.user_id
           JOIN   albums a ON a.id = r.album_id
           WHERE  a.spotify_id = ? AND r.week_key = ?
           ORDER  BY r.created_at ASC LIMIT 20`,
          spotifyId, weekKey
        ),
        db.get(
          `SELECT COUNT(*) AS n FROM listens l JOIN albums a ON a.id = l.album_id WHERE a.spotify_id = ? AND l.week_key = ?`,
          spotifyId, weekKey
        ),
        userId ? db.get(
          `SELECT l.id FROM listens l JOIN albums a ON a.id = l.album_id WHERE l.user_id = ? AND a.spotify_id = ? AND l.week_key = ?`,
          userId, spotifyId, weekKey
        ) : Promise.resolve(null),
        userId ? db.get(
          `SELECT c.id FROM crates c JOIN albums a ON a.id = c.album_id WHERE c.user_id = ? AND a.spotify_id = ?`,
          userId, spotifyId
        ) : Promise.resolve(null),
        userId ? db.get(
          `SELECT ll.id FROM listen_later ll JOIN albums a ON a.id = ll.album_id WHERE ll.user_id = ? AND a.spotify_id = ?`,
          userId, spotifyId
        ) : Promise.resolve(null),
        // All-time community stats — match by title+artist to catch both dz_ and Spotify IDs
        db.get(`SELECT COUNT(r.id) AS n FROM recommendations r JOIN albums a ON a.id = r.album_id WHERE LOWER(a.title) = LOWER(?) AND LOWER(a.artist) = LOWER(?)`, albumData.title, albumData.artist),
        db.get(`SELECT COUNT(c.id) AS n FROM crates c JOIN albums a ON a.id = c.album_id WHERE LOWER(a.title) = LOWER(?) AND LOWER(a.artist) = LOWER(?)`, albumData.title, albumData.artist),
        db.get(`SELECT COUNT(ll.id) AS n FROM listen_later ll JOIN albums a ON a.id = ll.album_id WHERE LOWER(a.title) = LOWER(?) AND LOWER(a.artist) = LOWER(?)`, albumData.title, albumData.artist),
      ]);

      // Attach isLiked to pick notes
      if (userId && pickNotes.length) {
        const recIds   = pickNotes.map(n => n.id);
        const liked    = await db.all(
          `SELECT recommendation_id FROM recommendation_likes WHERE user_id = ? AND recommendation_id IN (${recIds.map(() => '?').join(',')})`,
          userId, ...recIds
        );
        const likedSet = new Set(liked.map(l => l.recommendation_id));
        pickNotes.forEach(n => { n.isLiked = likedSet.has(n.id); });
      } else {
        pickNotes.forEach(n => { n.isLiked = false; });
      }

      const description       = albumDesc || artistBio || null;
      const descriptionSource = albumDesc ? 'album' : (artistBio ? 'artist' : null);

      return res.json({
        album:             albumData,
        tracks:            albumData.tracks,
        weekPickCount:     pickRow?.count ?? 0,
        weekPickers:       weekPickersRows,
        appleMusicUrl:     null,
        description,
        descriptionSource,
        pickNotes,
        listenCount:       listenRow?.n ?? 0,
        isListening:       !!userListenRow,
        isInCrate:         !!userCrateRow,
        isInListenLater:   !!userListenLaterRow,
        totalPickCount:    totalPickRow?.n ?? 0,
        totalSaveCount:    totalSaveRow?.n ?? 0,
        totalListenLaterCount: totalListenLaterRow?.n ?? 0,
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
      `SELECT title, artist, cover_url, release_year, tracks_json, artists_json, genre
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
        genre:       dbRow.genre ?? null,
        tracks:      JSON.parse(dbRow.tracks_json),
      };
      fromCache = true;
    } else {
      // Fetch from Spotify and cache the result
      albumData = await getAlbum(spotifyId);

      await db.run(
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
    const userId = req.session?.userId ?? null;
    const [pickRow, appleMusicUrl, albumDesc, artistBio, pickNotes, weekPickersRows, listenRow, userListenRow, userCrateRow, userListenLaterRow, genreRow, totalPickRow, totalSaveRow, totalListenLaterRow] = await Promise.all([
      db.get(
        // Also count picks from any dz_* alias of this album (same title+artist)
        // so pick counts survive the Spotify-outage / Deezer-fallback split.
        `SELECT COUNT(r.id) AS count
         FROM   recommendations r
         JOIN   albums a ON a.id = r.album_id
         WHERE  r.week_key = ?
           AND (a.spotify_id = ?
                OR (a.spotify_id LIKE 'dz_%'
                    AND LOWER(a.title)  = LOWER(?)
                    AND LOWER(a.artist) = LOWER(?)))`,
        weekKey, spotifyId, albumData.title, albumData.artist
      ),
      getAppleMusicUrl(spotifyId),
      getAlbumDescription(albumData.artist, albumData.title),
      getArtistBio(albumData.artist),
      db.all(
        `SELECT r.id,
                COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username,
                u.is_supporter AS isSupporter,
                r.note,
                (SELECT COUNT(*) FROM recommendation_likes rl WHERE rl.recommendation_id = r.id) AS likeCount
         FROM   recommendations r
         JOIN   users  u ON u.id  = r.user_id
         JOIN   albums a ON a.id  = r.album_id
         WHERE  a.spotify_id = ?
           AND  r.note IS NOT NULL AND trim(r.note) != ''
         ORDER  BY r.created_at DESC
         LIMIT  6`,
        spotifyId
      ),
      userId ? db.all(
        `SELECT COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username,
                CASE WHEN uf.id IS NOT NULL THEN 1 ELSE 0 END AS isFollowing
         FROM   recommendations r
         JOIN   users u  ON u.id = r.user_id
         JOIN   albums a ON a.id = r.album_id
         LEFT   JOIN user_follows uf ON uf.follower_id = ? AND uf.following_id = u.id
         WHERE  r.week_key = ?
           AND (a.spotify_id = ?
                OR (a.spotify_id LIKE 'dz_%'
                    AND LOWER(a.title)  = LOWER(?)
                    AND LOWER(a.artist) = LOWER(?)))
           AND  r.user_id != ?
         ORDER  BY r.created_at ASC LIMIT 20`,
        userId, weekKey, spotifyId, albumData.title, albumData.artist, userId
      ) : db.all(
        `SELECT COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username, 0 AS isFollowing
         FROM   recommendations r
         JOIN   users u  ON u.id = r.user_id
         JOIN   albums a ON a.id = r.album_id
         WHERE  r.week_key = ?
           AND (a.spotify_id = ?
                OR (a.spotify_id LIKE 'dz_%'
                    AND LOWER(a.title)  = LOWER(?)
                    AND LOWER(a.artist) = LOWER(?)))
         ORDER  BY r.created_at ASC LIMIT 20`,
        weekKey, spotifyId, albumData.title, albumData.artist
      ),
      db.get(
        `SELECT COUNT(*) AS n FROM listens l JOIN albums a ON a.id = l.album_id WHERE a.spotify_id = ? AND l.week_key = ?`,
        spotifyId, weekKey
      ),
      userId ? db.get(
        `SELECT l.id FROM listens l JOIN albums a ON a.id = l.album_id WHERE l.user_id = ? AND a.spotify_id = ? AND l.week_key = ?`,
        userId, spotifyId, weekKey
      ) : Promise.resolve(null),
      userId ? db.get(
        `SELECT c.id FROM crates c JOIN albums a ON a.id = c.album_id WHERE c.user_id = ? AND a.spotify_id = ?`,
        userId, spotifyId
      ) : Promise.resolve(null),
      userId ? db.get(
        `SELECT ll.id FROM listen_later ll JOIN albums a ON a.id = ll.album_id WHERE ll.user_id = ? AND a.spotify_id = ?`,
        userId, spotifyId
      ) : Promise.resolve(null),
      // Genre is stored on albums; fetch it separately so Spotify-path gets it too
      fromCache ? Promise.resolve(null) : db.get('SELECT genre FROM albums WHERE spotify_id = ?', spotifyId),
      // All-time community stats
      db.get(`SELECT COUNT(r.id) AS n FROM recommendations r JOIN albums a ON a.id = r.album_id WHERE a.spotify_id = ?`, spotifyId),
      db.get(`SELECT COUNT(c.id) AS n FROM crates c JOIN albums a ON a.id = c.album_id WHERE a.spotify_id = ?`, spotifyId),
      db.get(`SELECT COUNT(ll.id) AS n FROM listen_later ll JOIN albums a ON a.id = ll.album_id WHERE a.spotify_id = ?`, spotifyId),
    ]);

    // For Spotify-fetched albums, attach genre from DB (cache path already has it)
    if (!fromCache) albumData.genre = genreRow?.genre ?? null;

    // Attach isLiked to pick notes
    if (userId && pickNotes.length) {
      const recIds   = pickNotes.map(n => n.id);
      const liked    = await db.all(
        `SELECT recommendation_id FROM recommendation_likes WHERE user_id = ? AND recommendation_id IN (${recIds.map(() => '?').join(',')})`,
        userId, ...recIds
      );
      const likedSet = new Set(liked.map(l => l.recommendation_id));
      pickNotes.forEach(n => { n.isLiked = likedSet.has(n.id); });
    } else {
      pickNotes.forEach(n => { n.isLiked = false; });
    }

    const description       = albumDesc || artistBio || null;
    const descriptionSource = albumDesc ? 'album' : (artistBio ? 'artist' : null);

    res.json({
      album:             albumData,
      tracks:            albumData.tracks,
      weekPickCount:     pickRow?.count ?? 0,
      weekPickers:       weekPickersRows,
      appleMusicUrl,
      description,
      descriptionSource,
      pickNotes,
      listenCount:       listenRow?.n ?? 0,
      isListening:       !!userListenRow,
      isInCrate:         !!userCrateRow,
      isInListenLater:   !!userListenLaterRow,
      totalPickCount:    totalPickRow?.n ?? 0,
      totalSaveCount:    totalSaveRow?.n ?? 0,
      totalListenLaterCount: totalListenLaterRow?.n ?? 0,
      _cached:           fromCache,
    });
  } catch (err) {
    console.error('Album fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load album.' });
  }
});

// ── GET /albums/:spotifyId/previews ──────────────────────
// Fetches 30-second preview URLs from Deezer for albums where Spotify
// doesn't provide them (major-label albums often have previewUrl: null).
// Returns { previews: { "track name lowercase": "https://cdn.deezer.com/...mp3" } }
router.get('/:spotifyId/previews', async (req, res) => {
  try {
    const db     = await getDb();
    const dbRow  = await db.get('SELECT title, artist FROM albums WHERE spotify_id = ?', req.params.spotifyId);
    if (!dbRow) return res.json({ previews: {} });

    const q          = encodeURIComponent(`artist:"${dbRow.artist}" album:"${dbRow.title}"`);
    const c1         = new AbortController();
    const t1         = setTimeout(() => c1.abort(), 4000);
    const searchRes  = await fetch(`https://api.deezer.com/search/album?q=${q}&limit=5`, { signal: c1.signal });
    clearTimeout(t1);
    const searchData = await searchRes.json();
    const dzAlbum    = searchData.data?.[0];
    if (!dzAlbum) return res.json({ previews: {} });

    const c2        = new AbortController();
    const t2        = setTimeout(() => c2.abort(), 4000);
    const tracksRes = await fetch(`https://api.deezer.com/album/${dzAlbum.id}/tracks?limit=50`, { signal: c2.signal });
    clearTimeout(t2);
    const tracksData = await tracksRes.json();

    const previews = {};
    for (const t of (tracksData.data ?? [])) {
      if (t.preview) previews[t.title.toLowerCase()] = t.preview;
    }
    res.json({ previews });
  } catch {
    res.json({ previews: {} });
  }
});

// ── GET /albums/:spotifyId/comments ──────────────────────
// Returns all comments for an album, newest first.
router.get('/:spotifyId/comments', async (req, res) => {
  const { spotifyId } = req.params;

  try {
    const db     = await getDb();
    const userId = req.session?.userId ?? null;
    const rows   = await db.all(
      `SELECT c.id,
              c.body,
              c.created_at                                                          AS createdAt,
              COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1))    AS username,
              u.is_supporter                                                         AS isSupporter,
              (SELECT COUNT(*) FROM comment_replies r WHERE r.comment_id = c.id)   AS replyCount,
              (SELECT COUNT(*) FROM comment_likes  l WHERE l.comment_id = c.id)    AS likeCount
       FROM   comments c
       JOIN   users  u ON u.id = c.user_id
       JOIN   albums a ON a.id = c.album_id
       WHERE  a.spotify_id = ?
       ORDER  BY c.created_at DESC`,
      spotifyId
    );
    if (userId && rows.length) {
      const ids     = rows.map(r => r.id);
      const liked   = await db.all(
        `SELECT comment_id FROM comment_likes WHERE user_id = ? AND comment_id IN (${ids.map(() => '?').join(',')})`,
        userId, ...ids
      );
      const likedSet = new Set(liked.map(l => l.comment_id));
      rows.forEach(r => { r.isLiked = likedSet.has(r.id); });
    } else {
      rows.forEach(r => { r.isLiked = false; });
    }
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
  const _chk1 = checkContent(body);
  if (_chk1.flagged) return res.status(400).json({ error: _chk1.message });

  try {
    const db = await getDb();

    // Upsert album so we always have a local album_id to foreign-key against.
    // Only overwrite existing title/artist if the incoming values are real (not a fallback ID).
    const safeTitle = (title && title !== spotifyId) ? title : null;
    await db.run(
      `INSERT INTO albums (spotify_id, title, artist, cover_url, release_year)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(spotify_id) DO UPDATE
         SET title        = COALESCE(excluded.title, title),
             artist       = COALESCE(excluded.artist, artist),
             cover_url    = COALESCE(excluded.cover_url, cover_url),
             release_year = COALESCE(excluded.release_year, release_year)`,
      spotifyId,
      safeTitle   ?? null,
      artist      ?? null,
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
              COALESCE(u.username, SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS username,
              u.is_supporter AS isSupporter
       FROM   comments c
       JOIN   users u ON u.id = c.user_id
       WHERE  c.user_id = ? AND c.album_id = ?
       ORDER  BY c.id DESC LIMIT 1`,
      req.session.userId, album.id
    );
    saved.likeCount = 0;
    saved.isLiked   = false;

    res.json({ ok: true, comment: saved });
  } catch (err) {
    console.error('Comment post error:', err.message);
    res.status(500).json({ error: 'Failed to post comment.' });
  }
});

// ── GET /albums/:spotifyId/comments/:commentId/replies ────
router.get('/:spotifyId/comments/:commentId/replies', async (req, res) => {
  try {
    const db      = await getDb();
    const replies = await db.all(
      `SELECT r.id, r.body, r.created_at AS createdAt,
              COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS username
       FROM   comment_replies r JOIN users u ON u.id = r.user_id
       WHERE  r.comment_id = ? ORDER BY r.created_at ASC`,
      req.params.commentId
    );
    res.json({ replies });
  } catch (err) {
    console.error('Comment replies fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load replies.' });
  }
});

// ── POST /albums/:spotifyId/comments/:commentId/reply ─────
router.post('/:spotifyId/comments/:commentId/reply', requireAuth, async (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body)              return res.status(400).json({ error: 'Reply body is required.' });
  if (body.length > 1000) return res.status(400).json({ error: 'Max 1000 characters.' });
  const _chk2 = checkContent(body);
  if (_chk2.flagged) return res.status(400).json({ error: _chk2.message });
  try {
    const db      = await getDb();
    const comment = await db.get('SELECT id FROM comments WHERE id = ?', req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    const r    = await db.run(
      'INSERT INTO comment_replies (user_id, comment_id, body) VALUES (?, ?, ?)',
      req.session.userId, comment.id, body
    );
    const user = await db.get('SELECT username, email FROM users WHERE id = ?', req.session.userId);
    res.json({
      reply: {
        id:        r.lastID,
        body,
        createdAt: Math.floor(Date.now() / 1000),
        username:  user.username || user.email.split('@')[0],
      },
    });
  } catch (err) {
    console.error('Comment reply post error:', err.message);
    res.status(500).json({ error: 'Failed to post reply.' });
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

    const safeRatingTitle = (title && title !== spotifyId) ? title : null;
    await db.run(
      `INSERT INTO albums (spotify_id, title, artist, cover_url, release_year)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(spotify_id) DO UPDATE
         SET title        = COALESCE(excluded.title, title),
             artist       = COALESCE(excluded.artist, artist),
             cover_url    = COALESCE(excluded.cover_url, cover_url),
             release_year = COALESCE(excluded.release_year, release_year)`,
      spotifyId, safeRatingTitle ?? null, artist ?? null, coverUrl ?? null, releaseYear ?? null
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

// ── POST /albums/:spotifyId/genre ─────────────────────────
// First-write-wins: sets genre only if currently NULL.
// Returns { ok, genre, alreadySet } where alreadySet=true means another member beat them to it.
router.post('/:spotifyId/genre', requireAuth, async (req, res) => {
  const { spotifyId } = req.params;
  const { genre } = req.body;
  if (!genre || typeof genre !== 'string' || !genre.trim()) {
    return res.status(400).json({ error: 'Genre is required.' });
  }
  try {
    const db     = await getDb();
    const result = await db.run(
      'UPDATE albums SET genre = ? WHERE spotify_id = ? AND genre IS NULL',
      genre.trim(), spotifyId
    );
    if (result.changes === 0) {
      // Already tagged — return whatever is set
      const row = await db.get('SELECT genre FROM albums WHERE spotify_id = ?', spotifyId);
      if (!row) return res.status(404).json({ error: 'Album not found.' });
      return res.json({ ok: true, genre: row.genre, alreadySet: true });
    }
    res.json({ ok: true, genre: genre.trim() });
  } catch (err) {
    console.error('Genre set error:', err.message);
    res.status(500).json({ error: 'Failed to save genre.' });
  }
});

module.exports = router;
