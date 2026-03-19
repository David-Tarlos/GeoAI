// ── GAME MAP INIT ─────────────────────────────────────────────────────────────
gameMap = L.map('game-map', { center: [20, 0], zoom: 2, zoomControl: true });
L.tileLayer(TILE, TILE_OPT).addTo(gameMap);
// Force Leaflet to recalculate container size after render
setTimeout(() => gameMap.invalidateSize(), 100);

gameMap.on('click', e => {
  if (document.getElementById('result-panel').classList.contains('show')) return;
  if (simRunning) return;
  pLat = e.latlng.lat;
  pLon = e.latlng.lng;
  if (playerMarker) gameMap.removeLayer(playerMarker);
  playerMarker = L.marker([pLat, pLon], { icon: mkIcon('#00e896', 14) })
    .addTo(gameMap).bindTooltip('Deine Schätzung', { permanent: false });
  document.getElementById('guess-info').textContent = `${pLat.toFixed(3)}° N   ${pLon.toFixed(3)}° E`;
  document.getElementById('guess-info').classList.add('on');
  document.getElementById('submit-btn').disabled = false;
});

// ── GLOBE ─────────────────────────────────────────────────────────────────────
function initGlobe() {
  const container = document.getElementById('globe-container');
  globeObj = Globe()
    .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
    .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
    .pointsData([])
    .pointColor(d => d.color)
    .pointRadius(d => d.size || 0.4)
    .pointAltitude(0.01)
    .arcsData([])
    .arcColor(d => d.color)
    .arcDashLength(0.5)
    .arcDashGap(0.2)
    .arcDashAnimateTime(1500)
    .arcStroke(1.5)
    (container);

  globeObj.controls().autoRotate = false;
  globeObj.controls().enableZoom = true;

  globeObj.onGlobeClick(({ lat, lng }) => {
    if (document.getElementById('result-panel').classList.contains('show')) return;
    if (simRunning) return;
    pLat = lat;
    pLon = lng;
    globeObj.pointsData([{ lat, lng, color: '#00e896', size: 0.4 }]);
    document.getElementById('guess-info').textContent = `${lat.toFixed(3)}° N   ${lng.toFixed(3)}° E`;
    document.getElementById('guess-info').classList.add('on');
    document.getElementById('submit-btn').disabled = false;
  });
}

function toggleView() {
  globeMode = !globeMode;
  const mapEl    = document.getElementById('game-map');
  const globeEl  = document.getElementById('globe-container');
  const btn      = document.getElementById('view-toggle-btn');

  if (globeMode) {
    mapEl.style.display   = 'none';
    globeEl.style.display = 'block';
    btn.textContent = '🗺 Karte';
    if (!globeObj) {
      initGlobe();
    } else {
      setTimeout(() => globeObj.width(globeEl.offsetWidth).height(globeEl.offsetHeight), 50);
    }
    // Transfer existing guess to globe
    if (pLat !== null) {
      globeObj.pointsData([{ lat: pLat, lng: pLon, color: '#00e896', size: 0.4 }]);
    }
  } else {
    mapEl.style.display   = 'block';
    globeEl.style.display = 'none';
    btn.textContent = '🌐 Globus';
    gameMap.invalidateSize();
    // Restore guess marker on map
    if (pLat !== null && !playerMarker) {
      playerMarker = L.marker([pLat, pLon], { icon: mkIcon('#00e896', 14) })
        .addTo(gameMap).bindTooltip('Deine Schätzung', { permanent: false });
    }
  }
}

// ── PIP ───────────────────────────────────────────────────────────────────────
function togglePip() {
  pipExpanded = !pipExpanded;
  document.getElementById('g-pip').classList.toggle('expanded', pipExpanded);
  setTimeout(() => { if (!globeMode) gameMap.invalidateSize(); }, 350);
}

// ── GAME LOGIC ────────────────────────────────────────────────────────────────
async function loadGameImage() {
  pLat = null;
  pLon = null;
  document.getElementById('submit-btn').disabled = true;
  document.getElementById('guess-info').textContent = 'Klicke auf die Karte um zu raten';
  document.getElementById('guess-info').classList.remove('on');
  document.getElementById('g-pip-load').style.display = 'flex';
  document.getElementById('street-image').style.display = 'none';
  if (playerMarker) { gameMap.removeLayer(playerMarker); playerMarker = null; }
  if (globeObj) { globeObj.pointsData([]); globeObj.arcsData([]); }

  const res = await fetch('/api/image');
  currentData = await res.json();
  const img = document.getElementById('street-image');
  img.onload = () => {
    document.getElementById('g-pip-load').style.display = 'none';
    img.style.display = 'block';
  };
  img.src = 'data:image/jpeg;base64,' + currentData.img;
}

document.getElementById('submit-btn').addEventListener('click', async () => {
  if (!pLat) return;
  // Multiplayer: delegate to multiplayer.js
  if (IS_MULTIPLAYER) { mpSubmitGuess(); return; }
  document.getElementById('submit-btn').disabled = true;
  const res = await fetch('/api/guess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idx: currentData.idx, lat: pLat, lon: pLon, difficulty: DIFFICULTY })
  });
  showResult(await res.json());
});

