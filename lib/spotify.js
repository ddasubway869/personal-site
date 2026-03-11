'use strict';

// Spotify Client Credentials flow — server-to-server, no user OAuth needed.
// The token is cached in memory and refreshed automatically before it expires.

let _token     = null;
let _expiresAt = 0;   // Unix timestamp (ms)

async function getToken() {
  if (_token && Date.now() < _expiresAt - 30_000) return _token;

  const creds = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token error ${res.status}: ${text}`);
  }

  const data   = await res.json();
  _token       = data.access_token;
  _expiresAt   = Date.now() + data.expires_in * 1000;

  return _token;
}

// ── Shared album filtering / dedup helpers ────────────────────────────────

function _isClean(name) {
  return /[\(\[]\s*(clean(\s+(version|edit))?|edited(\s+version)?)\s*[\)\]]/i.test(name);
}

function _canonical(name) {
  // Strip any trailing bracketed suffix that contains at least one edition-related keyword.
  // This handles combinations like "Deluxe Anniversary Edition", "Super Deluxe Edition", etc.
  return name
    .replace(/\s*[\(\[]\s*[^()\[\]]*\b(deluxe|expanded|special|anniversary|remaster(?:ed)?|bonus|complete|extended|edition|version)\b[^()\[\]]*\s*[\)\]]\s*$/i, '')
    .trim()
    .toLowerCase();
}

function _filterAndMapAlbums(items, sortNewestFirst = true) {
  // Sort by release date first so dedup always keeps the oldest (original) version
  // of an album rather than whichever version Spotify happens to return first.
  const byAge = [...(items ?? [])].sort((a, b) => {
    const ya = a.release_date ? parseInt(a.release_date.slice(0, 4), 10) : 9999;
    const yb = b.release_date ? parseInt(b.release_date.slice(0, 4), 10) : 9999;
    return ya - yb;
  });

  const seen = new Set();
  const mapped = byAge
    .filter(a => !_isClean(a.name))
    .filter(a => {
      const key = `${(a.artists[0]?.name ?? '').toLowerCase()}||${_canonical(a.name)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(album => ({
      spotifyId:   album.id,
      title:       album.name,
      artist:      album.artists.map(a => a.name).join(', '),
      coverUrl:    album.images[1]?.url ?? album.images[0]?.url ?? null,
      releaseYear: album.release_date ? album.release_date.slice(0, 4) : null,
    }));

  if (sortNewestFirst) {
    mapped.sort((a, b) => (parseInt(b.releaseYear, 10) || 0) - (parseInt(a.releaseYear, 10) || 0));
  } else {
    mapped.sort((a, b) => (parseInt(a.releaseYear, 10) || 9999) - (parseInt(b.releaseYear, 10) || 9999));
  }
  return mapped;
}

// ── Search cache + rate-limit cooldown ───────────────────────────────────

const _searchCache     = new Map();
const SEARCH_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// When Spotify returns 429 we stop trying for this long so the backoff
// window can actually reset instead of being continuously extended.
const RATE_LIMIT_COOLDOWN = 5 * 60 * 1000; // 5 minutes
let _rateLimitedUntil = 0;

function isRateLimited() { return Date.now() < _rateLimitedUntil; }
function setRateLimited() {
  _rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN;
  const until = new Date(_rateLimitedUntil).toISOString();
  console.warn(`[spotify] 429 received — skipping Spotify until ${until}`);
}

// ── Search (albums + artists) ─────────────────────────────────────────────

/**
 * Search Spotify for both albums and artists matching `query`.
 * Results are cached in-memory for 10 minutes to reduce API calls.
 * Throws if Spotify is rate-limited or returns an error (caller falls back).
 * Returns { artists: [...], albums: [...] }
 */
async function search(query) {
  const cacheKey = query.trim().toLowerCase();
  const cached   = _searchCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) return cached.data;

  // Skip Spotify entirely during cooldown — let caller fall back to Deezer
  if (isRateLimited()) {
    throw new Error(`Spotify search error 429: in cooldown until ${new Date(_rateLimitedUntil).toISOString()}`);
  }

  const token = await getToken();
  const url   = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=album,artist&limit=50`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    if (res.status === 429) setRateLimited();
    const text = await res.text();
    throw new Error(`Spotify search error ${res.status}: ${text}`);
  }

  const data = await res.json();

  const artists = (data.artists?.items ?? []).slice(0, 5).map(a => ({
    spotifyId: a.id,
    name:      a.name,
    imageUrl:  a.images[1]?.url ?? a.images[0]?.url ?? null,
    followers: a.followers?.total ?? 0,
  }));

  const albums = _filterAndMapAlbums(data.albums?.items, true);

  const result = { artists, albums };
  _searchCache.set(cacheKey, { data: result, expires: Date.now() + SEARCH_CACHE_TTL });
  return result;
}

// ── Artist helpers ────────────────────────────────────────────────────────

/**
 * Get artist details (name, image, genres, followers) by Spotify ID.
 */
async function getArtistById(artistId) {
  const token = await getToken();
  const url   = `https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify artist error ${res.status}: ${text}`);
  }

  const a = await res.json();
  return {
    spotifyId: a.id,
    name:      a.name,
    imageUrl:  a.images[0]?.url ?? null,
    followers: a.followers?.total ?? 0,
  };
}

/**
 * Get all studio albums for an artist, deduped and sorted newest → oldest.
 * Paginates through Spotify's results (20 per page, max 10 pages) so
 * prolific artists with large catalogues don't get truncated.
 */
async function getArtistAlbums(artistId) {
  const token = await getToken();
  const base  = `https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}/albums` +
                `?include_groups=album`;

  const allItems = [];
  let nextUrl    = base;
  let pages      = 0;

  while (nextUrl && pages < 10) {
    const res = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Spotify artist albums error ${res.status}: ${text}`);
    }
    const data = await res.json();
    allItems.push(...(data.items ?? []));
    nextUrl = data.next ?? null;
    pages++;
  }

  return _filterAndMapAlbums(allItems, true); // newest → oldest
}

