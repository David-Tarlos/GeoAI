// ══════════════════════════════════════════════════════════════
//  DATASET
// ══════════════════════════════════════════════════════════════
function initDsMap() {
  dsMap = L.map('dataset-map', { center: [20, 0], zoom: 2 });
  L.tileLayer(TILE, TILE_OPT).addTo(dsMap);
  fetchDsPoints();
}

async function fetchDsPoints() {
  const res = await fetch('/api/dataset_points');
  const pts = await res.json();
  pts.forEach(p => {
    const m = L.circleMarker([p.lat, p.lon], {
      radius: 4, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: .7, weight: 1
    }).addTo(dsMap);
    m.on('click',     () => selectDsPoint(p));
    m.on('mouseover', () => m.setStyle({ radius: 7, fillColor: '#5b7fff' }));
    m.on('mouseout',  () => m.setStyle({ radius: 4, fillColor: '#3b82f6' }));
  });
}

function selectDsPoint(p) {
  document.getElementById('ds-lat').textContent = p.lat.toFixed(5) + '°';
  document.getElementById('ds-lon').textContent = p.lon.toFixed(5) + '°';
  document.getElementById('ds-idx').textContent = '#' + p.idx;
  document.getElementById('ds-empty').style.display    = 'none';
  document.getElementById('ds-info').style.display     = 'block';
  document.getElementById('ds-img-wrap').style.display = 'none';
  fetchDsImage(p.idx);
}

async function fetchDsImage(idx) {
  document.getElementById('ds-load-spin').style.display = 'block';
  const res = await fetch(`/api/image_by_idx?idx=${idx}`);
  const d   = await res.json();
  const img = document.getElementById('ds-img');
  img.onload = () => {
    document.getElementById('ds-load-spin').style.display  = 'none';
    document.getElementById('ds-img-wrap').style.display   = 'block';
  };
  img.src = 'data:image/jpeg;base64,' + d.img;
}

