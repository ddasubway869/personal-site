'use strict';

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function relativeTime(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)         return 'just now';
  if (diff < 3600)       return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)      return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function showToast(msg, duration = 2800) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--visible'));
  setTimeout(() => {
    t.classList.remove('toast--visible');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
  }, duration);
}

function timeUntilReset() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun … 6=Sat
  const daysUntil = day === 1 ? 7 : (8 - day) % 7;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntil);
  next.setHours(0, 0, 0, 0);
  const totalH = Math.floor((next - now) / 3600000);
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

// Apply saved theme immediately on script load
(function () {
  if (localStorage.getItem('theme') === 'light')
    document.documentElement.classList.replace('dark', 'light');
})();

// initHeader({ active }) — renders the site header into <header id="site-header">
// active: 'community' | 'notifications' | null
// Returns: the user object (or null if logged out)
async function initHeader({ active = null } = {}) {
  const header = document.getElementById('site-header');
  if (!header) return null;

  const _U_KEY = 'arvl_u4'; // bumped to bust caches missing seenSplash
  let user = null;

  // Use cached user on navigation; only fetch when cache is empty
  const _cached = sessionStorage.getItem(_U_KEY);
  if (_cached !== null) {
    try { user = JSON.parse(_cached); } catch {}
  } else {
    try {
      const r = await fetch('/auth/me');
      if (r.ok) { const d = await r.json(); user = d.user || null; }
    } catch {}
    try { sessionStorage.setItem(_U_KEY, JSON.stringify(user)); } catch {}
  }

  const uname = user ? (user.username || user.email.split('@')[0]) : null;
  const cls   = (name) => active === name ? ' nav-link--active' : '';

  const themeSvg = `<button class="theme-toggle" id="hdr-theme" aria-label="Toggle theme">
    <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
    <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
  </button>`;

  const bellSvg = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;

  header.className = 'site-header';
  header.innerHTML = `
    <div class="header-inner">
      <a href="/" class="brand">ARVL</a>
      <div class="header-right">
        ${user ? `<button class="btn-nav btn-spotify" id="hdr-btn-spotify">Connect <svg class="spotify-logo" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg></button>` : ''}
        ${user ? `<nav class="header-nav">
          <a href="/community" class="nav-link${cls('community')}">Community</a>
          <a href="/archive" class="nav-link${cls('archive')}">Archive</a>
          ${user.isAdmin ? `<a href="/admin/dashboard" class="nav-link${cls('admin')}">Admin</a>` : ''}
        </nav>` : ''}
        ${user ? `
          <div class="user-menu">
            <button class="user-menu-btn" id="hdr-chip">${esc(uname)}</button>
            <div class="user-menu-dropdown" id="hdr-dropdown" hidden>
              <a href="/u/${encodeURIComponent(uname)}" class="user-menu-item">My Shelf</a>
              ${user.isSupporter
                ? `<span class="user-menu-item user-menu-item--supporter">Supporter <span class="supporter-star">★</span></span>`
                : `<button class="user-menu-item" id="hdr-support">Support ARVL <span class="supporter-star">★</span></button>`}
              <button class="user-menu-item" id="hdr-logout">Sign out</button>
            </div>
          </div>
          <div class="notif-bell-wrap">
            <button class="notif-bell-btn" id="notif-bell" aria-label="Notifications">
              ${bellSvg}
              <span class="notif-dot" id="notif-dot" hidden></span>
            </button>
            <div class="notif-dropdown" id="notif-dropdown" hidden></div>
          </div>
        ` : `
          <button class="btn-nav" id="hdr-btn-login">Log in</button>
          <button class="btn-nav btn-nav--join" id="hdr-btn-join">Join the club</button>
        `}
        ${themeSvg}
      </div>
    </div>`;

  // Theme toggle
  document.getElementById('hdr-theme').addEventListener('click', () => {
    const html = document.documentElement;
    const light = html.classList.contains('light');
    html.classList.replace(light ? 'light' : 'dark', light ? 'dark' : 'light');
    localStorage.setItem('theme', light ? 'dark' : 'light');
  });

  if (!user) {
    document.getElementById('hdr-btn-login').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('hdr:login'));
    });
    document.getElementById('hdr-btn-join').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('hdr:join'));
    });

    // Inject shared auth modals on pages that don't have their own
    if (!document.getElementById('modal-login')) {
      const closeSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div class="modal-overlay" id="modal-login" hidden>
          <div class="modal" role="dialog" aria-modal="true">
            <button class="modal-close" data-auth-close aria-label="Close">${closeSvg}</button>
            <h2 class="modal-title">Log in</h2>
            <form id="form-login" novalidate>
              <div class="field"><label for="l-email">Email</label><input id="l-email" type="email" placeholder="you@example.com" autocomplete="email" required /></div>
              <div class="field"><label for="l-pass">Password</label><input id="l-pass" type="password" placeholder="••••••••" autocomplete="current-password" required /></div>
              <button type="submit" class="btn btn-submit">Log in</button>
              <p class="form-status" id="login-status" aria-live="polite"></p>
            </form>
            <p class="modal-switch">No account? <button class="link-btn" id="sw-to-reg">Sign up</button></p>
          </div>
        </div>
        <div class="modal-overlay" id="modal-register" hidden>
          <div class="modal" role="dialog" aria-modal="true">
            <button class="modal-close" data-auth-close aria-label="Close">${closeSvg}</button>
            <h2 class="modal-title">Join ARVL</h2>
            <form id="form-register" novalidate>
              <div class="field"><label for="r-username">Username</label><input id="r-username" type="text" placeholder="your_name" autocomplete="username" required /><span class="field-hint">3–20 characters, letters, numbers, _ or -</span></div>
              <div class="field"><label for="r-email">Email</label><input id="r-email" type="email" placeholder="you@example.com" autocomplete="email" required /></div>
              <div class="field"><label for="r-pass">Password</label><input id="r-pass" type="password" placeholder="At least 8 characters" autocomplete="new-password" required /></div>
              <button type="submit" class="btn btn-submit">Join the club</button>
              <p class="form-status" id="reg-status" aria-live="polite"></p>
            </form>
            <p class="modal-switch">Already a member? <button class="link-btn" id="sw-to-login">Log in</button></p>
          </div>
        </div>`;
      document.body.appendChild(wrap);

      const _open  = id => { const el = document.getElementById(id); el.hidden = false; el.querySelector('input')?.focus(); };
      const _close = ()  => { document.getElementById('modal-login').hidden = true; document.getElementById('modal-register').hidden = true; };

      wrap.querySelectorAll('[data-auth-close]').forEach(b => b.addEventListener('click', _close));
      wrap.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) _close(); }));
      document.addEventListener('keydown', e => { if (e.key === 'Escape') _close(); });
      document.getElementById('sw-to-reg').addEventListener('click',   () => { _close(); _open('modal-register'); });
      document.getElementById('sw-to-login').addEventListener('click', () => { _close(); _open('modal-login'); });

      window.addEventListener('hdr:login', () => _open('modal-login'));
      window.addEventListener('hdr:join',  () => _open('modal-register'));

      // Login submit
      document.getElementById('form-login').addEventListener('submit', async e => {
        e.preventDefault();
        const status = document.getElementById('login-status');
        const btn    = e.target.querySelector('[type=submit]');
        btn.disabled = true; btn.textContent = 'Logging in…';
        status.textContent = ''; status.className = 'form-status';
        try {
          const r = await fetch('/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: document.getElementById('l-email').value.trim(), password: document.getElementById('l-pass').value }),
          });
          const d = await r.json();
          if (!r.ok) { status.textContent = d.error; status.className = 'form-status err'; btn.disabled = false; btn.textContent = 'Log in'; return; }
          sessionStorage.removeItem('arvl_u3');
          location.reload();
        } catch { status.textContent = 'Something went wrong.'; status.className = 'form-status err'; btn.disabled = false; btn.textContent = 'Log in'; }
      });

      // Register submit
      document.getElementById('form-register').addEventListener('submit', async e => {
        e.preventDefault();
        const status = document.getElementById('reg-status');
        const btn    = e.target.querySelector('[type=submit]');
        btn.disabled = true; btn.textContent = 'Joining…';
        status.textContent = ''; status.className = 'form-status';
        try {
          const r = await fetch('/auth/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: document.getElementById('r-username').value.trim(), email: document.getElementById('r-email').value.trim(), password: document.getElementById('r-pass').value }),
          });
          const d = await r.json();
          if (!r.ok) { status.textContent = d.error; status.className = 'form-status err'; btn.disabled = false; btn.textContent = 'Join the club'; return; }
          sessionStorage.removeItem('arvl_u3');
          location.reload();
        } catch { status.textContent = 'Something went wrong.'; status.className = 'form-status err'; btn.disabled = false; btn.textContent = 'Join the club'; }
      });
    }
  }

  if (user) {
    document.getElementById('hdr-btn-spotify').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('hdr:spotify'));
    });

    const chip = document.getElementById('hdr-chip');
    const drop = document.getElementById('hdr-dropdown');
    chip.addEventListener('click', e => { e.stopPropagation(); drop.hidden = !drop.hidden; });
    document.addEventListener('click', () => { drop.hidden = true; });

    document.getElementById('hdr-logout').addEventListener('click', async () => {
      sessionStorage.removeItem('arvl_u3');
      await fetch('/auth/logout', { method: 'POST' });
      location.href = '/';
    });

    if (!user.isSupporter) {
      document.getElementById('hdr-support')?.addEventListener('click', async () => {
        try {
          const r = await fetch('/support/checkout', { method: 'POST' });
          const d = await r.json();
          if (d.url) location.href = d.url;
        } catch { showToast('Something went wrong. Please try again.'); }
      });
    }

    // Notification dot
    const since = parseInt(localStorage.getItem(`notif_seen_${uname}`), 10) || 0;
    fetch(`/notifications/count?since=${since}`)
      .then(r => r.json())
      .then(d => { const dot = document.getElementById('notif-dot'); if (dot) dot.hidden = !(d.count > 0); })
      .catch(() => {});

    // Notification dropdown
    const bellBtn   = document.getElementById('notif-bell');
    const notifDrop = document.getElementById('notif-dropdown');
    let _notifClose  = null;
    let _notifLoaded = false;

    function renderNotifDrop(likes, mentions) {
      const all = [
        ...likes.map(l => ({ ...l, _type: 'like' })),
        ...mentions.map(m => ({ ...m, _type: 'mention' })),
      ].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);

      if (!all.length) {
        notifDrop.innerHTML = '<p class="nd-empty">No notifications yet.</p>';
        return;
      }

      notifDrop.innerHTML = all.map(n => {
        const initial = (n.fromUsername || '?')[0].toUpperCase();

        if (n._type === 'like') {
          const label = n.type === 'comment_like' ? 'comment'
                      : n.type === 'rec_like'     ? 'pick note'
                      : n.type === 'post_like'    ? 'post'
                      :                             'reply';
          const href      = n.spotifyId ? `/album/${esc(n.spotifyId)}` : '/community';
          const albumPart = n.albumTitle ? ` on <em>${esc(n.albumTitle)}</em>` : '';
          const coverHtml = n.coverUrl
            ? `<div class="nd-cover" style="background-image:url('${esc(n.coverUrl)}')"></div>` : '';
          return `
            <a href="${href}" class="nd-row">
              <div class="nd-avatar">${initial}</div>
              <div class="nd-body">
                <p class="nd-text"><strong>${esc(n.fromUsername)}</strong> liked your ${label}${albumPart}</p>
                <p class="nd-time">${relativeTime(n.createdAt)}</p>
              </div>
              ${coverHtml}
            </a>`;
        }

        if (n._type === 'mention') {
          return `
            <a href="/community?post=${n.postId}" class="nd-row">
              <div class="nd-avatar">${initial}</div>
              <div class="nd-body">
                <p class="nd-text"><strong>${esc(n.fromUsername)}</strong> mentioned you in a discussion</p>
                <p class="nd-time">${relativeTime(n.createdAt)}</p>
              </div>
            </a>`;
        }
        return '';
      }).join('');
    }

    bellBtn.addEventListener('click', async e => {
      e.stopPropagation();
      document.removeEventListener('click', _notifClose);

      if (!notifDrop.hidden) { notifDrop.hidden = true; return; }

      // Mark as seen immediately
      const nowTs = Math.floor(Date.now() / 1000);
      localStorage.setItem(`notif_seen_${uname}`, nowTs);
      const dot = document.getElementById('notif-dot');
      if (dot) dot.hidden = true;

      notifDrop.hidden = false;

      if (!_notifLoaded) {
        notifDrop.innerHTML = '<p class="nd-empty">Loading…</p>';
        try {
          const r = await fetch('/notifications');
          const d = await r.json();
          _notifLoaded = true;
          renderNotifDrop(d.likes || [], d.mentions || []);
        } catch {
          notifDrop.innerHTML = '<p class="nd-empty">Failed to load.</p>';
        }
      }

      setTimeout(() => {
        _notifClose = () => { notifDrop.hidden = true; };
        document.addEventListener('click', _notifClose, { once: true });
      }, 0);
    });
  }

  return user;
}
