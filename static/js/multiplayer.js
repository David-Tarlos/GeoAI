// multiplayer.js — loaded only when ROOM_CODE is set
// Connects to the server socket and manages the multiplayer game flow.

let mpSocket    = null;
let mpIsHost    = false;  // set from join_ok
let mpName      = PLAYER_NAME || sessionStorage.getItem('geoai_name') || 'Spieler';
let mpHostToken = sessionStorage.getItem('geoai_host_token') || '';
let mpGuessed   = false;
let mpTimerInt  = null;

// ── Init ──────────────────────────────────────────────────────────────────────
function mpInit() {
  // Show multiplayer player strip in topbar
  document.getElementById('mp-players-strip').style.display = 'flex';

  mpSocket = io();

  mpSocket.on('connect', () => {
    mpSocket.emit('join_room_code', { code: ROOM_CODE, name: mpName, host_token: mpHostToken });
  });

  mpSocket.on('join_ok',         onMpJoinOk);
  mpSocket.on('join_error',      d => { alert('Fehler: ' + d.msg); window.location.href = '/'; });
  mpSocket.on('lobby_update',    d => renderMpPlayers(d.players));
  mpSocket.on('round_start',     onMpRoundStart);
  mpSocket.on('guess_count',     onMpGuessCount);
  mpSocket.on('my_guess_result', onMpMyResult);
  mpSocket.on('round_results',   onMpRoundResults);
  mpSocket.on('game_over',       onMpGameOver);
  mpSocket.on('player_left',     d => { renderMpPlayers(d.players); });
  // Lobby overlay is shown only after join_ok confirms lobby state
}

// ── Lobby overlay ─────────────────────────────────────────────────────────────
function showMpLobbyOverlay() {
  let ov = document.getElementById('mp-lobby-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'mp-lobby-overlay';
    ov.innerHTML = `
      <div id="mp-lobby-box">
        <div class="mlo-title">Lobby</div>
        <div class="mlo-code-wrap">
          <div class="mlo-code-label">RAUMCODE</div>
          <div class="mlo-code">${ROOM_CODE}</div>
        </div>
        <div id="mlo-players"></div>
        <div id="mlo-status">Warte auf weitere Spieler…</div>
        <button id="mlo-start-btn" onclick="mpStartGame()" style="display:none">Spiel starten →</button>
      </div>`;
    document.body.appendChild(ov);
    injectMpStyles();
  }
  ov.style.display = 'flex';
}

function hideMpLobbyOverlay() {
  const ov = document.getElementById('mp-lobby-overlay');
  if (ov) ov.style.display = 'none';
}

function onMpJoinOk(data) {
  mpIsHost = !!data.is_host;
  renderMpPlayers(data.players);
  sessionStorage.removeItem('geoai_host');
  sessionStorage.removeItem('geoai_host_token');

  const state = data.game_state || 'lobby';
  if (state === 'lobby') {
    // Everyone sees the lobby overlay; host gets the start button
    showMpLobbyOverlay();
    if (mpIsHost) {
      const btn = document.getElementById('mlo-start-btn');
      const st  = document.getElementById('mlo-status');
      if (btn) btn.style.display = 'block';
      if (st)  st.textContent    = 'Alle bereit? Starte das Spiel!';
    }
  }
  // For starting/playing states, round_start arrives as catch-up — no lobby needed
}

function renderMpPlayers(players) {
  const el = document.getElementById('mlo-players');
  if (el) {
    el.innerHTML = players.map(p =>
      `<div class="mlo-player" style="color:${p.color}">● ${p.name}</div>`
    ).join('');
  }
  // Update topbar strip
  const strip = document.getElementById('mp-players-strip');
  if (strip) {
    strip.innerHTML = players.map(p =>
      `<div class="mp-strip-player" style="color:${p.color}" title="${p.name}">
         <span class="msp-dot">●</span>
         <span class="msp-name">${p.name}</span>
         <span class="msp-score" id="msp-${p.name.replace(/\s/g,'')}">0</span>
       </div>`
    ).join('');
  }
}

function mpStartGame() {
  if (!mpIsHost) return;
  mpSocket.emit('start_game', { code: ROOM_CODE });
}

