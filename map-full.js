// A full-screen map: enough 256 px map tiles to cover the screen (1920 x 1080 for the
// Roku, or whatever size a browser asks for, so it never has to stretch),
// placed so every point of interest (the bus, home, the next stop) is on
// screen. With zoom "auto" it picks the closest zoom that still fits them all.

const TILE = 256;

function worldPixel(lat, lon, z) {
  const n = 2 ** z * TILE;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

/**
 * points: [{ kind, label, lat, lon, color }]
 * zoom:   a number (10-18) or 'auto'
 * Returns tile urls in row order plus where each point lands on screen.
 */
export function buildFullMap({ points, zoom = 'auto', width = 1920, height = 1080, tileUrl, roomX = null, roomY = null }) {
  width = Math.round(Math.min(3840, Math.max(320, Number(width) || 1920)));
  height = Math.round(Math.min(2160, Math.max(240, Number(height) || 1080)));
  // room for the labels and the title card, in proportion on smaller screens
  roomX = roomX ?? Math.min(520, width * 0.27);
  roomY = roomY ?? Math.min(380, height * 0.35);
  const usable = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && (p.lat || p.lon));
  if (!usable.length) return null;

  let z = Number(zoom);
  if (!Number.isFinite(z)) {
    // closest zoom where everything fits inside the screen, leaving room for the labels
    z = usable.length === 1 ? 15 : 10;
    if (usable.length > 1) {
      for (let tryZ = 17; tryZ >= 10; tryZ--) {
        const px = usable.map(p => worldPixel(p.lat, p.lon, tryZ));
        const w = Math.max(...px.map(p => p.x)) - Math.min(...px.map(p => p.x));
        const h = Math.max(...px.map(p => p.y)) - Math.min(...px.map(p => p.y));
        if (w <= width - roomX && h <= height - roomY) { z = tryZ; break; }
      }
    }
  }
  z = Math.min(18, Math.max(10, Math.round(z)));

  const px = usable.map(p => worldPixel(p.lat, p.lon, z));
  const cx = (Math.max(...px.map(p => p.x)) + Math.min(...px.map(p => p.x))) / 2;
  // nudge the middle down a little: the top of the screen holds the title card
  const cy = (Math.max(...px.map(p => p.y)) + Math.min(...px.map(p => p.y))) / 2 - Math.min(60, height * 0.055);

  const left = cx - width / 2;
  const top = cy - height / 2;
  const startX = Math.floor(left / TILE);
  const startY = Math.floor(top / TILE);
  const originX = Math.round(startX * TILE - left);
  const originY = Math.round(startY * TILE - top);
  const cols = Math.ceil((width - originX) / TILE);
  const rows = Math.ceil((height - originY) / TILE);
  const max = 2 ** z;

  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ty = startY + r;
      const tx = ((startX + c) % max + max) % max;
      tiles.push(ty < 0 || ty >= max ? '' : tileUrl(z, tx, ty));
    }
  }

  const pins = usable.map((p, i) => ({
    kind: p.kind,
    label: p.label || '',
    color: p.color || '0xE8623CFF',
    x: Math.round(px[i].x - left),
    y: Math.round(px[i].y - top)
  }));

  return { zoom: z, tileSize: TILE, width, height, originX, originY, cols, rows, tiles, pins };
}
