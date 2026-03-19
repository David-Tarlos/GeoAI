import io, json, math, base64, random
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image
from flask import Flask, jsonify, render_template, request

import torch
import torch.nn as nn
import timm
from torchvision import transforms
import kagglehub

app = Flask(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
CHECKPOINT_DIR = Path('checkpoints')
BEST_MODEL     = CHECKPOINT_DIR / 'best_model.pth'
CELL_MAPPING   = CHECKPOINT_DIR / 'cell_mapping.json'
DEVICE         = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
ROUNDS         = 5
DATASET_SAMPLE = 2000   # how many dots to show in Dataset Explorer

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

def calc_score(dist_km, max_score=5000):
    return max(0, round(max_score * math.exp(-dist_km / 2000)))

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

# ── Precompute dataset sample for Explorer ────────────────────────────────────
_ds_sample = (df.sample(min(DATASET_SAMPLE, len(df)))
              .reset_index()
              .rename(columns={'index': 'orig_idx'}))

# ── Routes ────────────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html', rounds=ROUNDS)

@app.route('/api/image')
def get_image():
    row = df.sample(1).iloc[0]
    return jsonify({
        'img'     : img_to_b64(row['img_path']),
        'idx'     : int(row.name),
        'true_lat': float(row['lat']),
        'true_lon': float(row['lon']),
    })

@app.route('/api/image_by_idx')
def image_by_idx():
    """Return the image for a specific dataset index (used by Explorer)."""
    idx = int(request.args.get('idx', 0))
    idx = max(0, min(idx, len(df) - 1))
    row = df.iloc[idx]
    return jsonify({
        'img': img_to_b64(row['img_path'], max_w=600, max_h=450, quality=80),
        'lat': float(row['lat']),
        'lon': float(row['lon']),
    })

@app.route('/api/dataset_points')
def dataset_points():
    """Return a sample of dataset coordinates for the Explorer map."""
    pts = [
        {'idx': int(r['orig_idx']), 'lat': float(r['lat']), 'lon': float(r['lon'])}
        for _, r in _ds_sample.iterrows()
    ]
    return jsonify(pts)

@app.route('/api/guess', methods=['POST'])
def guess():
    data       = request.json
    idx        = int(data['idx'])
    player_lat = float(data['lat'])
    player_lon = float(data['lon'])

    row      = df.iloc[idx]
    true_lat = float(row['lat'])
    true_lon = float(row['lon'])

    ai_lat, ai_lon, ai_conf = ai_predict(row['img_path'])

    player_dist  = haversine_km(player_lat, player_lon, true_lat, true_lon)
    ai_dist      = haversine_km(ai_lat,     ai_lon,     true_lat, true_lon)
    player_score = calc_score(player_dist)
    ai_score     = calc_score(ai_dist)
    winner       = 'player' if player_score >= ai_score else 'ai'

    return jsonify({
        'true_lat'    : true_lat,    'true_lon'    : true_lon,
        'ai_lat'      : ai_lat,      'ai_lon'      : ai_lon,
        'player_dist' : round(player_dist),
        'ai_dist'     : round(ai_dist),
        'player_score': player_score,
        'ai_score'    : ai_score,
        'ai_conf'     : round(ai_conf * 100, 1),
        'winner'      : winner,
    })

@app.route('/api/guess_image', methods=['POST'])
def guess_image():
    """Accept a base64 image and return AI geolocation prediction."""
    b64       = request.json.get('img', '')
    pil_img   = Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGB')
    lat, lon, conf = ai_predict_pil(pil_img)
    return jsonify({
        'lat'     : round(lat, 4),
        'lon'     : round(lon, 4),
        'conf'    : round(conf * 100, 1),
        'location': approx_region(lat, lon),
    })

if __name__ == '__main__':
    print('Starting GeoAI on http://localhost:5000')
    app.run(debug=False, port=5000)