import io, json, math, base64, random, string, secrets, threading
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image
from flask import Flask, jsonify, render_template, request, redirect, has_request_context

import torch
import torch.nn as nn
import timm
from torchvision import transforms
import kagglehub

from flask_socketio import SocketIO, join_room, leave_room, emit

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins='*')

def _emit(event, data, to=None):
    """Use request-context emit() when available, else socketio.emit() for threads."""
    if has_request_context():
        emit(event, data, to=to)
    else:
        socketio.emit(event, data, to=to)

# ── Config ────────────────────────────────────────────────────────────────────
CHECKPOINT_DIR = Path('checkpoints')
BEST_MODEL     = CHECKPOINT_DIR / 'best_model.pth'
CELL_MAPPING   = CHECKPOINT_DIR / 'cell_mapping.json'
DEVICE         = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
DATASET_SAMPLE = 2000

# ── Cell mapping ──────────────────────────────────────────────────────────────
with open(CELL_MAPPING) as f:
    mapping = json.load(f)
idx_to_cell = {int(k): v for k, v in mapping['idx_to_cell'].items()}
STEP = mapping['step']

def cell_center(cell_id):
    lat_bin, lon_bin = map(float, cell_id.split('_'))
    return lat_bin + STEP / 2, lon_bin + STEP / 2

# ── Model ─────────────────────────────────────────────────────────────────────
class GeoModel(nn.Module):
    def __init__(self, backbone_name, num_classes, dropout=0.5):
        super().__init__()
        self.backbone = timm.create_model(backbone_name, pretrained=False, num_classes=0)
        feat_dim = self.backbone.num_features
        self.head = nn.Sequential(
            nn.BatchNorm1d(feat_dim), nn.Dropout(dropout),
            nn.Linear(feat_dim, 512), nn.GELU(),
            nn.Dropout(dropout / 2), nn.Linear(512, num_classes),
        )
    def forward(self, x): return self.head(self.backbone(x))

ckpt  = torch.load(BEST_MODEL, map_location=DEVICE, weights_only=True)
model = GeoModel('efficientnet_b0', ckpt['num_classes'])
model.load_state_dict(ckpt['model_state'])
model.to(DEVICE).eval()
print(f'Model loaded: epoch {ckpt["epoch"]}, val_loss {ckpt["val_loss"]:.4f}')

# ── Dataset ───────────────────────────────────────────────────────────────────
DATASET_PATH = Path(kagglehub.dataset_download('paulchambaz/google-street-view'))
IMG_DIR      = DATASET_PATH / 'dataset'
CSV_PATH     = IMG_DIR / 'coords.csv'

df = pd.read_csv(CSV_PATH, header=None, names=['lat', 'lon'])
df['img_path'] = df.index.map(lambda i: str(IMG_DIR / f'{i}.png'))
df = df[df['img_path'].apply(lambda p: Path(p).exists())].reset_index(drop=True)
print(f'Dataset: {len(df):,} images')

val_tf = transforms.Compose([
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])

# ── Helpers ───────────────────────────────────────────────────────────────────
def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin(math.radians(lat2 - lat1) / 2) ** 2
         + math.cos(phi1) * math.cos(phi2)
         * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

# Scoring scales per difficulty
_DIFF_SCALE = {'easy': 4000, 'normal': 2000, 'hard': 800}

def calc_score(dist_km, max_score=5000, difficulty='normal'):
    scale = _DIFF_SCALE.get(difficulty, 2000)
    return max(0, round(max_score * math.exp(-dist_km / scale)))

def img_to_b64(path, max_w=1200, max_h=800, quality=85):
    img = Image.open(path).convert('RGB')
    img.thumbnail((max_w, max_h))
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=quality)
    return base64.b64encode(buf.getvalue()).decode()

def ai_predict_pil(pil_img: Image.Image):
    tensor = val_tf(pil_img).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        probs    = torch.softmax(model(tensor)[0], dim=0)
        pred_idx = probs.argmax().item()
        conf     = float(probs[pred_idx])
    lat, lon = cell_center(idx_to_cell[pred_idx])
    return lat, lon, conf

