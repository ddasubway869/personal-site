'use strict';
const express     = require('express');
const router      = express.Router();
const { getDb }   = require('../db');
const scheduler   = require('../lib/scheduler');

function requireSecret(req, res, next) {
  if (req.query.secret !== process.env.SESSION_SECRET) {
    return res.status(403).send('Forbidden');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  if (req.query.secret === process.env.SESSION_SECRET) return next();
  return res.status(403).send('Forbidden');
}

router.get('/dashboard', requireAdmin, async (req, res) => {
  const db = await getDb();

  const [users, picks, feedback, emailLogs, communityPosts] = await Promise.all([
    db.all(`
      SELECT id, username, email, verified, is_admin, is_supporter,
             datetime(created_at, 'unixepoch') AS joined
      FROM   users
      ORDER  BY created_at DESC
    `),
    db.all(`
      SELECT u.username, u.email,
             al.spotify_id AS spotifyId, al.title, al.artist, al.cover_url, al.genre,
             r.week_key, r.note,
             datetime(r.created_at, 'unixepoch') AS picked_at
      FROM   recommendations r
      JOIN   users  u  ON u.id  = r.user_id
      JOIN   albums al ON al.id = r.album_id
      ORDER  BY r.created_at DESC
    `),
    db.all(`
      SELECT COALESCE(u.username, u.email, 'anonymous') AS user,
             f.category, f.message,
             datetime(f.created_at, 'unixepoch') AS submitted_at
      FROM   feedback f
      LEFT JOIN users u ON u.id = f.user_id
      ORDER  BY f.created_at DESC
    `),
    db.all(`
      SELECT type, recipient, status,
             datetime(sent_at, 'unixepoch') AS sent_at
      FROM   email_logs
      ORDER  BY sent_at DESC
      LIMIT  200
    `),
    db.all(`
      SELECT p.id, p.body, p.category, p.pinned,
             datetime(p.created_at, 'unixepoch') AS posted_at,
             COALESCE(u.username, SUBSTR(u.email,1,INSTR(u.email,'@')-1)) AS username,
             (SELECT COUNT(*) FROM community_replies r WHERE r.post_id = p.id)    AS reply_count,
             (SELECT COUNT(*) FROM community_post_likes l WHERE l.post_id = p.id) AS like_count
      FROM   community_posts p JOIN users u ON u.id = p.user_id
      ORDER  BY p.pinned DESC, p.created_at DESC
      LIMIT  200
    `),
  ]);

  const picksByWeek = await db.all(`
    SELECT week_key, COUNT(DISTINCT user_id) AS pickers, COUNT(*) AS total_picks
    FROM   recommendations
    GROUP  BY week_key
    ORDER  BY week_key DESC
    LIMIT  20
  `);

  const secret = req.query.secret;
  const totalUsers      = users.length;
  const verifiedUsers   = users.filter(u => u.verified).length;
  const supporterCount  = users.filter(u => u.is_supporter).length;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ARVL Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:      #000;
      --surface: #111;
      --border:  #222;
      --text:    #f5f5f5;
      --muted:   #666;
    }
    html.light {
      --bg:      #ffffff;
      --surface: #f5f5f5;
      --border:  #e0e0e0;
      --text:    #111111;
      --muted:   #888888;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      line-height: 1.5;
      padding: 2rem 1.5rem 4rem;
    }
    .header {
      display: flex;
      align-items: baseline;
      gap: 1rem;
      margin-bottom: 2.5rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.25rem;
    }
    .header h1 { font-size: 1.25rem; font-weight: 700; letter-spacing: -.03em; }
    .header span { font-size: .8rem; color: var(--muted); }
    .theme-btn {
      margin-left: auto;
      background: none;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 6px;
      padding: .3rem .7rem;
      font-size: .75rem;
      cursor: pointer;
      font-family: inherit;
      transition: all .15s;
    }
    .theme-btn:hover { background: var(--surface); }
    .stats {
      display: flex;
      gap: 1.5rem;
      margin-bottom: 2.5rem;
    }
    .stat {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 1.5rem;
    }
    .stat-value { font-size: 2rem; font-weight: 700; letter-spacing: -.04em; }
    .stat-label { font-size: .75rem; color: var(--muted); margin-top: .15rem; }
    section { margin-bottom: 3rem; }
    section h2 {
      font-size: .7rem;
      font-weight: 600;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 1rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: left;
      font-size: .7rem;
      font-weight: 600;
      letter-spacing: .07em;
      text-transform: uppercase;
      color: var(--muted);
      padding: .5rem .75rem;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: .65rem .75rem;
      border-bottom: 1px solid var(--border);
      color: var(--text);
      font-size: .85rem;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--surface); }
    .badge {
      display: inline-block;
      padding: .15rem .5rem;
      border-radius: 999px;
      font-size: .7rem;
      font-weight: 600;
    }
    .badge--verified  { background: #1a3a1a; color: #4caf50; }
    .badge--pending   { background: #2a2010; color: #ff9800; }
    .badge--sent      { background: #1a2a3a; color: #64b5f6; }
    .badge--failed    { background: #3a1a1a; color: #ef5350; }
    html.light .badge--verified { background: #e6f4ea; color: #2e7d32; }
    html.light .badge--pending  { background: #fff3e0; color: #e65100; }
    html.light .badge--sent     { background: #e3f2fd; color: #1565c0; }
    html.light .badge--failed   { background: #fce4ec; color: #c62828; }
    .pick-card {
      display: flex;
      align-items: center;
      gap: .75rem;
    }
    .pick-cover {
      width: 36px;
      height: 36px;
      border-radius: 4px;
      object-fit: cover;
      background: var(--border);
      flex-shrink: 0;
    }
    .pick-title { font-weight: 600; font-size: .85rem; }
    .pick-artist { font-size: .75rem; color: var(--muted); }
    .note { font-size: .8rem; color: var(--muted); font-style: italic; max-width: 300px; }
    .week-tag {
      font-size: .7rem;
      color: var(--muted);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: .1rem .4rem;
    }
    .genre-edit-cell { display: flex; align-items: center; gap: .4rem; min-width: 160px; }
    .genre-current { font-size: .8rem; color: var(--muted); }
    .genre-edit-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: .9rem; padding: 0 .2rem; opacity: .6; }
    .genre-edit-btn:hover { opacity: 1; color: var(--text); }
    .genre-edit-form { display: flex; align-items: center; gap: .3rem; }
    .genre-edit-input { background: var(--surface); border: 1px solid var(--border); color: var(--text); border-radius: 4px; padding: .2rem .4rem; font-size: .8rem; width: 180px; outline: none; }
    .genre-edit-input:focus { border-color: #555; }
    .genre-save-btn { background: #fff; color: #000; border: none; border-radius: 4px; padding: .2rem .5rem; font-size: .75rem; font-weight: 600; cursor: pointer; }
    .genre-save-btn:hover { background: #ddd; }
    .genre-cancel-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: .85rem; }
    .category {
      font-size: .7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: var(--muted);
    }
    .empty { color: var(--muted); font-size: .85rem; padding: 1rem .75rem; }
    .nav-tabs {
      display: flex;
      gap: .5rem;
      margin-bottom: 2rem;
    }
    .tab {
      padding: .4rem .9rem;
      border-radius: 6px;
      font-size: .8rem;
      font-weight: 500;
      cursor: pointer;
      background: none;
      border: 1px solid var(--border);
      color: var(--muted);
      font-family: inherit;
      transition: all .15s;
    }
    .tab.active, .tab:hover {
      background: var(--surface);
      color: var(--text);
      border-color: var(--text);
    }
    .panel { display: none; }
    .panel.active { display: block; }
  </style>
</head>
<body>
  <div class="header">
    <a href="/" style="margin-right:1rem;font-size:.8rem;color:var(--muted);text-decoration:none;border:1px solid var(--border);border-radius:6px;padding:.3rem .7rem;transition:all .15s;white-space:nowrap;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--muted)'">← Back to ARVL</a>
    <h1>ARVL Admin</h1>
    <span>dashboard</span>
    <button class="theme-btn" onclick="toggleTheme()" id="theme-btn" style="margin-left:auto;">Light mode</button>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${totalUsers}</div>
      <div class="stat-label">Total members</div>
    </div>
    <div class="stat">
      <div class="stat-value">${verifiedUsers}</div>
      <div class="stat-label">Verified</div>
    </div>
    <div class="stat">
      <div class="stat-value">${picks.length}</div>
      <div class="stat-label">Total picks</div>
    </div>
    <div class="stat">
      <div class="stat-value">${supporterCount}</div>
      <div class="stat-label">Supporters</div>
    </div>
    <div class="stat">
      <div class="stat-value">${feedback.length}</div>
      <div class="stat-label">Feedback submissions</div>
    </div>
    <div class="stat">
      <div class="stat-value">${communityPosts.length}</div>
      <div class="stat-label">Community posts</div>
    </div>
  </div>

  <div style="margin:1.5rem 0 2rem">
    <h3 style="font-size:.875rem;font-weight:600;margin-bottom:.75rem;">Picks by week</h3>
    <table style="width:100%;border-collapse:collapse;font-size:.8rem;">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid var(--border,#333)">
          <th style="padding:.4rem .75rem .4rem 0">Week</th>
          <th style="padding:.4rem .75rem">Members picked</th>
          <th style="padding:.4rem 0">Total picks</th>
        </tr>
      </thead>
      <tbody>
        ${picksByWeek.map(w => `
        <tr style="border-bottom:1px solid var(--border,#222)">
          <td style="padding:.4rem .75rem .4rem 0">${w.week_key}</td>
          <td style="padding:.4rem .75rem">${w.pickers}</td>
          <td style="padding:.4rem 0">${w.total_picks}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="nav-tabs">
    <button class="tab active" onclick="showTab('members')">Members</button>
    <button class="tab" onclick="showTab('picks')">Picks</button>
    <button class="tab" onclick="showTab('community')">Community</button>
    <button class="tab" onclick="showTab('feedback')">Feedback</button>
    <button class="tab" onclick="showTab('emails')">Emails</button>
  </div>

  <!-- Members -->
  <div class="panel active" id="panel-members">
    <section>
      <h2>Members</h2>
      ${users.length === 0 ? '<p class="empty">No members yet.</p>' : `
      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Email</th>
            <th>Status</th>
            <th>Role</th>
            <th>Supporter</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(u => `
          <tr id="user-row-${u.id}">
            <td>${esc(u.username || '—')}</td>
            <td>${esc(u.email)}</td>
            <td><span class="badge ${u.verified ? 'badge--verified' : 'badge--pending'}">${u.verified ? 'Verified' : 'Pending'}</span></td>
            <td>
              <button
                class="admin-toggle-btn"
                data-user-id="${u.id}"
                data-is-admin="${u.is_admin ? '1' : '0'}"
                style="background:none;border:1px solid var(--border);border-radius:6px;padding:.2rem .6rem;font-size:.75rem;cursor:pointer;color:${u.is_admin ? '#4caf50' : 'var(--muted)'};font-family:inherit;transition:all .15s;"
              >${u.is_admin ? 'Admin' : 'Member'}</button>
            </td>
            <td>
              <button
                class="supporter-toggle-btn"
                data-user-id="${u.id}"
                data-is-supporter="${u.is_supporter ? '1' : '0'}"
                style="background:none;border:1px solid var(--border);border-radius:6px;padding:.2rem .6rem;font-size:.75rem;cursor:pointer;color:${u.is_supporter ? '#c9a84c' : 'var(--muted)'};font-family:inherit;transition:all .15s;"
              >${u.is_supporter ? '★ Yes' : '—'}</button>
            </td>
            <td>${u.joined}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </section>
  </div>

  <!-- Picks -->
  <div class="panel" id="panel-picks">
    <section>
      <h2>Picks</h2>
      ${picks.length === 0 ? '<p class="empty">No picks yet.</p>' : `
      <table>
        <thead>
          <tr>
            <th>Album</th>
            <th>Picked by</th>
            <th>Week</th>
            <th>Genre</th>
            <th>Note</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          ${picks.map(p => `
          <tr>
            <td>
              <div class="pick-card">
                ${p.cover_url ? `<img class="pick-cover" src="${esc(p.cover_url)}" alt="">` : '<div class="pick-cover"></div>'}
                <div>
                  <div class="pick-title">${esc(p.title)}</div>
                  <div class="pick-artist">${esc(p.artist)}</div>
                </div>
              </div>
            </td>
            <td>${esc(p.username || p.email)}</td>
            <td><span class="week-tag">${esc(p.week_key)}</span></td>
            <td>
              <div class="genre-edit-cell" data-id="${esc(p.spotifyId)}">
                <span class="genre-current">${p.genre ? esc(p.genre) : '<span style="color:#555">—</span>'}</span>
                <button class="genre-edit-btn" onclick="openGenreEdit(this)" title="Edit genre">✎</button>
                <div class="genre-edit-form" style="display:none">
                  <input class="genre-edit-input" type="text" value="${p.genre ? esc(p.genre) : ''}" placeholder="e.g. Electronic, Downtempo">
                  <button class="genre-save-btn" onclick="saveGenre(this)">Save</button>
                  <button class="genre-cancel-btn" onclick="cancelGenreEdit(this)">✕</button>
                </div>
              </div>
            </td>
            <td><span class="note">${p.note ? esc(p.note) : '—'}</span></td>
            <td>${p.picked_at}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </section>
  </div>

  <!-- Community -->
  <div class="panel" id="panel-community">
    <section>
      <h2>Community Posts</h2>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem" id="comm-filters">
        <button class="tab active" onclick="filterCommunity('')">All</button>
        <button class="tab" onclick="filterCommunity('discussion')">Discussion</button>
        <button class="tab" onclick="filterCommunity('feature-request')">Feature Request</button>
        <button class="tab" onclick="filterCommunity('bug')">Bug Report</button>
        <button class="tab" onclick="filterCommunity('question')">Question</button>
        <button class="tab" onclick="filterCommunity('feedback')">Feedback</button>
      </div>
      ${communityPosts.length === 0 ? '<p class="empty">No posts yet.</p>' : `
      <table id="comm-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Category</th>
            <th>Post</th>
            <th>Replies</th>
            <th>Likes</th>
            <th>Pinned</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          ${communityPosts.map(p => `
          <tr data-cat="${esc(p.category)}">
            <td>${esc(p.username)}</td>
            <td><span class="category">${esc(p.category)}</span></td>
            <td style="max-width:300px;word-break:break-word">
              <a href="/community?post=${p.id}" style="color:inherit;text-decoration:none;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${esc(p.body)}</a>
            </td>
            <td>${p.reply_count}</td>
            <td>${p.like_count}</td>
            <td>${p.pinned ? '<span class="badge badge--verified">Pinned</span>' : '—'}</td>
            <td>${p.posted_at}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </section>
  </div>

  <!-- Feedback -->
  <div class="panel" id="panel-feedback">
    <section>
      <h2>Feedback</h2>
      ${feedback.length === 0 ? '<p class="empty">No feedback yet.</p>' : `
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Type</th>
            <th>Message</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          ${feedback.map(f => `
          <tr>
            <td>${esc(f.user)}</td>
            <td><span class="category">${esc(f.category)}</span></td>
            <td>${esc(f.message)}</td>
            <td>${f.submitted_at}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </section>
  </div>

  <!-- Emails -->
  <div class="panel" id="panel-emails">
    <section>
      <h2>Email Log</h2>
      ${emailLogs.length === 0 ? '<p class="empty">No emails sent yet.</p>' : `
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Recipient</th>
            <th>Status</th>
            <th>Sent at</th>
          </tr>
        </thead>
        <tbody>
          ${emailLogs.map(e => `
          <tr>
            <td><span class="category">${esc(e.type)}</span></td>
            <td>${esc(e.recipient)}</td>
            <td><span class="badge badge--${esc(e.status)}">${esc(e.status)}</span></td>
            <td>${e.sent_at}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </section>
  </div>

  <script>
    // Theme
    const html = document.documentElement;
    const btn  = document.getElementById('theme-btn');
    if (localStorage.getItem('admin-theme') === 'light') {
      html.classList.add('light');
      btn.textContent = 'Dark mode';
    }
    function toggleTheme() {
      const isLight = html.classList.toggle('light');
      btn.textContent = isLight ? 'Dark mode' : 'Light mode';
      localStorage.setItem('admin-theme', isLight ? 'light' : 'dark');
    }

    function showTab(name) {
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-tabs .tab').forEach(t => t.classList.remove('active'));
      document.getElementById('panel-' + name).classList.add('active');
      event.target.classList.add('active');
    }

    function filterCommunity(cat) {
      document.querySelectorAll('#comm-filters .tab').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');
      const rows = document.querySelectorAll('#comm-table tbody tr');
      rows.forEach(row => {
        row.style.display = (!cat || row.dataset.cat === cat) ? '' : 'none';
      });
    }

    // Admin toggle buttons
    document.querySelectorAll('.admin-toggle-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId  = btn.dataset.userId;
        btn.disabled  = true;
        try {
          const r = await fetch('/admin/users/' + userId + '/toggle-admin', { method: 'POST' });
          if (!r.ok) throw new Error();
          const d = await r.json();
          btn.dataset.isAdmin   = d.isAdmin ? '1' : '0';
          btn.textContent       = d.isAdmin ? 'Admin' : 'Member';
          btn.style.color       = d.isAdmin ? '#4caf50' : 'var(--muted)';
        } catch {
          alert('Failed to update role.');
        } finally {
          btn.disabled = false;
        }
      });
    });

    // Supporter toggle buttons
    document.querySelectorAll('.supporter-toggle-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId = btn.dataset.userId;
        btn.disabled = true;
        try {
          const r = await fetch('/admin/users/' + userId + '/toggle-supporter', { method: 'POST' });
          if (!r.ok) throw new Error();
          const d = await r.json();
          btn.dataset.isSupporter = d.isSupporter ? '1' : '0';
          btn.textContent         = d.isSupporter ? '★ Yes' : '—';
          btn.style.color         = d.isSupporter ? '#c9a84c' : 'var(--muted)';
        } catch {
          alert('Failed to update supporter status.');
        } finally {
          btn.disabled = false;
        }
      });
    });

    function openGenreEdit(btn) {
      const cell = btn.closest('.genre-edit-cell');
      cell.querySelector('.genre-current').style.display = 'none';
      btn.style.display = 'none';
      cell.querySelector('.genre-edit-form').style.display = 'flex';
      cell.querySelector('.genre-edit-input').focus();
    }
    function cancelGenreEdit(btn) {
      const cell = btn.closest('.genre-edit-cell');
      cell.querySelector('.genre-current').style.display = '';
      cell.querySelector('.genre-edit-btn').style.display = '';
      cell.querySelector('.genre-edit-form').style.display = 'none';
    }
    async function saveGenre(btn) {
      const cell    = btn.closest('.genre-edit-cell');
      const id      = cell.dataset.id;
      const input   = cell.querySelector('.genre-edit-input');
      const genre   = input.value.trim();
      btn.disabled  = true;
      btn.textContent = '…';
      try {
        const r = await fetch('/admin/albums/' + encodeURIComponent(id) + '/genre', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ genre }),
        });
        if (!r.ok) throw new Error((await r.json()).error || 'Error');
        cell.querySelector('.genre-current').innerHTML = genre || '<span style="color:#555">—</span>';
        cancelGenreEdit(btn);
      } catch (err) {
        alert('Failed to save genre: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    }
  </script>
</body>
</html>`;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  res.send(html);
});

// ── POST /admin/users/:id/toggle-admin ────────────────────
router.post('/users/:id/toggle-admin', requireAdmin, async (req, res) => {
  try {
    const db   = await getDb();
    const user = await db.get('SELECT id, is_admin FROM users WHERE id = ?', req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const newVal = user.is_admin ? 0 : 1;
    await db.run('UPDATE users SET is_admin = ? WHERE id = ?', newVal, user.id);
    res.json({ isAdmin: !!newVal });
  } catch (err) {
    console.error('toggle-admin error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /admin/users/:id/toggle-supporter ────────────────
router.post('/users/:id/toggle-supporter', requireAdmin, async (req, res) => {
  try {
    const db   = await getDb();
    const user = await db.get('SELECT id, is_supporter FROM users WHERE id = ?', req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const newVal = user.is_supporter ? 0 : 1;
    await db.run('UPDATE users SET is_supporter = ? WHERE id = ?', newVal, user.id);
    res.json({ isSupporter: !!newVal });
  } catch (err) {
    console.error('toggle-supporter error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /admin/albums/:spotifyId/genre ───────────────────
// Admin override — sets genre regardless of existing value.
router.post('/albums/:spotifyId/genre', requireAdmin, async (req, res) => {
  try {
    const db    = await getDb();
    const genre = typeof req.body.genre === 'string' ? req.body.genre.trim() : null;
    const result = await db.run(
      'UPDATE albums SET genre = ? WHERE spotify_id = ?',
      genre || null, req.params.spotifyId
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Album not found.' });
    res.json({ ok: true, genre: genre || null });
  } catch (err) {
    console.error('Admin genre update error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /admin/test-email ─────────────────────────────────
// ?secret=...&type=opener|nudge&to=email@example.com
// If `to` is provided, sends directly to that address (test mode).
// Otherwise fires to all eligible recipients.
router.get('/test-email', requireSecret, async (req, res) => {
  const { type, to } = req.query;
  if (!type || !['opener', 'nudge'].includes(type)) {
    return res.status(400).json({ error: 'type must be opener or nudge' });
  }

  if (to) {
    const mailer   = require('../lib/mailer');
    const { buildEmail, isoWeekKey, weekNumber } = scheduler;
    const weekKey  = isoWeekKey();
    const weekNum  = weekNumber(weekKey);
    const BASE_URL = process.env.BASE_URL || 'https://arvl.app';
    const name     = req.query.username || 'there';
    const theme    = req.query.theme || 'dark';

    const subject = type === 'opener' ? 'A new week is open' : "You haven't picked yet";
    const html    = type === 'opener'
      ? buildEmail({
          eyebrow:  'Weekly pick',
          heading:  `Week ${weekNum} is open.`,
          body:     `What are you listening to this week, ${name}? Submit your pick and see what the community is into.`,
          ctaLabel: 'Submit your pick',
          theme,
        })
      : buildEmail({
          eyebrow:  'Reminder',
          heading:  "The week's still open.",
          body:     `Hey ${name}, you haven't submitted your pick for Week ${weekNum} yet. What's been on repeat? And if you need some inspiration, check out what the community is already recommending this week.`,
          ctaLabel: 'Submit your pick',
          theme,
        });

    try {
      await mailer.sendMail({
        from:    `"ARVL" <${process.env.MAIL_FROM}>`,
        to,
        subject,
        text:    subject,
        html,
      });
      return res.json({ ok: true, sent: type, to });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // No `to` — fire to all eligible recipients
  if (type === 'opener') scheduler.sendWeeklyOpener().catch(console.error);
  if (type === 'nudge')  scheduler.sendNudge().catch(console.error);
  res.json({ ok: true, sent: type, to: 'all eligible members' });
});

module.exports = router;
