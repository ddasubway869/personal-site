'use strict';
const express               = require('express');
const { search, getToken }  = require('../lib/spotify');
const deezer                = require('../lib/deezer');

const router = express.Router();

// GET /search?q=<query>
// Deezer is primary; Spotify is fallback (used only when Deezer fails).
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query param `q` is required.' });

  try {
    const result = await deezer.search(q);
    res.json(result);
  } catch (dzErr) {
    console.warn(`Deezer search failed (${dzErr.message}), falling back to Spotify`);
    try {
      const { artists, albums } = await search(q);
      res.json({ artists, albums, _spotify_fallback: true });
    } catch (spErr) {
      console.error('Spotify fallback also failed:', spErr.message);
      res.status(502).json({ error: 'Search unavailable. Try again.' });
    }
  }
});

// GET /search/spotify-resolve?q=<query>
// Always hits Spotify directly — used for Spotify Connect ID resolution only.
router.get('/spotify-resolve', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query param `q` is required.' });
  try {
    const { albums } = await search(q);
    res.json({ albums });
  } catch (err) {
    res.status(502).json({ error: 'Spotify unavailable.' });
  }
});

// GET /search/featured — top albums from Apple Music RSS (no key required)
router.get('/featured', async (req, res) => {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 6000);
    const r  = await fetch(
      'https://rss.applemarketingtools.com/api/v2/us/music/most-played/50/albums.json',
      { signal: ac.signal }
    );
    clearTimeout(t);
    if (!r.ok) throw new Error(`Apple RSS ${r.status}`);
    const data = await r.json();

    const albums = (data.feed?.results ?? [])
      .map(a => ({
        title:    a.name,
        artist:   a.artistName,
        // artworkUrl100 → swap to 400x400 for crisper covers
        coverUrl: (a.artworkUrl100 || '').replace('100x100bb', '400x400bb'),
      }))
      .filter(a => a.coverUrl);

    res.json({ albums });
  } catch (err) {
    console.error('Featured fetch error:', err.message);
    res.status(502).json({ error: 'Could not fetch featured albums.' });
  }
});

module.exports = router;
