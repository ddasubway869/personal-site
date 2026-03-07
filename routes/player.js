'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const BASE_URL      = process.env.BASE_URL || 'http://localhost:3000';
const REDIRECT_URI  = `${BASE_URL}/player/callback`;
const SCOPES        = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

// Get a valid Spotify access token for the user, refreshing if needed
async function getUserToken(userId) {
  const db   = await getDb();
  const user = await db.get(
    'SELECT spotify_access_token, spotify_refresh_token, spotify_token_expires FROM users WHERE id = ?',
    userId
  );
  if (!user?.spotify_access_token) return null;

  // Refresh if expired or expiring within 60 seconds
  if (!user.spotify_token_expires || Date.now() > user.spotify_token_expires - 60_000) {
    if (!user.spotify_refresh_token) return null;
    try {
      const resp = await fetch('https://accounts.spotify.com/api/token', {
        method:  'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
          'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: user.spotify_refresh_token }),
      });
      const data = await resp.json();
      if (!data.access_token) return null;
      const expiresAt = Date.now() + data.expires_in * 1000;
      await db.run(
        'UPDATE users SET spotify_access_token = ?, spotify_token_expires = ? WHERE id = ?',
        data.access_token, expiresAt, userId
      );
      return data.access_token;
    } catch { return null; }
  }

  return user.spotify_access_token;
}

// ── GET /player/connect ────────────────────────────────────
// Redirect the logged-in user to Spotify's OAuth page.
router.get('/connect', requireAuth, (req, res) => {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id',     CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri',  REDIRECT_URI);
  url.searchParams.set('scope',         SCOPES);
  url.searchParams.set('state',         String(req.session.userId));
  res.redirect(url.toString());
});

// ── GET /player/callback ───────────────────────────────────
// Spotify redirects here after the user authorises.
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/?spotify_error=1');

  const userId = parseInt(state, 10);
  if (!userId || isNaN(userId)) return res.redirect('/?spotify_error=1');

  try {
    const resp = await fetch('https://accounts.spotify.com/api/token', {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await resp.json();
    if (!data.access_token) return res.redirect('/?spotify_error=1');

    const db = await getDb();
    await db.run(
      `UPDATE users
       SET spotify_access_token  = ?,
           spotify_refresh_token = ?,
           spotify_token_expires = ?
       WHERE id = ?`,
      data.access_token,
      data.refresh_token,
      Date.now() + data.expires_in * 1000,
      userId
    );
    res.redirect('/?spotify_connected=1');
  } catch (err) {
    console.error('Spotify OAuth callback error:', err.message);
    res.redirect('/?spotify_error=1');
  }
});

// ── GET /player/status ─────────────────────────────────────
// Is the current user's Spotify account connected?
router.get('/status', requireAuth, async (req, res) => {
  const db   = await getDb();
  const user = await db.get(
    'SELECT spotify_access_token FROM users WHERE id = ?',
    req.session.userId
  );
  res.json({ connected: !!user?.spotify_access_token });
});

// ── DELETE /player/disconnect ──────────────────────────────
router.delete('/disconnect', requireAuth, async (req, res) => {
  const db = await getDb();
  await db.run(
    'UPDATE users SET spotify_access_token = NULL, spotify_refresh_token = NULL, spotify_token_expires = NULL WHERE id = ?',
    req.session.userId
  );
  res.json({ ok: true });
});

// ── GET /player/state ──────────────────────────────────────
// Proxy GET /me/player — returns current playback state.
router.get('/state', requireAuth, async (req, res) => {
  const token = await getUserToken(req.session.userId);
  if (!token) return res.json({ connected: false });

  try {
    const resp = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (resp.status === 204) return res.json({ connected: true, is_playing: false, item: null });
    if (!resp.ok)            return res.json({ connected: true, error: true });
    const data = await resp.json();
    res.json({ connected: true, ...data });
  } catch (err) {
    console.error('Player state error:', err.message);
    res.json({ connected: true, error: true });
  }
});

// ── GET /player/devices ────────────────────────────────────
// Returns the user's available Spotify devices.
router.get('/devices', requireAuth, async (req, res) => {
  const token = await getUserToken(req.session.userId);
  if (!token) return res.status(401).json({ error: 'Spotify not connected.' });

  try {
    const resp = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) return res.json({ devices: [] });
    const data = await resp.json();
    res.json({ devices: data.devices ?? [] });
  } catch (err) {
    console.error('Devices error:', err.message);
    res.json({ devices: [] });
  }
});

// ── PUT /player/play ───────────────────────────────────────
// Start or resume playback. Body can include { uris: ['spotify:track:...'] }.
// Optional ?device_id=<id> query param to target a specific device.
router.put('/play', requireAuth, async (req, res) => {
  const token = await getUserToken(req.session.userId);
  if (!token) return res.status(401).json({ error: 'Spotify not connected.' });

  try {
    const body     = req.body;
    const deviceId = req.query.device_id;
    const url      = deviceId
      ? `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`
      : 'https://api.spotify.com/v1/me/player/play';
    const resp = await fetch(url, {
      method:  'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    Object.keys(body).length ? JSON.stringify(body) : undefined,
    });
    res.status(resp.ok || resp.status === 204 ? 200 : resp.status).json({
      ok:     resp.ok || resp.status === 204,
      status: resp.status,
    });
  } catch (err) {
    console.error('Player play error:', err.message);
    res.status(500).json({ error: 'Playback command failed.' });
  }
});

// ── PUT /player/pause ──────────────────────────────────────
router.put('/pause', requireAuth, async (req, res) => {
  const token = await getUserToken(req.session.userId);
  if (!token) return res.status(401).json({ error: 'Spotify not connected.' });

  try {
    const resp = await fetch('https://api.spotify.com/v1/me/player/pause', {
      method:  'PUT',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    res.status(resp.ok || resp.status === 204 ? 200 : resp.status).json({ ok: resp.ok });
  } catch (err) {
    res.status(500).json({ error: 'Playback command failed.' });
  }
});

// ── POST /player/next ──────────────────────────────────────
router.post('/next', requireAuth, async (req, res) => {
  const token = await getUserToken(req.session.userId);
  if (!token) return res.status(401).json({ error: 'Spotify not connected.' });

  try {
    const resp = await fetch('https://api.spotify.com/v1/me/player/next', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    res.status(resp.ok || resp.status === 204 ? 200 : resp.status).json({ ok: resp.ok });
  } catch (err) {
    res.status(500).json({ error: 'Playback command failed.' });
  }
});

// ── POST /player/previous ──────────────────────────────────
router.post('/previous', requireAuth, async (req, res) => {
  const token = await getUserToken(req.session.userId);
  if (!token) return res.status(401).json({ error: 'Spotify not connected.' });

  try {
    const resp = await fetch('https://api.spotify.com/v1/me/player/previous', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    res.status(resp.ok || resp.status === 204 ? 200 : resp.status).json({ ok: resp.ok });
  } catch (err) {
    res.status(500).json({ error: 'Playback command failed.' });
  }
});

module.exports = router;