def ai_predict(img_path):
    return ai_predict_pil(Image.open(img_path).convert('RGB'))

def approx_region(lat, lon):
    if lat > 60:                               return 'Nordeuropa / Arktis'
    if lat > 35 and -10 < lon < 40:            return 'Europa'
    if lat > 20 and 40  < lon < 140:           return 'Asien'
    if -35 < lat < 35  and -20 < lon < 55:     return 'Afrika'
    if lat > 15 and -130 < lon < -60:          return 'Nordamerika'
    if lat < 15 and -85  < lon < -35:          return 'Südamerika / Karibik'
    if lat < -10 and 110 < lon < 180:          return 'Australien / Ozeanien'
    return 'Unbekannte Region'

# ── Dataset sample (Explorer) ─────────────────────────────────────────────────
_ds_sample = (df.sample(min(DATASET_SAMPLE, len(df)))
              .reset_index()
              .rename(columns={'index': 'orig_idx'}))

# ── Multiplayer rooms ─────────────────────────────────────────────────────────
_rooms = {}   # code → room dict
_PLAYER_COLORS = ['#00e896', '#5b7fff', '#ffcc00', '#ff9500', '#a855f7', '#06b6d4', '#ff3d5a']

def _make_code():
    chars = string.ascii_uppercase + string.digits
    code  = ''.join(random.choices(chars, k=5))
    return code if code not in _rooms else _make_code()

def _sample_image():
    row = df.sample(1).iloc[0]
    return {'idx': int(row.name), 'img': img_to_b64(row['img_path'])}

def _sorted_scores(room, round_guesses=None):
    result = []
    for p in room['players'].values():
        entry = {'name': p['name'], 'score': p['score'], 'color': p['color']}
        if round_guesses:
            g = next((g for g in round_guesses.values() if g['name'] == p['name']), None)
            if g:
                entry['round_score'] = g['score']
                entry['dist']        = g['dist']
        result.append(entry)
    return sorted(result, key=lambda x: -x['score'])

# ── HTTP Routes ───────────────────────────────────────────────────────────────
@app.route('/')
def home():
    return render_template('home.html')

@app.route('/game')
def game():
    difficulty = request.args.get('difficulty', 'normal')
    rounds     = max(1, min(20, int(request.args.get('rounds', 5))))
    return render_template('index.html', rounds=rounds, difficulty=difficulty, room_code='', player_name='')

@app.route('/room/<code>')
def room_page(code):
    code = code.upper()
    if code not in _rooms:
        return redirect('/?error=room_not_found&code=' + code)
    r = _rooms[code]
    name = request.args.get('name', 'Spieler')
    return render_template('index.html',
                           rounds=r['rounds'],
                           difficulty=r['difficulty'],
                           room_code=code,
                           player_name=name)

@app.route('/api/image')
def get_image():
    row = df.sample(1).iloc[0]
    return jsonify({'img': img_to_b64(row['img_path']), 'idx': int(row.name),
                    'true_lat': float(row['lat']), 'true_lon': float(row['lon'])})

@app.route('/api/image_by_idx')
def image_by_idx():
    idx = max(0, min(int(request.args.get('idx', 0)), len(df) - 1))
    row = df.iloc[idx]
    return jsonify({'img': img_to_b64(row['img_path'], max_w=600, max_h=450, quality=80),
                    'lat': float(row['lat']), 'lon': float(row['lon'])})

@app.route('/api/dataset_points')
def dataset_points():
    pts = [{'idx': int(r['orig_idx']), 'lat': float(r['lat']), 'lon': float(r['lon'])}
           for _, r in _ds_sample.iterrows()]
    return jsonify(pts)