// ── Round flow ────────────────────────────────────────────────────────────────
function onMpRoundStart(data) {
  hideMpLobbyOverlay();
  mpGuessed = false;

  // Set round header
  document.getElementById('hdr-r').textContent = data.round;
  document.getElementById('hdr-t').textContent = data.rounds;

  // Show image
  document.getElementById('g-pip-load').style.display = 'flex';
  document.getElementById('street-image').style.display = 'none';
  const img = document.getElementById('street-image');
  img.onload = () => {
    document.getElementById('g-pip-load').style.display = 'none';
    img.style.display = 'block';
  };
  img.src = 'data:image/jpeg;base64,' + data.img;

  // Store image info for guess
  currentData = { idx: data.idx, img: data.img };

  // Reset map state
  pLat = null; pLon = null;
  clearGameLayers();
  gameMap.setView([20, 0], 2);
  if (globeObj) { globeObj.pointsData([]); globeObj.arcsData([]); }

  // Reset submit bar
  document.getElementById('submit-btn').disabled = true;
  document.getElementById('guess-info').textContent = 'Klicke auf die Karte um zu raten';
  document.getElementById('guess-info').classList.remove('on');
  document.getElementById('result-panel').classList.remove('show');

  // Show waiting counter
  showMpGuessCounter(0, data.players ? data.players.length : '?');

  // Countdown timer
  startMpTimer(data.timeout || 20);
}

function showMpGuessCounter(count, total) {
  let el = document.getElementById('mp-guess-counter');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mp-guess-counter';
    document.getElementById('panel-game').appendChild(el);
  }
  el.innerHTML = `${count} / ${total} geraten`
    + (mpIsHost
        ? ` <button class="mpc-end-btn" onclick="mpForceEnd()">Runde beenden</button>`
        : '');
  el.style.display = 'block';
}

function mpForceEnd() {
  mpSocket.emit('mp_timeout', { code: ROOM_CODE });
}

function hideMpGuessCounter() {
  const el = document.getElementById('mp-guess-counter');
  if (el) el.style.display = 'none';
}

function startMpTimer(seconds) {
  if (mpTimerInt) clearInterval(mpTimerInt);
  const wrap = document.getElementById('mp-timer-wrap');
  const el   = document.getElementById('mp-timer');
  if (wrap) wrap.style.display = 'flex';
  let remaining = seconds;
  const update = () => {
    if (el) {
      el.textContent = remaining + 's';
      el.className   = remaining <= 5 ? 'urgent' : '';
    }
    if (remaining <= 0) { clearInterval(mpTimerInt); mpTimerInt = null; }
    remaining--;
  };
  update();
  mpTimerInt = setInterval(update, 1000);
}

function stopMpTimer() {
  if (mpTimerInt) { clearInterval(mpTimerInt); mpTimerInt = null; }
  const wrap = document.getElementById('mp-timer-wrap');
  if (wrap) wrap.style.display = 'none';
}

function onMpGuessCount(data) {
  showMpGuessCounter(data.count, data.total);
}

function onMpMyResult(data) {
  // Show personal result immediately
  document.getElementById('guess-info').textContent =
    `✓ Gesendet · ${data.dist.toLocaleString()} km · ${data.score.toLocaleString()} Pts`;
}

function onMpRoundResults(data) {
  stopMpTimer();
  hideMpGuessCounter();

  const { true_lat, true_lon, ai_lat, ai_lon, ai_conf,
          ai_dist, ai_score, guesses, scores, is_last } = data;

  // Draw all guesses on map
  guesses.forEach(g => {
    if (g.lat === 0 && g.lon === 0) return;
    L.marker([g.lat, g.lon], { icon: mkIcon(g.color, 14) })
      .addTo(gameMap)
      .bindTooltip(`${g.name}: ${g.dist.toLocaleString()} km · ${g.score.toLocaleString()} Pts`, { permanent: false });
    L.polyline([[g.lat, g.lon], [true_lat, true_lon]],
      { color: g.color, weight: 2, dashArray: '5,4', opacity: .7 }).addTo(gameMap);
  });

  L.marker([true_lat, true_lon], { icon: mkIcon('#ffcc00', 18) })
    .addTo(gameMap).bindTooltip('Wahrer Ort', { permanent: true, direction: 'top' });
  L.marker([ai_lat, ai_lon], { icon: mkIcon('#ff3d5a', 12) })
    .addTo(gameMap).bindTooltip(`KI · ${ai_conf}%`, { permanent: false });
  L.polyline([[ai_lat, ai_lon], [true_lat, true_lon]],
    { color: '#ff3d5a', weight: 2, dashArray: '5,4', opacity: .5 }).addTo(gameMap);

  const allPts = [[true_lat, true_lon], [ai_lat, ai_lon],
    ...guesses.filter(g => g.lat !== 0).map(g => [g.lat, g.lon])];
  gameMap.fitBounds(L.latLngBounds(allPts), { padding: [60, 60] });

  // Update topbar scores
  scores.forEach(s => {
    const el = document.getElementById('msp-' + s.name.replace(/\s/g, ''));
    if (el) el.textContent = s.score.toLocaleString();
  });

  // Show MP result panel (leaderboard)
  showMpResultPanel(scores, ai_score, ai_dist, is_last);
}