// ══════════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════════
function renderStats() {
  const n = history.length;
  document.getElementById('stats-sub').textContent = `${n} Runde${n !== 1 ? 'n' : ''} gespielt`;
  document.getElementById('st-pt').textContent = totalP.toLocaleString();
  document.getElementById('st-at').textContent = totalA.toLocaleString();

  if (!n) {
    document.getElementById('no-data').style.display = 'flex';
    document.getElementById('hist-grid').innerHTML =
      '<div style="color:var(--muted);font-size:.7rem;grid-column:1/-1">Noch keine Runden gespielt</div>';
    return;
  }

  const avgP = Math.round(history.reduce((s, r) => s + r.player_dist, 0) / n);
  const avgA = Math.round(history.reduce((s, r) => s + r.ai_dist,    0) / n);
  document.getElementById('st-pd').textContent = avgP.toLocaleString() + ' km';
  document.getElementById('st-ad').textContent = avgA.toLocaleString() + ' km';
  document.getElementById('no-data').style.display = 'none';

  // ── SVG chart ──
  const wrap = document.getElementById('chart-wrap');
  const W = wrap.offsetWidth || 600, H = 260;
  const PAD = { t: 18, r: 20, b: 38, l: 54 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;
  const MAX_DIST = 12000;
  const acc = km => Math.max(0, (1 - km / MAX_DIST)) * 100;
  const xS  = i  => PAD.l + (n > 1 ? (i / (n - 1)) * cW : cW / 2);
  const yS  = a  => PAD.t + (1 - a / 100) * cH;
  const fm  = "font-family:'IBM Plex Mono',monospace;font-size:10px;fill:#485570";

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">`;

  [0, 25, 50, 75, 100].forEach(pct => {
    const y = yS(pct);
    svg += `<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" stroke="#1e2535" stroke-width="1"/>`;
    svg += `<text x="${PAD.l - 7}" y="${y + 4}" text-anchor="end" style="${fm}">${pct}%</text>`;
  });
  svg += `<text x="12" y="${H / 2}" text-anchor="middle" transform="rotate(-90,12,${H / 2})" style="${fm}">GENAUIGKEIT</text>`;

  history.forEach((_, i) => {
    const x = xS(i);
    svg += `<line x1="${x}" y1="${PAD.t + cH}" x2="${x}" y2="${PAD.t + cH + 4}" stroke="#485570" stroke-width="1"/>`;
    svg += `<text x="${x}" y="${H - 6}" text-anchor="middle" style="${fm}">R${i + 1}</text>`;
  });

  if (n > 1) {
    const pathP = history.map((r, i) => `${i === 0 ? 'M' : 'L'}${xS(i)},${yS(acc(r.player_dist))}`).join(' ');
    const pathA = history.map((r, i) => `${i === 0 ? 'M' : 'L'}${xS(i)},${yS(acc(r.ai_dist))}`).join(' ');
    svg += `<path d="${pathP} L${xS(n-1)},${yS(0)} L${xS(0)},${yS(0)} Z" fill="#00e896" fill-opacity=".06"/>`;
    svg += `<path d="${pathP}" fill="none" stroke="#00e896" stroke-width="2" opacity=".6"/>`;
    svg += `<path d="${pathA} L${xS(n-1)},${yS(0)} L${xS(0)},${yS(0)} Z" fill="#ff3d5a" fill-opacity=".06"/>`;
    svg += `<path d="${pathA}" fill="none" stroke="#ff3d5a" stroke-width="2" opacity=".6"/>`;
  }

  history.forEach((r, i) => {
    const px = xS(i), py = yS(acc(r.player_dist));
    const ax = xS(i), ay = yS(acc(r.ai_dist));
    svg += `<circle cx="${px}" cy="${py}" r="5" fill="#00e896"><title>R${i+1} Du: ${Math.round(acc(r.player_dist))}% (${r.player_dist.toLocaleString()} km)</title></circle>`;
    svg += `<circle cx="${ax}" cy="${ay}" r="5" fill="#ff3d5a"><title>R${i+1} KI: ${Math.round(acc(r.ai_dist))}% (${r.ai_dist.toLocaleString()} km)</title></circle>`;
    if      (r.winner === 'player') svg += `<text x="${px}" y="${py-10}" text-anchor="middle" style="font-size:9px;fill:#00e896">▲</text>`;
    else if (r.winner === 'ai')     svg += `<text x="${ax}" y="${ay-10}" text-anchor="middle" style="font-size:9px;fill:#ff3d5a">▲</text>`;
  });
  svg += `</svg>`;
  wrap.innerHTML = svg;

  // ── History cards ──
  const grid = document.getElementById('hist-grid');
  grid.innerHTML = '';
  history.forEach((h, i) => {
    const isAiWin = h.winner === 'ai';
    const card = document.createElement('div');
    card.className = 'hist-card';
    card.innerHTML = `
      <img src="data:image/jpeg;base64,${h.img}" alt="">
      <div class="hist-card-info">
        <div class="coord">${h.true_lat.toFixed(2)}°, ${h.true_lon.toFixed(2)}°</div>
        <div class="hpts${isAiWin ? ' ai-win' : ''}">${isAiWin ? '🤖 KI' : '🙋 Du'}: ${(isAiWin ? h.ai_score : h.player_score).toLocaleString()} Pts</div>
      </div>`;
    card.onclick = () => {
      switchTab('game');
      clearGameLayers();
      gameMap.setView([h.true_lat, h.true_lon], 5);
      L.marker([h.true_lat, h.true_lon], { icon: mkIcon('#ffcc00', 18) })
        .addTo(gameMap).bindTooltip(`Runde ${i + 1}`, { permanent: true, direction: 'top' });
    };
    grid.appendChild(card);
  });
}

// ══════════════════════════════════════════════════════════════
//  SIMULATION
// ══════════════════════════════════════════════════════════════
function initSimMap() {
  simMap = L.map('sim-map', { center: [20, 0], zoom: 2 });
  L.tileLayer(TILE, TILE_OPT).addTo(simMap);
}

function simLog(msg, pts, cls) {
  const el = document.createElement('div');
  el.className = 'sim-le ' + cls;
  el.innerHTML = `<span>${msg}</span><span>${pts}</span>`;
  const log = document.getElementById('sim-log');
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

async function runSimRound() {
  if (!simRunning) return;
  simIdx++;
  document.getElementById('sim-ptxt').textContent = `Runde ${simIdx} / ${simNTotal}`;
  document.getElementById('sim-ppct').textContent = Math.round(simIdx / simNTotal * 100) + '%';

  const imgData = await fetch('/api/image').then(r => r.json());

  // Show image in game PIP
  const img = document.getElementById('street-image');
  document.getElementById('g-pip-load').style.display = 'none';
  img.style.display = 'block';
  img.src = 'data:image/jpeg;base64,' + imgData.img;

  const d = await fetch('/api/guess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idx: imgData.idx, lat: 0, lon: 0 })
  }).then(r => r.json());

  simDists.push(d.ai_dist);
  simScores.push(d.ai_score);

  simMap.eachLayer(l => { if (l instanceof L.Marker || l instanceof L.Polyline) simMap.removeLayer(l); });
  L.marker([d.true_lat, d.true_lon], { icon: mkIcon('#ffcc00', 16) })
    .addTo(simMap).bindTooltip('Wahrer Ort', { permanent: true, direction: 'top' });
  L.marker([d.ai_lat, d.ai_lon], { icon: mkIcon('#ff3d5a', 12) })
    .addTo(simMap).bindTooltip(`KI · ${d.ai_conf}%`, { permanent: false });
  L.polyline([[d.ai_lat, d.ai_lon], [d.true_lat, d.true_lon]],
    { color: '#ff3d5a', weight: 2, dashArray: '5,4', opacity: .6 }).addTo(simMap);
  simMap.fitBounds(
    L.latLngBounds([[d.true_lat, d.true_lon], [d.ai_lat, d.ai_lon]]),
    { padding: [70, 70] }
  );

  const tot  = simScores.reduce((a, b) => a + b, 0);
  const avgD = Math.round(simDists.reduce((a, b) => a + b, 0) / simDists.length);
  document.getElementById('ss-r').textContent = simIdx;
  document.getElementById('ss-t').textContent = tot.toLocaleString();
  document.getElementById('ss-d').textContent = avgD.toLocaleString() + ' km';
  document.getElementById('ss-b').textContent = Math.max(...simScores).toLocaleString() + ' Pts';
  document.getElementById('ss-w').textContent = Math.min(...simScores).toLocaleString() + ' Pts';

  const cls = d.ai_score > 3000 ? 'good' : d.ai_score > 1000 ? 'info' : 'bad';
  simLog(`R${simIdx}: ${d.ai_dist.toLocaleString()} km`, `${d.ai_score.toLocaleString()} Pts`, cls);

  if (simIdx >= simNTotal || !simRunning) { stopSim(); return; }

  const cd  = parseInt(document.getElementById('sim-cd').value) * 1000;
  const bar = document.getElementById('sim-pbar');
  const t0  = Date.now();
  const tick = setInterval(() => {
    if (!simRunning) { clearInterval(tick); return; }
    bar.style.width = Math.min(100, (Date.now() - t0) / cd * 100) + '%';
  }, 50);
  simTmo = setTimeout(() => { clearInterval(tick); runSimRound(); }, cd);
}

function startSim() {
  if (!simMap) initSimMap();
  simNTotal = parseInt(document.getElementById('sim-nr').value);
  simIdx = 0; simDists = []; simScores = []; simRunning = true;
  document.getElementById('sim-log').innerHTML = '';
  document.getElementById('sim-start').style.display = 'none';
  document.getElementById('sim-stop').style.display  = '';
  document.getElementById('pip-mode-badge').style.display = 'block';
  ['ss-r', 'ss-t', 'ss-d', 'ss-b', 'ss-w'].forEach(id =>
    document.getElementById(id).textContent = '—'
  );
  document.getElementById('ss-r').textContent = '0';
  document.getElementById('ss-t').textContent = '0';
  simLog('Simulation gestartet', `${simNTotal} Runden`, 'info');
  runSimRound();
}

function stopSim() {
  simRunning = false;
  if (simTmo) clearTimeout(simTmo);
  document.getElementById('sim-start').style.display = '';
  document.getElementById('sim-stop').style.display  = 'none';
  document.getElementById('sim-pbar').style.width    = '0%';
  document.getElementById('pip-mode-badge').style.display = 'none';
  if (simIdx > 0) simLog('— Beendet —', '', 'info');
}

// ══════════════════════════════════════════════════════════════
//  UPLOAD
// ══════════════════════════════════════════════════════════════
function initUpMap() {
  upMap = L.map('upload-map', { center: [20, 0], zoom: 2 });
  L.tileLayer(TILE, TILE_OPT).addTo(upMap);
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('up-drop').classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) setUpFile(f);
}