@app.route('/api/guess', methods=['POST'])
def guess():
    data       = request.json
    idx        = int(data['idx'])
    player_lat = float(data['lat'])
    player_lon = float(data['lon'])
    difficulty = data.get('difficulty', 'normal')

    row      = df.iloc[idx]
    true_lat = float(row['lat'])
    true_lon = float(row['lon'])

    ai_lat, ai_lon, ai_conf = ai_predict(row['img_path'])

    player_dist  = haversine_km(player_lat, player_lon, true_lat, true_lon)
    ai_dist      = haversine_km(ai_lat,     ai_lon,     true_lat, true_lon)
    player_score = calc_score(player_dist, difficulty=difficulty)
    ai_score     = calc_score(ai_dist,     difficulty=difficulty)
    winner       = 'player' if player_score >= ai_score else 'ai'

    return jsonify({
        'true_lat': true_lat, 'true_lon': true_lon,
        'ai_lat':   ai_lat,   'ai_lon':   ai_lon,
        'player_dist':  round(player_dist),
        'ai_dist':      round(ai_dist),
        'player_score': player_score,
        'ai_score':     ai_score,
        'ai_conf':      round(ai_conf * 100, 1),
        'winner':       winner,
    })

@app.route('/api/guess_image', methods=['POST'])
def guess_image():
    b64     = request.json.get('img', '')
    pil_img = Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGB')
    lat, lon, conf = ai_predict_pil(pil_img)
    return jsonify({'lat': round(lat, 4), 'lon': round(lon, 4),
                    'conf': round(conf * 100, 1), 'location': approx_region(lat, lon)})

# ── Socket events ─────────────────────────────────────────────────────────────
ROUND_TIMEOUT = 20   # seconds per round

@socketio.on('create_room')
def on_create_room(data):
    code        = _make_code()
    host_token  = secrets.token_hex(12)
    color       = _PLAYER_COLORS[0]
    _rooms[code] = {
        'host':       request.sid,
        'host_token': host_token,
        'players':    {request.sid: {'name': data['name'], 'score': 0, 'color': color}},
        'rounds':     int(data.get('rounds', 5)),
        'difficulty': data.get('difficulty', 'normal'),
        'round':      0,
        'image':      None,
        'guesses':    {},
        'state':      'lobby',
        '_timer':     None,
    }
    join_room(code)
    emit('room_created', {'code': code, 'rounds': _rooms[code]['rounds'],
                          'difficulty': _rooms[code]['difficulty'],
                          'host_token': host_token,
                          'players': list(_rooms[code]['players'].values())})

@socketio.on('lobby_start')
def on_lobby_start(data):
    """Host signals all players to redirect to the game page."""
    code = data['code']
    if code not in _rooms or _rooms[code]['host'] != request.sid:
        return
    _rooms[code]['state'] = 'starting'
    # emit() uses the request context and reliably reaches all sockets in the room
    emit('game_starting', {'code': code}, to=code)