function showMpResultPanel(scores, ai_score, ai_dist, is_last) {
  // Merge AI into ranking
  const allEntries = [
    ...scores.map(s => ({ ...s, isAI: false })),
    { name: 'KI', score: ai_score, dist: ai_dist, color: '#ff3d5a', isAI: true },
  ].sort((a, b) => b.score - a.score);

  const rows = allEntries.map((s, i) => {
    const badge = s.isAI ? '🤖' : '●';
    const distTxt = s.dist != null ? `<span class="mpr-dist">${s.dist.toLocaleString()} km</span>` : '';
    return `<div class="mpr-row ${s.isAI ? 'mpr-ai' : ''}" style="--rc:${s.color}">
      <span class="mpr-rank">${i + 1}</span>
      <span class="mpr-dot">${badge}</span>
      <span class="mpr-name" style="color:${s.color}">${s.name}</span>
      ${distTxt}
      <span class="mpr-score">${s.score.toLocaleString()}</span>
    </div>`;
  }).join('');

  let ov = document.getElementById('mp-result-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'mp-result-overlay';
    document.body.appendChild(ov);
  }
  ov.innerHTML = `
    <div id="mp-result-modal">
      <div class="mpr-title">${is_last ? '🏆 Endstand' : '📍 Runden-Ergebnis'}</div>
      <div class="mpr-list">${rows}</div>
      <div class="mpr-btns">
        ${mpIsHost
          ? `<button class="mpr-btn" onclick="mpNext()">
               ${is_last ? 'Endstand anzeigen →' : 'Nächste Runde →'}
             </button>`
          : `<div class="mpr-wait">Warte auf Host…</div>`
        }
      </div>
    </div>`;
  ov.classList.add('show');
}

function mpNext() {
  const ov = document.getElementById('mp-result-overlay');
  if (ov) ov.classList.remove('show');
  mpSocket.emit('mp_next', { code: ROOM_CODE });
}

function onMpGameOver(data) {
  const ov = document.getElementById('mp-result-overlay');
  if (ov) ov.classList.remove('show');

  document.getElementById('fin-p').textContent = data.scores[0]?.score.toLocaleString() || '0';
  document.getElementById('fin-a').textContent = '—';

  const t = document.getElementById('fin-title');
  const s = document.getElementById('fin-sub');
  const winner = data.scores[0];
  t.textContent = `🏆 ${winner?.name} gewinnt!`;
  t.className   = 'win';
  s.textContent = `${winner?.score.toLocaleString()} Punkte`;

  // Replace final boxes with full leaderboard
  document.querySelector('.final-boxes').innerHTML = data.scores.map((p, i) =>
    `<div class="fb" style="border-color:${p.color}40">
       <div class="fn" style="color:${p.color}">${i + 1}. ${p.name}</div>
       <div class="fs" style="color:${p.color}">${p.score.toLocaleString()}</div>
     </div>`
  ).join('');

  document.getElementById('final-overlay').classList.add('show');
}

// ── Submit guess (called from game.js) ───────────────────────────────────────
function mpSubmitGuess() {
  if (!pLat || mpGuessed) return;
  mpGuessed = true;
  document.getElementById('submit-btn').disabled = true;
  mpSocket.emit('mp_guess', { code: ROOM_CODE, lat: pLat, lon: pLon });
}

