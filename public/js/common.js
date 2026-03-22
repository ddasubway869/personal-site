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
    // Only cache when logged in — never cache null, so a login on the same
    // page doesn't get blocked by a stale anonymous-visit null entry
    if (user) { try { sessionStorage.setItem(_U_KEY, JSON.stringify(user)); } catch {} }
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
        ${user && window.location.pathname !== '/' ? `
          <button class="hdr-search-btn" id="hdr-search-btn" aria-label="Search albums">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>` : ''}
        ${user ? `<nav class="header-nav">
          <a href="/community" class="nav-link${cls('community')}">Community</a>
          ${user.isAdmin ? `<a href="/admin/dashboard" class="nav-link${cls('admin')}">Admin</a>` : ''}
        </nav>` : ''}
        ${user ? `
          <div class="user-menu">
            <button class="user-menu-btn" id="hdr-chip">${esc(uname)}</button>
            <div class="user-menu-dropdown" id="hdr-dropdown" hidden>
              <a href="/u/${encodeURIComponent(uname)}" class="user-menu-item">My Shelf</a>
              <a href="/settings" class="user-menu-item">Settings</a>
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

  // ── Header search panel (non-home pages) ─────────────────
  if (user && window.location.pathname !== '/') {
    const _closeSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
    const _backSvg  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>`;

    if (!document.getElementById('hdr-search-panel')) {
      const _pw = document.createElement('div');
      _pw.innerHTML = `
        <div class="sp-overlay" id="hdr-sp-overlay" hidden></div>
        <aside class="search-panel" id="hdr-search-panel" hidden aria-label="Search results">
          <div class="sp-inner">
            <div class="sp-header">
              <button class="sp-back-btn" id="hdr-sp-back" aria-label="Close search">${_backSvg}</button>
              <input class="sp-search-input" id="hdr-sp-input" type="search" placeholder="Search albums…" autocomplete="off" spellcheck="false" />
            </div>
            <div class="sp-body" id="hdr-sp-body">
              <p class="sp-loading">Start typing to search…</p>
            </div>
          </div>
        </aside>
        <div class="modal-overlay" id="hdr-modal-pick" hidden>
          <div class="modal" role="dialog" aria-modal="true">
            <button class="modal-close" id="hdr-pick-close" aria-label="Close">${_closeSvg}</button>
            <h2 class="modal-title">Submit your pick</h2>
            <div class="pick-note-album-preview" id="hdr-pick-preview"></div>
            <div id="hdr-genre-wrap" style="display:flex;flex-direction:column;gap:.5rem;margin-bottom:.75rem">
              <div class="genre-card">
                <p class="genre-card-label">Primary Genre</p>
                <div class="genre-pill-group" id="hdr-genre-pills">
                  <button type="button" class="genre-pill" data-genre="Hip-Hop">Hip-Hop</button>
                  <button type="button" class="genre-pill" data-genre="R&amp;B / Soul">R&amp;B / Soul</button>
                  <button type="button" class="genre-pill" data-genre="Pop">Pop</button>
                  <button type="button" class="genre-pill" data-genre="Rock">Rock</button>
                  <button type="button" class="genre-pill" data-genre="Electronic">Electronic</button>
                  <button type="button" class="genre-pill" data-genre="Jazz">Jazz</button>
                  <button type="button" class="genre-pill" data-genre="Classical">Classical</button>
                  <button type="button" class="genre-pill" data-genre="Folk &amp; Country">Folk &amp; Country</button>
                  <button type="button" class="genre-pill" data-genre="Metal">Metal</button>
                  <button type="button" class="genre-pill" data-genre="World">World</button>
                  <button type="button" class="genre-pill" data-genre="Ambient">Ambient</button>
                  <button type="button" class="genre-pill" data-genre="Funk">Funk</button>
                  <button type="button" class="genre-pill" data-genre="Blues">Blues</button>
                </div>
              </div>
              <div class="genre-card" id="hdr-subgenre-card" style="display:none">
                <p class="genre-card-label">Sub-genre <span class="form-label-opt">(optional)</span></p>
                <div class="genre-pill-group" id="hdr-subgenre-pills"></div>
              </div>
              <input type="hidden" id="hdr-genre-value" value="">
            </div>
            <label class="form-label" for="hdr-pick-note">Tell us why <span class="form-label-opt">(optional)</span></label>
            <textarea class="pick-note-textarea" id="hdr-pick-note" placeholder="What makes this album special?" maxlength="150" rows="3"></textarea>
            <p class="pick-note-count"><span id="hdr-pick-chars">0</span> / 150</p>
            <div class="modal-actions">
              <button class="btn btn-ghost" id="hdr-pick-cancel">Cancel</button>
              <button class="btn btn-submit" id="hdr-pick-submit">Submit pick</button>
            </div>
            <p class="form-status" id="hdr-pick-status" aria-live="polite"></p>
          </div>
        </div>
      `;
      document.body.appendChild(_pw);
    }

    // ── State ──
    let _hdrPickId      = null;
    let _hdrCrateIds    = new Set();
    let _hdrLLIds       = new Set();
    let _hdrPending     = null;
    let _hdrStateLoaded = false;
    let _hdrTimer       = null;
    let _hdrStreamEl    = null;

    const _HDR_SUBGENRES = {
      'Hip-Hop':        ['Trap','Boom Bap','G-Funk','Drill','Conscious Rap','Mumble Rap','Lo-Fi Hip-Hop','Jazz Rap','Southern Rap','Crunk','Bounce','Emo Rap','Alternative','Experimental','Chillhop'],
      'R&B / Soul':     ['Contemporary R&B','Neo-Soul','New Jack Swing','Hip-Hop Soul','Trap-Soul','Alternative R&B','Doo-Wop'],
      'Pop':            ['Pop Rock','Electropop','Synth-Pop','Teen Pop','Dance-Pop','Disco-Pop','Indie Pop','Pop-R&B','Bedroom Pop','Traditional Pop','Psychedelic Pop'],
      'Rock':           ['Classic Rock','Hard Rock','Punk Rock','Grunge','Post-Grunge','Alternative Rock','Indie Rock','Pop-Punk','Progressive Rock','Glam Rock','Electronic Rock','Post-Punk','New Wave','Shoegaze','Dream Pop','Math Rock'],
      'Electronic':     ['House','Techno','Dubstep','Drum n Bass','Trance','Hardstyle','Trip-Hop','Downtempo','Experimental','Electro & Fusion'],
      'Jazz':           ['Dixieland','Swing','Bebop','Cool Jazz','Hard Bop','Modal Jazz','Fusion','Smooth Jazz','Latin Jazz','Free Jazz','Neo-Bop','Spiritual Jazz'],
      'Metal':          ['Thrash Metal','Death Metal','Black Metal','Progressive Metal','Metalcore','Groove Metal','Symphonic Metal','Nu Metal','Blackened Deathcore','Djent'],
      'Classical':      ['Baroque','Classical','Romantic','Modernism & Avant-Garde','Minimalism','Contemporary Classical'],
      'Folk & Country': ['Folk Rock','Indie Folk','Celtic Folk','Bluegrass','Anti-Folk','Folk Metal','Americana','Outlaw Country','Country Pop','Bro-Country','Red Dirt','Nashville Sound','Honky-Tonk'],
      'World':          ['Afrobeats','Reggaeton','Salsa','Bachata','Regional Mexican','Bongo Flava','Worldbeat','K-Pop','Brazil','Africa','Asia'],
      'Ambient':        ['Dark Ambient','Drone','Nature Sounds','Space Ambient','Neo-Classical Ambient','Ambient Electronic'],
      'Funk':           ['P-Funk','Funk Rock','Go-Go','Boogie','Afrofunk','Jazz-Funk','Electrofunk'],
      'Blues':          ['Delta Blues','Chicago Blues','Texas Blues','Piedmont Blues','Jump Blues','Swamp Blues','Soul Blues','British Blues'],
    };

    // Lazy-load pick/crate state (fires once on first panel open)
    async function _hdrLoadState() {
      if (_hdrStateLoaded) return;
      _hdrStateLoaded = true;
      try {
        const uname = user.username || user.email?.split('@')[0];
        const [recR, profR] = await Promise.all([
          fetch('/recommendations/me'),
          uname ? fetch(`/u/${encodeURIComponent(uname)}`, { headers: { Accept: 'application/json' } }) : Promise.resolve(null),
        ]);
        if (recR.ok) { const d = await recR.json(); _hdrPickId = d.recommendation?.spotifyId ?? null; }
        if (profR?.ok) {
          const d = await profR.json();
          _hdrCrateIds = new Set((d.crate       || []).map(a => a.spotifyId));
          _hdrLLIds    = new Set((d.listenLater  || []).map(a => a.spotifyId));
        }
      } catch {}
    }

    // Panel open / close
    function _hdrOpenPanel() {
      const panel   = document.getElementById('hdr-search-panel');
      const overlay = document.getElementById('hdr-sp-overlay');
      overlay.hidden = false;
      panel.hidden   = false;
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('sp-open')));
      document.getElementById('hdr-sp-input').focus();
      _hdrLoadState();
    }

    function _hdrClosePanel() {
      const panel   = document.getElementById('hdr-search-panel');
      const overlay = document.getElementById('hdr-sp-overlay');
      panel.classList.remove('sp-open');
      document.body.style.overflow = '';
      panel.addEventListener('transitionend', () => {
        panel.hidden   = true;
        overlay.hidden = true;
      }, { once: true });
    }

    // Stream popover
    function _hdrCloseStreamPop() {
      if (_hdrStreamEl) { _hdrStreamEl.remove(); _hdrStreamEl = null; }
    }

    function _hdrOpenStreamPop(btn, album) {
      document.removeEventListener('click', _hdrCloseStreamPop);
      _hdrCloseStreamPop();
      const q     = encodeURIComponent(album.title + ' ' + album.artist);
      const sHref = (album._deezer || String(album.spotifyId).startsWith('dz_'))
        ? `https://open.spotify.com/search/${q}`
        : `https://open.spotify.com/album/${album.spotifyId}`;
      const rect = btn.getBoundingClientRect();
      _hdrStreamEl = document.createElement('div');
      _hdrStreamEl.className = 'stream-popover';
      _hdrStreamEl.innerHTML = `
        <a class="stream-option stream-option--spotify" href="${sHref}" target="_blank" rel="noopener">Spotify</a>
        <a class="stream-option stream-option--apple"   href="https://music.apple.com/us/search?term=${q}" target="_blank" rel="noopener">Apple Music</a>
        <a class="stream-option stream-option--tidal"   href="https://tidal.com/search/albums?q=${q}" target="_blank" rel="noopener">Tidal</a>
        <a class="stream-option stream-option--deezer"  href="https://www.deezer.com/search/${encodeURIComponent((album.title + ' ' + album.artist).toLowerCase())}/album" target="_blank" rel="noopener">Deezer</a>
      `;
      _hdrStreamEl.style.top   = `${rect.bottom + 6}px`;
      _hdrStreamEl.style.right = `${window.innerWidth - rect.right}px`;
      document.body.appendChild(_hdrStreamEl);
      setTimeout(() => document.addEventListener('click', _hdrCloseStreamPop, { once: true }), 0);
    }

    // Build an album row for the results list
    function _hdrMakeRow(album) {
      const bg      = album.coverUrl ? `style="background-image:url('${esc(album.coverUrl)}')"` : '';
      const inCrate = _hdrCrateIds.has(album.spotifyId);
      const inLL    = _hdrLLIds.has(album.spotifyId);
      const isPick  = album.spotifyId === _hdrPickId;
      const uname   = user.username || user.email?.split('@')[0];
      const row = document.createElement('div');
      row.className = 'sp-list-row';
      row.innerHTML = `
        <button class="sp-list-main" aria-label="Open ${esc(album.title)}">
          <div class="sp-list-cover" ${bg}></div>
          <div class="sp-list-info">
            <span class="sp-list-title">${esc(album.title)}</span>
            <span class="sp-list-artist">${esc(album.artist)}</span>
            ${album.releaseYear ? `<span class="sp-list-year">${esc(album.releaseYear)}</span>` : ''}
          </div>
        </button>
        <div class="sp-list-actions">
          <button class="btn-stream" title="Stream">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
          </button>
          <button class="btn-add ${inCrate ? 'btn-add--active' : ''}" title="Add to collection">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <g class="icon-plus"><line x1="12" y1="4" x2="12" y2="20"/><line x1="4" y1="12" x2="20" y2="12"/></g>
              <polyline class="icon-check" points="4,13 9,18 20,7"/>
            </svg>
          </button>
          <button class="btn-ll ${inLL ? 'btn-ll--active' : ''}" title="Listen later">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9"/>
              <polyline points="12,7 12,12 15,15"/>
            </svg>
          </button>
          <button class="btn-pick ${isPick ? 'btn-pick--active' : ''}" data-sid="${esc(album.spotifyId)}" ${isPick ? 'disabled' : ''}>
            ${isPick ? 'Your pick ✓' : 'Recommend'}
          </button>
        </div>
      `;

      row.querySelector('.sp-list-main').addEventListener('click', () => {
        location.href = '/album/' + album.spotifyId;
      });

      row.querySelector('.btn-stream').addEventListener('click', e => {
        e.stopPropagation();
        _hdrOpenStreamPop(e.currentTarget, album);
      });

      const ensureInDb = async () => {
        if (album._deezer) await fetch(`/albums/${encodeURIComponent(album.spotifyId)}`).catch(() => {});
      };

      const addBtn = row.querySelector('.btn-add');
      addBtn.addEventListener('click', async e => {
        e.stopPropagation();
        await ensureInDb();
        const r = await fetch(`/crate/${encodeURIComponent(album.spotifyId)}`, { method: 'POST' });
        if (!r.ok) return;
        const d = await r.json();
        addBtn.classList.toggle('btn-add--active', d.inCrate);
        _hdrCrateIds[d.inCrate ? 'add' : 'delete'](album.spotifyId);
        showToast(d.inCrate
          ? `Added to <a class="toast-link" href="/u/${encodeURIComponent(uname)}?tab=crate">Collection</a>`
          : 'Removed from Collection');
      });

      const llBtn = row.querySelector('.btn-ll');
      llBtn.addEventListener('click', async e => {
        e.stopPropagation();
        await ensureInDb();
        const r = await fetch(`/listen-later/${encodeURIComponent(album.spotifyId)}`, { method: 'POST' });
        if (!r.ok) return;
        const d = await r.json();
        llBtn.classList.toggle('btn-ll--active', d.inListenLater);
        _hdrLLIds[d.inListenLater ? 'add' : 'delete'](album.spotifyId);
        showToast(d.inListenLater
          ? `Added to <a class="toast-link" href="/u/${encodeURIComponent(uname)}?tab=later">Listen Later</a>`
          : 'Removed from Listen Later');
      });

      row.querySelector('.btn-pick').addEventListener('click', () => _hdrOpenPickModal(album));

      return row;
    }

    // Render search results into the panel
    function _hdrRenderResults(artists, albums) {
      const body = document.getElementById('hdr-sp-body');
      if (!artists.length && !albums.length) {
        body.innerHTML = '<p class="sp-loading">No results found.</p>';
        return;
      }
      body.innerHTML = '';

      if (artists.length) {
        const lbl = document.createElement('p');
        lbl.className = 'sp-section-label';
        lbl.textContent = 'Artists';
        body.appendChild(lbl);
        const list = document.createElement('div');
        list.className = 'sp-list';
        artists.forEach(artist => {
          const bg  = artist.imageUrl ? `style="background-image:url('${esc(artist.imageUrl)}')"` : '';
          const row = document.createElement('button');
          row.className = 'sp-list-row';
          row.innerHTML = `
            <div class="sp-list-cover sp-list-cover--artist" ${bg}></div>
            <div class="sp-list-info">
              <span class="sp-list-title">${esc(artist.name)}</span>
              <span class="sp-list-artist">Artist</span>
            </div>
          `;
          row.addEventListener('click', () => window.open('https://open.spotify.com/artist/' + artist.spotifyId, '_blank'));
          list.appendChild(row);
        });
        body.appendChild(list);
      }

      if (albums.length) {
        const lbl = document.createElement('p');
        lbl.className = 'sp-section-label';
        lbl.textContent = 'Albums';
        body.appendChild(lbl);
        const list = document.createElement('div');
        list.className = 'sp-list';
        albums.forEach(album => list.appendChild(_hdrMakeRow(album)));
        body.appendChild(list);
      }
    }

    // Fetch and display search results
    async function _hdrDoSearch(q) {
      const body = document.getElementById('hdr-sp-body');
      body.innerHTML = '<p class="sp-loading">Searching…</p>';
      try {
        const r = await fetch(`/search?q=${encodeURIComponent(q)}`);
        const d = await r.json();
        _hdrRenderResults(d.artists ?? [], d.albums ?? []);
      } catch {
        body.innerHTML = '<p class="sp-loading">Search failed. Try again.</p>';
      }
    }

    // Pick modal
    function _hdrOpenPickModal(album) {
      _hdrPending = album;
      const bg = album.coverUrl ? `style="background-image:url('${esc(album.coverUrl)}')"` : '';
      document.getElementById('hdr-pick-preview').innerHTML = `
        <div class="pick-note-cover" ${bg}></div>
        <div class="pick-note-meta">
          <p class="pick-note-title">${esc(album.title)}</p>
          <p class="pick-note-artist">${esc(album.artist)}</p>
        </div>
      `;
      document.getElementById('hdr-genre-value').value = '';
      document.querySelectorAll('#hdr-genre-pills .genre-pill').forEach(p => p.classList.remove('genre-pill--active'));
      document.getElementById('hdr-subgenre-card').style.display = 'none';
      document.getElementById('hdr-subgenre-pills').innerHTML   = '';
      document.getElementById('hdr-pick-note').value             = '';
      document.getElementById('hdr-pick-chars').textContent      = '0';
      document.getElementById('hdr-pick-status').textContent     = '';
      document.getElementById('hdr-modal-pick').hidden           = false;
    }

    async function _hdrDoRecommend(album, note, genre) {
      try {
        const r = await fetch('/recommendations', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ ...album, note, genre }),
        });
        const d = await r.json();
        if (!r.ok) { showToast(d.error || 'Error saving pick.', 'err'); return; }
        _hdrPickId = album.spotifyId;
        document.querySelectorAll('#hdr-search-panel .btn-pick').forEach(btn => {
          const isThis = btn.dataset.sid === album.spotifyId;
          btn.textContent = isThis ? 'Your pick ✓' : 'Recommend';
          btn.classList.toggle('btn-pick--active', isThis);
          btn.disabled = true;
        });
        showToast(`Picked "${esc(album.title)}"! Resets in ${timeUntilReset()}`);
        document.getElementById('hdr-modal-pick').hidden = true;
      } catch {
        showToast('Error saving pick.', 'err');
      }
    }

    // ── Wire events ──────────────────────────────────────────
    document.getElementById('hdr-search-btn').addEventListener('click', _hdrOpenPanel);
    document.getElementById('hdr-sp-overlay').addEventListener('click', _hdrClosePanel);
    document.getElementById('hdr-sp-back').addEventListener('click', _hdrClosePanel);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !document.getElementById('hdr-search-panel').hidden) _hdrClosePanel();
    });

    const _hdrInput = document.getElementById('hdr-sp-input');
    _hdrInput.addEventListener('input', e => {
      clearTimeout(_hdrTimer);
      const q = e.target.value.trim();
      if (!q) { document.getElementById('hdr-sp-body').innerHTML = '<p class="sp-loading">Start typing to search…</p>'; return; }
      _hdrTimer = setTimeout(() => _hdrDoSearch(q), 380);
    });
    _hdrInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { clearTimeout(_hdrTimer); const q = _hdrInput.value.trim(); if (q) _hdrDoSearch(q); }
    });

    // Genre pills
    document.getElementById('hdr-genre-pills').addEventListener('click', e => {
      const pill = e.target.closest('.genre-pill');
      if (!pill) return;
      document.querySelectorAll('#hdr-genre-pills .genre-pill').forEach(p => p.classList.remove('genre-pill--active'));
      pill.classList.add('genre-pill--active');
      const core    = pill.dataset.genre;
      document.getElementById('hdr-genre-value').value       = core;
      document.getElementById('hdr-pick-status').textContent = '';
      const subs    = _HDR_SUBGENRES[core] || [];
      const subEl   = document.getElementById('hdr-subgenre-pills');
      const subCard = document.getElementById('hdr-subgenre-card');
      if (subs.length) {
        subEl.innerHTML = subs.map(s => `<button type="button" class="genre-pill genre-pill--sub" data-subgenre="${s}">${s}</button>`).join('');
        subCard.style.display = '';
      } else {
        subEl.innerHTML = '';
        subCard.style.display = 'none';
      }
    });

    document.getElementById('hdr-subgenre-pills').addEventListener('click', e => {
      const pill = e.target.closest('.genre-pill--sub');
      if (!pill) return;
      const core = document.querySelector('#hdr-genre-pills .genre-pill--active')?.dataset.genre || '';
      if (pill.classList.contains('genre-pill--active')) {
        pill.classList.remove('genre-pill--active');
        document.getElementById('hdr-genre-value').value = core;
      } else {
        document.querySelectorAll('#hdr-subgenre-pills .genre-pill--sub').forEach(p => p.classList.remove('genre-pill--active'));
        pill.classList.add('genre-pill--active');
        document.getElementById('hdr-genre-value').value = core ? `${core}, ${pill.dataset.subgenre}` : pill.dataset.subgenre;
      }
    });

    document.getElementById('hdr-pick-note').addEventListener('input', e => {
      document.getElementById('hdr-pick-chars').textContent = e.target.value.length;
    });

    const _hdrClosePickModal = () => { document.getElementById('hdr-modal-pick').hidden = true; };
    document.getElementById('hdr-pick-close').addEventListener('click', _hdrClosePickModal);
    document.getElementById('hdr-pick-cancel').addEventListener('click', _hdrClosePickModal);
    document.getElementById('hdr-modal-pick').addEventListener('click', e => {
      if (e.target === document.getElementById('hdr-modal-pick')) _hdrClosePickModal();
    });

    document.getElementById('hdr-pick-submit').addEventListener('click', async () => {
      const note   = document.getElementById('hdr-pick-note').value.trim() || null;
      const genre  = document.getElementById('hdr-genre-value').value || null;
      const status = document.getElementById('hdr-pick-status');
      const btn    = document.getElementById('hdr-pick-submit');
      if (!genre) { status.textContent = 'Please select a genre.'; status.className = 'form-status err'; return; }
      btn.disabled = true;
      await _hdrDoRecommend(_hdrPending, note, genre);
      btn.disabled = false;
    });
  }

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
            <p class="modal-switch"><button class="link-btn" id="sw-to-forgot">Forgot password?</button></p>
            <p class="modal-switch">No account? <button class="link-btn" id="sw-to-reg">Sign up</button></p>
          </div>
        </div>
        <div class="modal-overlay" id="modal-forgot" hidden>
          <div class="modal" role="dialog" aria-modal="true">
            <button class="modal-close" data-auth-close aria-label="Close">${closeSvg}</button>
            <h2 class="modal-title">Reset password</h2>
            <form id="form-forgot" novalidate>
              <div class="field"><label for="forgot-email">Email</label><input id="forgot-email" type="email" placeholder="you@example.com" autocomplete="email" required /></div>
              <button type="submit" class="btn btn-submit">Send reset link</button>
              <p class="form-status" id="forgot-status" aria-live="polite"></p>
            </form>
            <p class="modal-switch">Back to <button class="link-btn" id="sw-to-login-from-forgot">Log in</button></p>
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
      document.getElementById('sw-to-reg').addEventListener('click',              () => { _close(); _open('modal-register'); });
      document.getElementById('sw-to-login').addEventListener('click',            () => { _close(); _open('modal-login'); });
      document.getElementById('sw-to-forgot').addEventListener('click',           () => { _close(); _open('modal-forgot'); });
      document.getElementById('sw-to-login-from-forgot').addEventListener('click',() => { _close(); _open('modal-login'); });

      document.getElementById('form-forgot').addEventListener('submit', async e => {
        e.preventDefault();
        const status = document.getElementById('forgot-status');
        const btn    = e.target.querySelector('[type=submit]');
        btn.disabled = true; btn.textContent = 'Sending…';
        status.textContent = ''; status.className = 'form-status';
        try {
          await fetch('/auth/forgot', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: document.getElementById('forgot-email').value.trim() }),
          });
          status.textContent = 'If that email is registered, a reset link is on its way.';
          btn.textContent = 'Sent';
        } catch {
          status.textContent = 'Something went wrong.'; status.className = 'form-status err';
          btn.disabled = false; btn.textContent = 'Send reset link';
        }
      });

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
          sessionStorage.removeItem('arvl_u4');
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
          sessionStorage.removeItem('arvl_u4');
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
      sessionStorage.removeItem('arvl_u4');
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
