'use strict';
const express                              = require('express');
const { getArtistById, getArtistAlbums }  = require('../lib/spotify');

const router = express.Router();

// ── TheAudioDB — artist biography ─────────────────────────────────────────
async function getArtistBio(artistName) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 4000);
  try {
    const url = `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(artistName)}`;
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

// GET /artists/:spotifyId
// Returns artist details + all studio albums + bio.
router.get('/:spotifyId', async (req, res) => {
  const { spotifyId } = req.params;
  try {
    // Phase 1 — need artist name before we can fetch bio
    const artist = await getArtistById(spotifyId);

    // Phase 2 — albums + bio in parallel
    const [albums, bio] = await Promise.all([
      getArtistAlbums(spotifyId),
      getArtistBio(artist.name),
    ]);

    res.json({ artist, albums, bio: bio || null });
  } catch (err) {
    console.error('Artist fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load artist.' });
  }
});

module.exports = router;