// ── Inject multiplayer styles ─────────────────────────────────────────────────
function injectMpStyles() {
  const style = document.createElement('style');
  style.textContent = `
    /* Lobby overlay */
    #mp-lobby-overlay {
      position:fixed; inset:0; z-index:8000;
      background:rgba(7,9,15,.97); backdrop-filter:blur(12px);
      display:flex; align-items:center; justify-content:center;
    }
    #mp-lobby-box {
      background:var(--s1); border:1px solid var(--bd2);
      border-radius:16px; padding:32px; min-width:340px;
      display:flex; flex-direction:column; gap:18px; text-align:center;
    }
    .mlo-title { font-family:'Syne',sans-serif; font-size:1.1rem; font-weight:800; color:#fff; }
    .mlo-code-wrap { background:var(--s2); border:1px solid var(--bd2); border-radius:10px; padding:16px; }
    .mlo-code-label { font-size:.56rem; letter-spacing:1.5px; color:var(--muted); margin-bottom:6px; }
    .mlo-code { font-size:2.2rem; font-weight:800; letter-spacing:8px; color:#fff; font-family:'Syne',sans-serif; }
    #mlo-players { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; }
    .mlo-player { padding:4px 12px; border-radius:20px; font-size:.68rem; font-weight:600;
                  background:rgba(0,0,0,.3); border:1px solid currentColor; }
    #mlo-status { font-size:.65rem; color:var(--muted); }
    #mlo-start-btn {
      padding:12px; border:none; border-radius:9px; background:var(--green); color:#000;
      font-family:'IBM Plex Mono',monospace; font-size:.8rem; font-weight:700;
      cursor:pointer; transition:all .2s; letter-spacing:.5px;
    }
    #mlo-start-btn:hover { background:#33ffa8; transform:translateY(-1px); }

    /* Guess counter */
    #mp-guess-counter {
      position:absolute; z-index:160; top:14px; left:50%; transform:translateX(-50%);
      background:rgba(7,9,15,.9); border:1px solid var(--bd2);
      border-radius:20px; padding:5px 16px; font-size:.65rem; color:var(--muted);
      backdrop-filter:blur(10px); pointer-events:none;
    }

    /* Round result overlay */
    #mp-result-overlay {
      position:fixed; inset:0; z-index:9000;
      background:rgba(7,9,15,.8); backdrop-filter:blur(8px);
      display:none; align-items:center; justify-content:center;
    }
    #mp-result-overlay.show { display:flex; }
    #mp-result-modal {
      background:var(--s1); border:1px solid var(--bd2); border-radius:16px;
      padding:28px 24px; min-width:320px; max-width:420px; width:90%;
      display:flex; flex-direction:column; gap:14px;
      animation:mprSlideIn .35s cubic-bezier(.34,1.3,.64,1);
    }
    @keyframes mprSlideIn { from { transform:scale(.85); opacity:0; } to { transform:scale(1); opacity:1; } }
    .mpr-title { font-family:'Syne',sans-serif; font-size:1rem; font-weight:800;
                 color:#fff; text-align:center; }
    .mpr-list  { display:flex; flex-direction:column; gap:6px; }
    .mpr-row {
      display:grid; grid-template-columns:20px 18px 1fr auto auto;
      align-items:center; gap:8px; padding:8px 10px;
      border-radius:8px; font-size:.72rem;
      background:rgba(255,255,255,.03);
      border:1px solid color-mix(in srgb, var(--rc) 20%, transparent);
    }
    .mpr-row.mpr-ai { background:rgba(255,61,90,.05); }
    .mpr-rank  { color:var(--muted); font-size:.6rem; text-align:center; }
    .mpr-dot   { font-size:.65rem; text-align:center; }
    .mpr-name  { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mpr-dist  { font-size:.6rem; color:var(--muted); white-space:nowrap; }
    .mpr-score { color:#fff; font-weight:700; white-space:nowrap; }
    .mpr-btns  { margin-top:4px; }
    .mpr-btn {
      width:100%; padding:11px; border:none; border-radius:9px;
      background:var(--acc); color:#fff; font-family:'IBM Plex Mono',monospace;
      font-size:.78rem; font-weight:700; cursor:pointer; letter-spacing:.5px;
      transition:all .15s;
    }
    .mpr-btn:hover { background:#7b9fff; transform:translateY(-1px); }
    .mpr-wait { text-align:center; font-size:.65rem; color:var(--muted); padding:8px; }

    /* Host end-round button inside guess counter */
    .mpc-end-btn {
      margin-left:10px; padding:2px 10px; border:1px solid var(--bd2);
      border-radius:12px; background:rgba(255,255,255,.06); color:var(--muted);
      font-family:'IBM Plex Mono',monospace; font-size:.58rem; cursor:pointer;
      transition:all .15s; pointer-events:all;
    }
    .mpc-end-btn:hover { border-color:var(--red); color:var(--red); }

    /* Round timer */
    #mp-timer-wrap {
      position:absolute; z-index:160; top:14px; right:14px;
      background:rgba(7,9,15,.9); border:1px solid var(--bd2);
      border-radius:20px; padding:5px 14px;
      display:flex; align-items:center; gap:6px;
      backdrop-filter:blur(10px); pointer-events:none;
    }
    #mp-timer {
      font-family:'IBM Plex Mono',monospace; font-size:.75rem; font-weight:700;
      color:var(--muted); min-width:28px; text-align:center;
      transition:color .3s;
    }
    #mp-timer.urgent { color:var(--red); animation:timerPulse .5s ease-in-out infinite alternate; }
    @keyframes timerPulse { from { opacity:1; } to { opacity:.5; } }

    /* Topbar player strip */
    #mp-players-strip {
      display:flex; align-items:center; gap:4px; padding:0 12px;
      border-left:1px solid var(--bd); max-width:400px; overflow:hidden;
    }
    .mp-strip-player {
      display:flex; align-items:center; gap:4px;
      padding:2px 8px; border-radius:12px; font-size:.6rem;
      background:rgba(255,255,255,.03); border:1px solid currentColor;
      white-space:nowrap;
    }
    .msp-dot  { font-size:.5rem; }
    .msp-name { color:#fff; font-size:.6rem; max-width:60px; overflow:hidden; text-overflow:ellipsis; }
    .msp-score{ font-weight:700; font-size:.6rem; margin-left:3px; }
  `;
  document.head.appendChild(style);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
mpInit();
