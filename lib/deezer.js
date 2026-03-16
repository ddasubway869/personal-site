'use strict';

// Deezer public search API — no auth required.
// Used as a fallback when Spotify is rate-limited (429).
// Only albums are returned; artists are omitted because the artist panel
// requires Spotify IDs to fetch album catalogues.

function _mapAlbums(items) {
  const seen = new Set();
  return (items ?? [])
    .filter(a => {
      if (a.record_type === 'single') return false;
      const key = `${(a.artist?.name ?? '').toLowerCase()}||${(a.title ?? '').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12)
    .map(a => ({
      spotifyId:   `dz_${a.id}`,   // placeholder — resolved to real Spotify ID on click
      title:       a.title,
      artist:      a.artist?.name ?? '',
      coverUrl:    a.cover_medium ?? a.cover ?? null,
      releaseYear: a.release_date ? String(a.release_date).slice(0, 4) : null,
      _deezer:     true,
    }));
}

async function search(query) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), 6000);

  try {
    const res = await fetch(
      `https://api.deezer.com/search/album?q=${encodeURIComponent(query)}&limit=15`,
      { signal: ac.signal }
    );
    clearTimeout(t);
    if (!res.ok) throw new Error(`Deezer search error ${res.status}`);
    const data = await res.json();
    return { artists: [], albums: _mapAlbums(data.data) };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { search };