// ── Single album ──────────────────────────────────────────────────────────

/**
 * Fetch a single album by Spotify ID, including its full track listing.
 * Returns { spotifyId, title, artist, coverUrl, releaseYear, genres, tracks[] }
 */
async function getAlbum(spotifyId) {
  const token = await getToken();
  const url   = `https://api.spotify.com/v1/albums/${encodeURIComponent(spotifyId)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify album error ${res.status}: ${text}`);
  }

  const album = await res.json();

  const tracks = (album.tracks?.items ?? []).map(t => ({
    id:          t.id,
    name:        t.name,
    trackNumber: t.track_number,
    durationMs:  t.duration_ms,
    previewUrl:  t.preview_url ?? null,
    artist:      t.artists.map(a => a.name).join(', '),
  }));

  return {
    spotifyId:   album.id,
    title:       album.name,
    artist:      album.artists.map(a => a.name).join(', '),
    artists:     album.artists.map(a => ({ id: a.id, name: a.name })),
    coverUrl:    album.images[1]?.url ?? album.images[0]?.url ?? null,
    releaseYear: album.release_date ? album.release_date.slice(0, 4) : null,
    tracks,
  };
}

// ── Batch albums ──────────────────────────────────────────────────────────

/**
 * Fetch up to N albums by Spotify ID in one (or a few) requests.
 * Returns raw Spotify album objects (with artists[].id included).
 */
async function getAlbumsBatch(spotifyIds) {
  if (!spotifyIds.length) return [];
  const token = await getToken();
  const results = [];
  for (let i = 0; i < spotifyIds.length; i += 20) {
    const chunk = spotifyIds.slice(i, i + 20);
    const url   = `https://api.spotify.com/v1/albums?ids=${chunk.join(',')}`;
    const res   = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const data  = await res.json();
    results.push(...(data.albums ?? []));
  }
  return results;
}

// ── Batch artists ─────────────────────────────────────────────────────────

/**
 * Fetch up to N artists by Spotify ID in one (or a few) requests.
 * Returns raw Spotify artist objects (with followers.total included).
 */
async function getArtistsBatch(spotifyIds) {
  if (!spotifyIds.length) return [];
  const token = await getToken();
  const results = [];
  for (let i = 0; i < spotifyIds.length; i += 50) {
    const chunk = spotifyIds.slice(i, i + 50);
    const url   = `https://api.spotify.com/v1/artists?ids=${chunk.join(',')}`;
    const res   = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const data  = await res.json();
    results.push(...(data.artists ?? []));
  }
  return results;
}

module.exports = { getToken, search, getArtistById, getArtistAlbums, getAlbum, getAlbumsBatch, getArtistsBatch };
