'use strict';
const { open } = require('sqlite');
const sqlite3  = require('sqlite3');
const path     = require('path');
const fs       = require('fs');

// Use DB_PATH env var if set (for persistent storage outside deploy dir on shared hosting)
// Otherwise fall back to ./data/app.db
const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
const dataDir = path.dirname(dbFile);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let _db;

async function getDb() {
  if (_db) return _db;

  _db = await open({
    filename: dbFile,
    driver:   sqlite3.Database,
  });

  await _db.exec('PRAGMA journal_mode = WAL');
  await _db.exec('PRAGMA foreign_keys = ON');

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      verified      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS verification_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT    UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid    TEXT    PRIMARY KEY,
      sess   TEXT    NOT NULL,
      expire INTEGER NOT NULL
    );

    -- Albums looked up via Spotify (cached locally so we don't re-fetch)
    CREATE TABLE IF NOT EXISTS albums (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      spotify_id TEXT    UNIQUE NOT NULL,
      title      TEXT    NOT NULL,
      artist     TEXT    NOT NULL,
      cover_url  TEXT
    );

    -- One recommendation row per (user, week).
    -- week_key is ISO week string like "2026-W10".
    CREATE TABLE IF NOT EXISTS recommendations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      album_id   INTEGER NOT NULL REFERENCES albums(id),
      week_key   TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (user_id, week_key)
    );

    -- Album comments — logged-in users only.
    -- display_name is reserved for a future username field; email used for now.
    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      body       TEXT    NOT NULL CHECK(length(body) <= 1000),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Album ratings — one rating per user per album (1–5).
    CREATE TABLE IF NOT EXISTS ratings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      rating     INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, album_id)
    );

    -- Per-track ratings — one rating per user per track (1–5).
    -- album_spotify_id lets us fetch all track ratings for an album in one query.
    CREATE TABLE IF NOT EXISTS track_ratings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      album_spotify_id TEXT    NOT NULL,
      track_spotify_id TEXT    NOT NULL,
      rating           INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, track_spotify_id)
    );

    -- User-submitted feedback
    CREATE TABLE IF NOT EXISTS feedback (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      category   TEXT    NOT NULL DEFAULT 'general',
      message    TEXT    NOT NULL CHECK(length(message) <= 2000),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Log of all outbound emails sent by the scheduler
    CREATE TABLE IF NOT EXISTS email_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT    NOT NULL,
      recipient  TEXT    NOT NULL,
      status     TEXT    NOT NULL DEFAULT 'sent',
      sent_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // ── Migrations (safe to re-run; errors ignored if column exists) ──
  for (const stmt of [
    'ALTER TABLE albums ADD COLUMN release_year TEXT',
    // Spotify OAuth tokens per user (for playback control)
    'ALTER TABLE users ADD COLUMN spotify_access_token  TEXT',
    'ALTER TABLE users ADD COLUMN spotify_refresh_token TEXT',
    'ALTER TABLE users ADD COLUMN spotify_token_expires INTEGER',
    // Display name shown publicly instead of email
    'ALTER TABLE users ADD COLUMN username TEXT',
    // Optional "tell us why" note attached to a weekly recommendation
    'ALTER TABLE recommendations ADD COLUMN note TEXT',
    // Album detail cache — full track list + artists array from Spotify
    'ALTER TABLE albums ADD COLUMN tracks_json TEXT',
    'ALTER TABLE albums ADD COLUMN artists_json TEXT',
    'ALTER TABLE albums ADD COLUMN detail_cached_at INTEGER',
  ]) {
    try { await _db.run(stmt); } catch { /* column already exists */ }
  }

  return _db;
}

module.exports = { getDb };
