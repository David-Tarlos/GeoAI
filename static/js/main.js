// ── SHARED STATE ─────────────────────────────────────────────────────────────
let gameMap = null, dsMap = null, simMap = null, upMap = null;
let round = 1, totalP = 0, totalA = 0;
let playerMarker = null, pLat = null, pLon = null, currentData = null;
let history = [];
let pipExpanded = false;
let globeObj = null, globeMode = false;
let upResultMarker = null, uploadFile = null;
let simRunning = false, simTmo = null, simIdx = 0, simNTotal = 0;
let simDists = [], simScores = [];

const TILE = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_OPT = { attribution: '© OpenStreetMap, © CARTO', maxZoom: 18 };

function mkIcon(col, sz = 14) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${sz}px;height:${sz}px;background:${col};border:2px solid rgba(255,255,255,.75);border-radius:50%;box-shadow:0 0 8px ${col}99"></div>`,
    iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2]
  });
}

// ── TAB SWITCHING ─────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'dataset' && !dsMap)  initDsMap();
  if (name === 'sim'     && !simMap) initSimMap();
  if (name === 'upload'  && !upMap)  initUpMap();
  if (name === 'stats')              renderStats();
  setTimeout(() => {
    if (name === 'dataset' && dsMap)  dsMap.invalidateSize();
    if (name === 'sim'     && simMap) simMap.invalidateSize();
    if (name === 'upload'  && upMap)  upMap.invalidateSize();
    if (name === 'game'    && gameMap && !globeMode) gameMap.invalidateSize();
  }, 50);
}