function handleFileSelect(e) {
  const f = e.target.files[0];
  if (f) setUpFile(f);
}

function setUpFile(f) {
  uploadFile = f;
  const r = new FileReader();
  r.onload = ev => {
    document.getElementById('up-img').src = ev.target.result;
    document.getElementById('up-drop').style.display         = 'none';
    document.getElementById('up-preview-wrap').style.display = 'flex';
    document.getElementById('up-result-bar').style.display   = 'none';
    document.getElementById('up-loading').style.display      = 'none';
    document.getElementById('up-run-btn').disabled = false;
  };
  r.readAsDataURL(f);
}

function resetUpload() {
  uploadFile = null;
  document.getElementById('up-drop').style.display         = '';
  document.getElementById('up-preview-wrap').style.display = 'none';
  document.getElementById('up-file-inp').value             = '';
  document.getElementById('up-result-bar').style.display   = 'none';
  if (upResultMarker && upMap) { upMap.removeLayer(upResultMarker); upResultMarker = null; }
}

async function runUpload() {
  const btn = document.getElementById('up-run-btn');
  btn.disabled = true;
  document.getElementById('up-loading').style.display = 'flex';

  const r = new FileReader();
  r.onload = async ev => {
    const b64 = ev.target.result.split(',')[1];
    try {
      const d = await fetch('/api/guess_image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ img: b64 })
      }).then(r => r.json());

      document.getElementById('ur-lat').textContent  = d.lat.toFixed(4) + '°';
      document.getElementById('ur-lon').textContent  = d.lon.toFixed(4) + '°';
      document.getElementById('ur-conf').textContent = d.conf + '%';
      document.getElementById('ur-reg').textContent  = d.location || '—';
      document.getElementById('up-result-bar').style.display = 'block';
      document.getElementById('up-loading').style.display    = 'none';

      if (!upMap) initUpMap();
      if (upResultMarker) upMap.removeLayer(upResultMarker);
      upResultMarker = L.marker([d.lat, d.lon], { icon: mkIcon('#ff3d5a', 18) })
        .addTo(upMap)
        .bindTooltip(`KI-Schätzung · ${d.conf}% Konfidenz`, { permanent: true, direction: 'top' });
      upMap.setView([d.lat, d.lon], 5);
    } catch (err) {
      document.getElementById('up-loading').style.display = 'none';
      alert('Fehler: ' + err.message);
    }
    btn.disabled = false;
  };
  r.readAsDataURL(uploadFile);
}