@socketio.on('join_room_code')
def on_join(data):
    code       = data['code'].upper().strip()
    host_token = data.get('host_token', '')

    if code not in _rooms:
        emit('join_error', {'msg': f'Raum „{code}" nicht gefunden.'})
        return
    r = _rooms[code]

    # ── Host reconnect after lobby→game page redirect ──────────────────────────
    if host_token and host_token == r.get('host_token', ''):
        old_sid = r.get('_host_pending_sid') or r['host']
        if old_sid in r['players']:
            r['players'][request.sid] = r['players'].pop(old_sid)
        r['host'] = request.sid
        r.pop('_host_pending_sid', None)
        join_room(code)
        emit('join_ok', {'code': code, 'rounds': r['rounds'], 'difficulty': r['difficulty'],
                         'is_host': True, 'players': list(r['players'].values()),
                         'game_state': r['state']})
        # Re-broadcast game_starting to any non-host still on the home page
        emit('game_starting', {'code': code}, to=code, skip_sid=request.sid)
        return

    # ── Non-host reconnect during starting / playing (redirect from home) ──────
    if r['state'] in ('starting', 'playing'):
        # Find existing player slot by name so score is preserved
        old_sid = next((s for s, p in r['players'].items()
                        if p['name'] == data.get('name', '')), None)
        if old_sid and old_sid != request.sid:
            r['players'][request.sid] = r['players'].pop(old_sid)
        elif not old_sid:
            # Brand-new player joined while game is already running — add them
            used  = {p['color'] for p in r['players'].values()}
            color = next((c for c in _PLAYER_COLORS if c not in used), '#bcc8e0')
            r['players'][request.sid] = {'name': data['name'], 'score': 0, 'color': color}
        join_room(code)
        emit('join_ok', {'code': code, 'rounds': r['rounds'], 'difficulty': r['difficulty'],
                         'is_host': False, 'players': list(r['players'].values()),
                         'game_state': r['state']})
        # Catch-up: send current round image if game already started
        if r['state'] == 'playing' and r.get('image'):
            emit('round_start', {'round': r['round'], 'rounds': r['rounds'],
                                 'img': r['image']['img'], 'idx': r['image']['idx'],
                                 'players': list(r['players'].values())})
        return

    # ── Normal lobby join ──────────────────────────────────────────────────────
    if r['state'] != 'lobby':
        emit('join_error', {'msg': 'Das Spiel hat bereits begonnen.'})
        return
    used  = {p['color'] for p in r['players'].values()}
    color = next((c for c in _PLAYER_COLORS if c not in used), '#bcc8e0')
    r['players'][request.sid] = {'name': data['name'], 'score': 0, 'color': color}
    join_room(code)
    emit('join_ok',      {'code': code, 'rounds': r['rounds'], 'difficulty': r['difficulty'],
                          'is_host': False, 'players': list(r['players'].values()),
                          'game_state': r['state']})
    emit('lobby_update', {'players': list(r['players'].values())},
         to=code, skip_sid=request.sid)

@socketio.on('start_game')
def on_start(data):
    code = data['code']
    if code not in _rooms or _rooms[code]['host'] != request.sid:
        return
    _rooms[code]['round'] = 0
    _next_round(code)

def _next_round(code):
    r = _rooms[code]
    r['round']  += 1
    r['guesses'] = {}
    r['state']   = 'playing'
    r['image']   = _sample_image()
    round_num    = r['round']
    _emit('round_start', {
        'round': round_num, 'rounds': r['rounds'],
        'img': r['image']['img'], 'idx': r['image']['idx'],
        'players': list(r['players'].values()),
        'timeout': ROUND_TIMEOUT,
    }, to=code)
    # Server-side auto-reveal after ROUND_TIMEOUT seconds
    def _auto_reveal():
        room = _rooms.get(code)
        if not room or room['round'] != round_num or room['state'] != 'playing':
            return
        for sid, p in room['players'].items():
            if sid not in room['guesses']:
                room['guesses'][sid] = {
                    'name': p['name'], 'color': p['color'],
                    'lat': 0, 'lon': 0, 'dist': 20000, 'score': 0,
                }
        _reveal_round(code)
    t = threading.Timer(ROUND_TIMEOUT, _auto_reveal)
    t.daemon = True
    if r.get('_timer'):
        r['_timer'].cancel()
    r['_timer'] = t
    t.start()

@socketio.on('mp_guess')
def on_mp_guess(data):
    code = data['code']
    if code not in _rooms:
        return
    r = _rooms[code]
    if request.sid in r['guesses'] or r['state'] != 'playing':
        return

    lat, lon   = float(data['lat']), float(data['lon'])
    idx        = r['image']['idx']
    row        = df.iloc[idx]
    true_lat   = float(row['lat'])
    true_lon   = float(row['lon'])
    dist       = haversine_km(lat, lon, true_lat, true_lon)
    score      = calc_score(dist, difficulty=r['difficulty'])
    player     = r['players'][request.sid]

    r['guesses'][request.sid] = {
        'name': player['name'], 'color': player['color'],
        'lat': lat, 'lon': lon, 'dist': round(dist), 'score': score,
    }
    player['score'] += score

    _emit('guess_count', {'count': len(r['guesses']), 'total': len(r['players'])},
          to=code)
    emit('my_guess_result', {'dist': round(dist), 'score': score})

    if len(r['guesses']) >= len(r['players']):
        _reveal_round(code)