function showResult(d) {
  const { true_lat, true_lon, ai_lat, ai_lon, ai_conf,
          player_score, ai_score, player_dist, ai_dist, winner } = d;

  // ── Leaflet markers + lines ──
  L.marker([true_lat, true_lon], { icon: mkIcon('#ffcc00', 18) })
    .addTo(gameMap).bindTooltip('Wahrer Ort', { permanent: true, direction: 'top' });
  L.marker([ai_lat, ai_lon], { icon: mkIcon('#ff3d5a', 14) })
    .addTo(gameMap).bindTooltip(`KI · ${ai_conf}%`, { permanent: false });
  if (pLat) L.polyline([[pLat, pLon], [true_lat, true_lon]],
    { color: '#00e896', weight: 2, dashArray: '5,4', opacity: .7 }).addTo(gameMap);
  L.polyline([[ai_lat, ai_lon], [true_lat, true_lon]],
    { color: '#ff3d5a', weight: 2, dashArray: '5,4', opacity: .7 }).addTo(gameMap);

  const pts = [[true_lat, true_lon], [ai_lat, ai_lon]];
  if (pLat) pts.push([pLat, pLon]);
  gameMap.fitBounds(L.latLngBounds(pts), { padding: [60, 60] });

  // ── Globe markers + arcs ──
  if (globeObj) {
    const gPts = [
      { lat: true_lat, lng: true_lon, color: '#ffcc00', size: 0.6 },
      { lat: ai_lat,   lng: ai_lon,   color: '#ff3d5a', size: 0.4 },
    ];
    if (pLat) gPts.push({ lat: pLat, lng: pLon, color: '#00e896', size: 0.4 });
    globeObj.pointsData(gPts);

    const arcs = [{ startLat: ai_lat, startLng: ai_lon, endLat: true_lat, endLng: true_lon, color: '#ff3d5a' }];
    if (pLat) arcs.push({ startLat: pLat, startLng: pLon, endLat: true_lat, endLng: true_lon, color: '#00e896' });
    globeObj.arcsData(arcs);
    globeObj.pointOfView({ lat: true_lat, lng: true_lon, altitude: 2.5 }, 1200);
  }

  // ── Scores ──
  totalP += player_score;
  totalA += ai_score;
  document.getElementById('hdr-p').textContent = totalP.toLocaleString();
  document.getElementById('hdr-a').textContent = totalA.toLocaleString();

  history.push({
    img: currentData.img, true_lat, true_lon, ai_lat, ai_lon, ai_conf,
    player_score, ai_score, player_dist, ai_dist, winner, round
  });

  // ── Result panel ──
  const t = document.getElementById('rp-title');
  if      (winner === 'player') { t.textContent = '🎉 Du gewinnst!';   t.className = 'rp-title win'; }
  else if (winner === 'ai')     { t.textContent = '🤖 KI gewinnt!';    t.className = 'rp-title lose'; }
  else                          { t.textContent = '🤝 Unentschieden!'; t.className = 'rp-title tie'; }

  document.getElementById('rp-pd').textContent = player_dist.toLocaleString() + ' km';
  document.getElementById('rp-ps').textContent = player_score.toLocaleString() + ' Pts';
  document.getElementById('rp-ad').textContent = ai_dist.toLocaleString() + ' km';
  document.getElementById('rp-as').textContent = ai_score.toLocaleString() + ' Pts';

  const btn = document.getElementById('btn-next');
  btn.textContent = round >= TOTAL_ROUNDS ? 'Ergebnis →' : 'Weiter →';
  btn.onclick     = round >= TOTAL_ROUNDS ? showFinal    : nextRound;
  document.getElementById('result-panel').classList.add('show');
}

function clearGameLayers() {
  gameMap.eachLayer(l => {
    if (l instanceof L.Marker || l instanceof L.Polyline) gameMap.removeLayer(l);
  });
  playerMarker = null;
}

function nextRound() {
  round++;
  document.getElementById('hdr-r').textContent = round;
  document.getElementById('result-panel').classList.remove('show');
  clearGameLayers();
  gameMap.setView([20, 0], 2);
  loadGameImage();
}

function showFinal() {
  document.getElementById('result-panel').classList.remove('show');
  document.getElementById('fin-p').textContent = totalP.toLocaleString();
  document.getElementById('fin-a').textContent = totalA.toLocaleString();
  const t = document.getElementById('fin-title');
  const s = document.getElementById('fin-sub');
  if      (totalP > totalA) { t.textContent = '🏆 Du hast gewonnen!'; t.className = 'win';  s.textContent = `+${(totalP - totalA).toLocaleString()} Pts Vorsprung`; }
  else if (totalA > totalP) { t.textContent = '🤖 KI gewinnt!';       t.className = 'lose'; s.textContent = `KI war ${(totalA - totalP).toLocaleString()} Pts besser`; }
  else                      { t.textContent = '🤝 Unentschieden!';    t.className = 'tie';  s.textContent = 'Gleichstand nach allen Runden'; }
  document.getElementById('final-overlay').classList.add('show');
}

function restartGame() {
  if (IS_MULTIPLAYER) {
    // In multiplayer, host triggers server restart; non-host goes back to home
    if (typeof mpRestartGame === 'function') {
      mpRestartGame();
    } else {
      window.location.href = '/';
    }
    return;
  }
  round = 1; totalP = 0; totalA = 0; history = [];
  document.getElementById('hdr-p').textContent = '0';
  document.getElementById('hdr-a').textContent = '0';
  document.getElementById('hdr-r').textContent = '1';
  document.getElementById('result-panel').classList.remove('show');
  document.getElementById('final-overlay').classList.remove('show');
  clearGameLayers();
  gameMap.setView([20, 0], 2);
  if (typeof stopSim === 'function') stopSim();
  loadGameImage();
}

// ── INIT ─────────────────────────────────────────────────────────────────────
document.getElementById('hdr-t').textContent = TOTAL_ROUNDS;
if (IS_MULTIPLAYER) {
  // Hide singleplayer score strip — multiplayer uses the player strip
  document.querySelector('.score-strip').style.display = 'none';
} else {
  loadGameImage();
}
