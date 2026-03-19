// multiplayer.js — loaded only when ROOM_CODE is set
// Connects to the server socket and manages the multiplayer game flow.

let mpSocket    = null;
let mpIsHost    = false;
let mpName      = PLAYER_NAME || sessionStorage.getItem('geoai_name') || 'Spieler';
let mpHostToken = sessionStorage.getItem('geoai_host_token') || '';
let mpGuessed   = false;
let mpTimerInt  = null;
let mpRoomCode  = ROOM_CODE;

// ── Init ──────────────────────────────────────────────────────────────────────
function mpInit() {
  document.getElementById('mp-players-strip').style.display = 'flex';

  mpSocket = io();

  mpSocket.on('connect', () => {
    mpSocket.emit('join_room_code', {
      code: mpRoomCode,
      name: mpName,
      host_token: mpHostToken,
    });
  });

  mpSocket.on('join_ok',         onMpJoinOk);
  mpSocket.on('join_error',      d => { alert('Fehler: ' + d.msg); window.location.href = '/'; });
  mpSocket.on('lobby_update',    d => renderMpPlayers(d.players));
  mpSocket.on('round_start',     onMpRoundStart);
  mpSocket.on('guess_count',     onMpGuessCount);
  mpSocket.on('my_guess_result', onMpMyResult);
  mpSocket.on('round_results',   onMpRoundResults);
  mpSocket.on('game_over',       onMpGameOver);
  mpSocket.on('player_left',     d => renderMpPlayers(d.players));
  mpSocket.on('mp_restarted',    onMpRestarted);

  injectMpStyles();
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
          <div class="mlo-code" id="mlo-code-text">${mpRoomCode}</div>
          <button class="mlo-copy-btn" onclick="mpCopyCode()">Code kopieren</button>
        </div>
        <div class="mlo-section-label">SPIELER</div>
        <div id="mlo-players"></div>
        <div id="mlo-status">Warte auf weitere Spieler…</div>
        <button id="mlo-start-btn" onclick="mpStartGame()" style="display:none">Spiel starten</button>
      </div>`;
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  // Re-render players into the newly created element
  const strip = document.getElementById('mp-players-strip');
  if (strip && strip.dataset.lastPlayers) {
    try {
      renderMpPlayers(JSON.parse(strip.dataset.lastPlayers));
    } catch(e) {}
  }
}

function hideMpLobbyOverlay() {
  const ov = document.getElementById('mp-lobby-overlay');
  if (ov) ov.style.display = 'none';
}

function mpCopyCode() {
  navigator.clipboard.writeText(mpRoomCode).then(() => {
    const btn = document.querySelector('.mlo-copy-btn');
    if (btn) { btn.textContent = 'Kopiert!'; setTimeout(() => btn.textContent = 'Code kopieren', 1500); }
  });
}

function onMpJoinOk(data) {
  mpIsHost = !!data.is_host;
  renderMpPlayers(data.players);

  // Keep host_token for potential reconnects — only clear after game ends
  if (!mpIsHost) {
    sessionStorage.removeItem('geoai_host');
    sessionStorage.removeItem('geoai_host_token');
  }

  const state = data.game_state || 'lobby';
  if (state === 'lobby') {
    showMpLobbyOverlay();
    if (mpIsHost) {
      const btn = document.getElementById('mlo-start-btn');
      const st  = document.getElementById('mlo-status');
      if (btn) btn.style.display = 'block';
      if (st)  st.textContent    = 'Alle bereit? Starte das Spiel!';
    }
  }
}

function renderMpPlayers(players) {
  // Store for potential re-render
  const strip = document.getElementById('mp-players-strip');
  if (strip) {
    strip.dataset.lastPlayers = JSON.stringify(players);
    strip.innerHTML = players.map(p =>
      `<div class="mp-strip-player" style="--pc:${p.color}">
         <span class="msp-dot" style="color:${p.color}">●</span>
         <span class="msp-name">${p.name}</span>
         <span class="msp-score" id="msp-${p.name.replace(/\s/g,'')}">${(p.score || 0).toLocaleString()}</span>
       </div>`
    ).join('');
  }

  // Lobby player list
  const el = document.getElementById('mlo-players');
  if (el) {
    el.innerHTML = players.map(p =>
      `<div class="mlo-player" style="--pc:${p.color}; color:${p.color}">
        <span class="mlo-player-dot">●</span> ${p.name}
      </div>`
    ).join('');
  }
}

function mpStartGame() {
  if (!mpIsHost) return;
  const btn = document.getElementById('mlo-start-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Starte…'; }
  mpSocket.emit('start_game', { code: mpRoomCode });
}

// ── Round flow ────────────────────────────────────────────────────────────────
function onMpRoundStart(data) {
  hideMpLobbyOverlay();
  mpGuessed = false;

  // Update round header
  document.getElementById('hdr-r').textContent = data.round;
  document.getElementById('hdr-t').textContent = data.rounds;

  // Update player strip scores
  if (data.players) renderMpPlayers(data.players);

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
  document.getElementById('final-overlay').classList.remove('show');

  // Hide any result overlay from previous round
  const ov = document.getElementById('mp-result-overlay');
  if (ov) ov.classList.remove('show');

  // Show guess counter
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
  const hostBtn = mpIsHost
    ? `<button class="mpc-end-btn" onclick="mpForceEnd()">Runde beenden</button>`
    : '';
  el.innerHTML = `<span class="mpc-text">${count} / ${total} geraten</span>${hostBtn}`;
  el.style.display = 'flex';
}

function mpForceEnd() {
  mpSocket.emit('mp_timeout', { code: mpRoomCode });
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
  document.getElementById('guess-info').textContent =
    `Gesendet · ${data.dist.toLocaleString()} km · ${data.score.toLocaleString()} Pts`;
  document.getElementById('guess-info').classList.add('on');
}

function onMpRoundResults(data) {
  stopMpTimer();
  hideMpGuessCounter();

  const { true_lat, true_lon, ai_lat, ai_lon, ai_conf,
          ai_dist, ai_score, guesses, scores, is_last } = data;

  // Draw all player guesses on map
  guesses.forEach(g => {
    if (g.lat === 0 && g.lon === 0) return;
    L.marker([g.lat, g.lon], { icon: mkIcon(g.color, 14) })
      .addTo(gameMap)
      .bindTooltip(`${g.name}: ${g.dist.toLocaleString()} km · ${g.score.toLocaleString()} Pts`, { permanent: false });
    L.polyline([[g.lat, g.lon], [true_lat, true_lon]],
      { color: g.color, weight: 2, dashArray: '5,4', opacity: .7 }).addTo(gameMap);
  });

  // True location + AI guess
  L.marker([true_lat, true_lon], { icon: mkIcon('#ffcc00', 18) })
    .addTo(gameMap).bindTooltip('Wahrer Ort', { permanent: true, direction: 'top' });
  L.marker([ai_lat, ai_lon], { icon: mkIcon('#ff3d5a', 12) })
    .addTo(gameMap).bindTooltip(`KI · ${ai_conf}%`, { permanent: false });
  L.polyline([[ai_lat, ai_lon], [true_lat, true_lon]],
    { color: '#ff3d5a', weight: 2, dashArray: '5,4', opacity: .5 }).addTo(gameMap);

  // Fit map to all points
  const allPts = [[true_lat, true_lon], [ai_lat, ai_lon],
    ...guesses.filter(g => g.lat !== 0).map(g => [g.lat, g.lon])];
  gameMap.fitBounds(L.latLngBounds(allPts), { padding: [60, 60] });

  // Update topbar scores
  scores.forEach(s => {
    const el = document.getElementById('msp-' + s.name.replace(/\s/g, ''));
    if (el) el.textContent = s.score.toLocaleString();
  });

  // Show MP result panel (leaderboard)
  showMpResultPanel(scores, ai_score, ai_dist, ai_conf, is_last);
}

function showMpResultPanel(scores, ai_score, ai_dist, ai_conf, is_last) {
  // Merge AI into ranking for this round
  const allEntries = [
    ...scores.map(s => ({ ...s, isAI: false })),
    { name: 'KI', score: ai_score, round_score: ai_score, dist: ai_dist, color: '#ff3d5a', isAI: true },
  ].sort((a, b) => (b.round_score || 0) - (a.round_score || 0));

  const rows = allEntries.map((s, i) => {
    const badge  = s.isAI ? '🤖' : '●';
    const distTxt  = s.dist != null ? `<span class="mpr-dist">${s.dist.toLocaleString()} km</span>` : '';
    const rdScore  = s.round_score != null ? `+${s.round_score.toLocaleString()}` : '';
    const totalTxt = !s.isAI ? `<span class="mpr-total">${s.score.toLocaleString()}</span>` : '';
    return `<div class="mpr-row ${s.isAI ? 'mpr-ai' : ''}" style="--rc:${s.color}">
      <span class="mpr-rank">${i + 1}.</span>
      <span class="mpr-dot" style="color:${s.color}">${badge}</span>
      <span class="mpr-name" style="color:${s.color}">${s.name}</span>
      ${distTxt}
      <span class="mpr-round-score">${rdScore}</span>
      ${totalTxt}
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
      <div class="mpr-title">${is_last ? 'Endstand' : 'Runden-Ergebnis'}</div>
      <div class="mpr-list">${rows}</div>
      <div class="mpr-btns">
        ${mpIsHost
          ? `<button class="mpr-btn" onclick="mpNext()">
               ${is_last ? 'Endstand anzeigen' : 'Nächste Runde'}
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
  mpSocket.emit('mp_next', { code: mpRoomCode });
}

function onMpGameOver(data) {
  const ov = document.getElementById('mp-result-overlay');
  if (ov) ov.classList.remove('show');

  // Clean up host token
  sessionStorage.removeItem('geoai_host');
  sessionStorage.removeItem('geoai_host_token');

  const winner = data.scores[0];
  const t = document.getElementById('fin-title');
  const s = document.getElementById('fin-sub');
  t.textContent = `${winner?.name} gewinnt!`;
  t.className   = 'win';
  s.textContent = `${winner?.score.toLocaleString()} Punkte`;

  // Replace final boxes with full leaderboard
  document.querySelector('.final-boxes').innerHTML = data.scores.map((p, i) =>
    `<div class="fb" style="border-color:${p.color}40">
       <div class="fn" style="color:${p.color}">${i + 1}. ${p.name}</div>
       <div class="fs" style="color:${p.color}">${p.score.toLocaleString()}</div>
     </div>`
  ).join('');

  // Change restart button for multiplayer
  const againBtn = document.getElementById('btn-again');
  if (mpIsHost) {
    againBtn.textContent = 'Nochmal spielen';
    againBtn.onclick = () => mpRestartGame();
  } else {
    againBtn.textContent = 'Zurück zur Startseite';
    againBtn.onclick = () => { window.location.href = '/'; };
  }

  document.getElementById('final-overlay').classList.add('show');
}

function onMpRestarted(data) {
  document.getElementById('final-overlay').classList.remove('show');
  const ov = document.getElementById('mp-result-overlay');
  if (ov) ov.classList.remove('show');
  renderMpPlayers(data.players);
}

// ── Restart (host only) ───────────────────────────────────────────────────────
function mpRestartGame() {
  if (mpIsHost && mpSocket) {
    mpSocket.emit('mp_restart', { code: mpRoomCode });
  } else {
    window.location.href = '/';
  }
}

// ── Submit guess (called from game.js) ───────────────────────────────────────
function mpSubmitGuess() {
  if (!pLat || mpGuessed) return;
  mpGuessed = true;
  document.getElementById('submit-btn').disabled = true;
  mpSocket.emit('mp_guess', { code: mpRoomCode, lat: pLat, lon: pLon });
}

// ── Inject multiplayer styles ─────────────────────────────────────────────────
function injectMpStyles() {
  if (document.getElementById('mp-injected-styles')) return;
  const style = document.createElement('style');
  style.id = 'mp-injected-styles';
  style.textContent = `
    /* ── Lobby overlay ── */
    #mp-lobby-overlay {
      position:fixed; inset:0; z-index:8000;
      background:rgba(7,9,15,.97); backdrop-filter:blur(16px);
      display:flex; align-items:center; justify-content:center;
    }
    #mp-lobby-box {
      background:var(--s1); border:1px solid var(--bd2);
      border-radius:18px; padding:36px 32px; min-width:360px; max-width:440px;
      display:flex; flex-direction:column; gap:20px; text-align:center;
      box-shadow:0 20px 60px rgba(0,0,0,.5);
    }
    .mlo-title {
      font-family:var(--head); font-size:1.2rem; font-weight:800;
      color:#fff; letter-spacing:.5px;
    }
    .mlo-code-wrap {
      background:var(--s2); border:1px solid var(--bd2);
      border-radius:12px; padding:20px;
    }
    .mlo-code-label {
      font-size:.55rem; letter-spacing:2px; color:var(--muted); margin-bottom:8px;
    }
    .mlo-code {
      font-size:2.4rem; font-weight:800; letter-spacing:10px; color:#fff;
      font-family:var(--head);
    }
    .mlo-copy-btn {
      margin-top:12px; padding:6px 16px; border:1px solid var(--bd2);
      border-radius:6px; background:var(--s3); color:var(--muted);
      font-family:var(--mono); font-size:.6rem; cursor:pointer;
      transition:all .15s;
    }
    .mlo-copy-btn:hover { border-color:var(--acc); color:#fff; }
    .mlo-section-label {
      font-size:.55rem; letter-spacing:2px; color:var(--muted); text-align:left;
    }
    #mlo-players {
      display:flex; flex-wrap:wrap; gap:8px; justify-content:center;
    }
    .mlo-player {
      padding:6px 14px; border-radius:20px; font-size:.7rem; font-weight:600;
      background:rgba(0,0,0,.3); border:1px solid currentColor;
      display:flex; align-items:center; gap:6px;
    }
    .mlo-player-dot { font-size:.6rem; }
    #mlo-status { font-size:.65rem; color:var(--muted); }
    #mlo-start-btn {
      padding:13px; border:none; border-radius:10px;
      background:var(--green); color:#000;
      font-family:var(--mono); font-size:.82rem; font-weight:700;
      cursor:pointer; transition:all .2s; letter-spacing:.5px;
    }
    #mlo-start-btn:hover { background:#33ffa8; transform:translateY(-1px); }
    #mlo-start-btn:disabled { opacity:.4; cursor:not-allowed; transform:none; }

    /* ── Guess counter ── */
    #mp-guess-counter {
      position:absolute; z-index:160; top:14px; left:50%; transform:translateX(-50%);
      background:rgba(7,9,15,.92); border:1px solid var(--bd2);
      border-radius:20px; padding:6px 16px; font-size:.65rem; color:var(--muted);
      backdrop-filter:blur(10px);
      display:flex; align-items:center; gap:8px;
    }
    .mpc-text { pointer-events:none; }
    .mpc-end-btn {
      padding:3px 12px; border:1px solid var(--bd2);
      border-radius:12px; background:rgba(255,255,255,.06); color:var(--muted);
      font-family:var(--mono); font-size:.58rem; cursor:pointer;
      transition:all .15s;
    }
    .mpc-end-btn:hover { border-color:var(--red); color:var(--red); background:rgba(255,61,90,.08); }

    /* ── Round result overlay ── */
    #mp-result-overlay {
      position:fixed; inset:0; z-index:9000;
      background:rgba(7,9,15,.85); backdrop-filter:blur(10px);
      display:none; align-items:center; justify-content:center;
    }
    #mp-result-overlay.show { display:flex; }
    #mp-result-modal {
      background:var(--s1); border:1px solid var(--bd2); border-radius:18px;
      padding:28px 24px; min-width:340px; max-width:440px; width:90%;
      display:flex; flex-direction:column; gap:16px;
      animation:mprSlideIn .35s cubic-bezier(.34,1.3,.64,1);
      box-shadow:0 20px 60px rgba(0,0,0,.5);
    }
    @keyframes mprSlideIn {
      from { transform:scale(.88) translateY(20px); opacity:0; }
      to   { transform:scale(1) translateY(0); opacity:1; }
    }
    .mpr-title {
      font-family:var(--head); font-size:1.05rem; font-weight:800;
      color:#fff; text-align:center; letter-spacing:.5px;
    }
    .mpr-list { display:flex; flex-direction:column; gap:6px; }
    .mpr-row {
      display:grid; grid-template-columns:24px 20px 1fr auto auto auto;
      align-items:center; gap:6px; padding:9px 12px;
      border-radius:9px; font-size:.72rem;
      background:rgba(255,255,255,.03);
      border:1px solid color-mix(in srgb, var(--rc) 20%, transparent);
      transition:background .15s;
    }
    .mpr-row:first-child { background:rgba(255,255,255,.06); }
    .mpr-row.mpr-ai { background:rgba(255,61,90,.05); border-style:dashed; }
    .mpr-rank  { color:var(--muted); font-size:.62rem; text-align:center; font-weight:700; }
    .mpr-dot   { font-size:.65rem; text-align:center; }
    .mpr-name  { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mpr-dist  { font-size:.58rem; color:var(--muted); white-space:nowrap; }
    .mpr-round-score { font-size:.62rem; color:var(--green); white-space:nowrap; font-weight:600; }
    .mpr-total { color:#fff; font-weight:700; white-space:nowrap; font-size:.72rem; }
    .mpr-btns  { margin-top:4px; }
    .mpr-btn {
      width:100%; padding:12px; border:none; border-radius:10px;
      background:var(--acc); color:#fff; font-family:var(--mono);
      font-size:.78rem; font-weight:700; cursor:pointer; letter-spacing:.5px;
      transition:all .15s;
    }
    .mpr-btn:hover { background:#7b9fff; transform:translateY(-1px); }
    .mpr-wait {
      text-align:center; font-size:.65rem; color:var(--muted); padding:10px;
    }

    /* ── Round timer ── */
    #mp-timer-wrap {
      position:absolute; z-index:160; top:14px; right:14px;
      background:rgba(7,9,15,.92); border:1px solid var(--bd2);
      border-radius:20px; padding:6px 16px;
      display:flex; align-items:center; gap:6px;
      backdrop-filter:blur(10px); pointer-events:none;
    }
    #mp-timer {
      font-family:var(--mono); font-size:.78rem; font-weight:700;
      color:var(--muted); min-width:28px; text-align:center;
      transition:color .3s;
    }
    #mp-timer.urgent { color:var(--red); animation:timerPulse .5s ease-in-out infinite alternate; }
    @keyframes timerPulse { from { opacity:1; } to { opacity:.5; } }

    /* ── Topbar player strip ── */
    #mp-players-strip {
      display:flex; align-items:center; gap:6px; padding:0 14px;
      border-left:1px solid var(--bd); max-width:500px; overflow-x:auto;
      margin-left:auto;
    }
    .mp-strip-player {
      display:flex; align-items:center; gap:5px;
      padding:3px 10px; border-radius:14px; font-size:.62rem;
      background:rgba(255,255,255,.04); border:1px solid color-mix(in srgb, var(--pc) 30%, transparent);
      white-space:nowrap; flex-shrink:0;
    }
    .msp-dot  { font-size:.55rem; }
    .msp-name { color:#fff; font-size:.62rem; max-width:70px; overflow:hidden; text-overflow:ellipsis; }
    .msp-score{ font-weight:700; font-size:.62rem; margin-left:2px; color:var(--pc); }
  `;
  document.head.appendChild(style);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
mpInit();