def _reveal_round(code):
    r = _rooms.get(code)
    if not r:
        return
    if r.get('_timer'):
        r['_timer'].cancel()
        r['_timer'] = None
    r['state'] = 'results'
    idx = r['image']['idx']
    row = df.iloc[idx]
    true_lat, true_lon = float(row['lat']), float(row['lon'])
    ai_lat, ai_lon, ai_conf = ai_predict(row['img_path'])
    ai_dist  = haversine_km(ai_lat, ai_lon, true_lat, true_lon)
    ai_score = calc_score(ai_dist, difficulty=r['difficulty'])
    _emit('round_results', {
        'true_lat': true_lat, 'true_lon': true_lon,
        'ai_lat':   ai_lat,   'ai_lon':   ai_lon,
        'ai_conf':  round(ai_conf * 100, 1),
        'ai_dist':  round(ai_dist),
        'ai_score': ai_score,
        'guesses':  list(r['guesses'].values()),
        'scores':   _sorted_scores(r, r['guesses']),
        'is_last':  r['round'] >= r['rounds'],
    }, to=code)

@socketio.on('mp_timeout')
def on_mp_timeout(data):
    """Host manually ends the round early."""
    code = data.get('code', '')
    if code not in _rooms or _rooms[code]['host'] != request.sid:
        return
    r = _rooms[code]
    if r['state'] != 'playing':
        return
    # Fill in default guesses for players who haven't guessed yet
    for sid, p in r['players'].items():
        if sid not in r['guesses']:
            r['guesses'][sid] = {
                'name': p['name'], 'color': p['color'],
                'lat': 0, 'lon': 0, 'dist': 20000, 'score': 0,
            }
    _reveal_round(code)

@socketio.on('mp_next')
def on_mp_next(data):
    code = data['code']
    if code not in _rooms or _rooms[code]['host'] != request.sid:
        return
    r = _rooms[code]
    if r['round'] >= r['rounds']:
        _emit('game_over', {'scores': _sorted_scores(r)}, to=code)
        del _rooms[code]
    else:
        _next_round(code)

@socketio.on('mp_restart')
def on_mp_restart(data):
    """Host restarts the game with the same room and players."""
    code = data.get('code', '')
    if code not in _rooms or _rooms[code]['host'] != request.sid:
        return
    r = _rooms[code]
    # Reset all player scores
    for p in r['players'].values():
        p['score'] = 0
    r['round']  = 0
    r['guesses'] = {}
    r['state']   = 'playing'
    _emit('mp_restarted', {'players': list(r['players'].values())}, to=code)
    _next_round(code)

@socketio.on('disconnect')
def on_disconnect():
    for code in list(_rooms.keys()):
        r = _rooms.get(code)
        if not r or request.sid not in r['players']:
            continue
        # Host mid-redirect: keep their player slot for reconnect
        if r['host'] == request.sid and r.get('host_token'):
            r['_host_pending_sid'] = request.sid
            leave_room(code)
            break
        # During active game: keep player slot (preserves score, guess count)
        if r['state'] in ('starting', 'playing', 'results'):
            leave_room(code)
            break
        name = r['players'][request.sid]['name']
        del r['players'][request.sid]
        leave_room(code)
        if not r['players']:
            del _rooms[code]
        else:
            if r['host'] == request.sid:
                r['host'] = next(iter(r['players']))
            emit('player_left', {'name': name,
                             'players': list(r['players'].values())}, to=code)
        break

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print('Starting GeoAI on http://localhost:5000')
    socketio.run(app, debug=False, port=5000, allow_unsafe_werkzeug=True)
