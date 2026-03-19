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

# ── Konfiguration ─────────────────────────────────────────────────────────────
CHECKPOINT_DIR = Path('checkpoints')
BEST_MODEL     = CHECKPOINT_DIR / 'best_model.pth'
CELL_MAPPING   = CHECKPOINT_DIR / 'cell_mapping.json'
DEVICE         = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
ROUNDS         = 5

# ── Zell-Mapping laden ────────────────────────────────────────────────────────
with open(CELL_MAPPING) as f:
    mapping = json.load(f)
idx_to_cell = {int(k): v for k, v in mapping['idx_to_cell'].items()}
STEP = mapping['step']

def cell_center(cell_id):
    lat_bin, lon_bin = map(float, cell_id.split('_'))
    return lat_bin + STEP / 2, lon_bin + STEP / 2

# ── Modell laden ──────────────────────────────────────────────────────────────
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
print(f'Modell geladen: Epoche {ckpt["epoch"]}, Val-Loss {ckpt["val_loss"]:.4f}')

# ── Dataset laden ─────────────────────────────────────────────────────────────
DATASET_PATH = Path(kagglehub.dataset_download('paulchambaz/google-street-view'))
IMG_DIR      = DATASET_PATH / 'dataset'
CSV_PATH     = IMG_DIR / 'coords.csv'

df = pd.read_csv(CSV_PATH, header=None, names=['lat', 'lon'])
df['img_path'] = df.index.map(lambda i: str(IMG_DIR / f'{i}.png'))
df = df[df['img_path'].apply(lambda p: Path(p).exists())].reset_index(drop=True)
print(f'Dataset: {len(df):,} Bilder')

val_tf = transforms.Compose([
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])

# ── Hilfsfunktionen ───────────────────────────────────────────────────────────
def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin(math.radians(lat2 - lat1) / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def calc_score(dist_km, max_score=5000):
    return max(0, round(max_score * math.exp(-dist_km / 2000)))

def img_to_b64(path):
    img = Image.open(path).convert('RGB')
    img.thumbnail((1200, 800))
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=85)
    return base64.b64encode(buf.getvalue()).decode()

def ai_predict(img_path):
    img    = Image.open(img_path).convert('RGB')
    tensor = val_tf(img).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        probs    = torch.softmax(model(tensor)[0], dim=0)
        pred_idx = probs.argmax().item()
        conf     = float(probs[pred_idx])
    lat, lon = cell_center(idx_to_cell[pred_idx])
    return lat, lon, conf

# ── Routen ────────────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html', rounds=ROUNDS)

@app.route('/api/image')
def get_image():
    row    = df.sample(1).iloc[0]
    img_b64 = img_to_b64(row['img_path'])
    return jsonify({
        'img'     : img_b64,
        'idx'     : int(row.name),
        'true_lat': float(row['lat']),
        'true_lon': float(row['lon']),
    })

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

if __name__ == '__main__':
    print('Starte GeoAI Spiel auf http://localhost:5000')
    app.run(debug=False, port=5000)
