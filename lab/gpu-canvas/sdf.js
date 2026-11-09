// Glyph atlas: one signed-distance cell per printable ASCII character, built
// once from the system font. A distance field stays sharp at any zoom, so the
// same 40 px source serves an 8 px seat line and a 200 px region name.

const INF = 1e20;

function edt1d(grid, offset, stride, length, f, v, z) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}

function edt(grid, size, f, v, z) {
  for (let x = 0; x < size; x++) edt1d(grid, x, size, size, f, v, z);
  for (let y = 0; y < size; y++) edt1d(grid, y * size, 1, size, f, v, z);
}

export function buildGlyphAtlas() {
  const fontSize = 40;
  const buffer = 8;
  const radius = 12;
  const cutoff = 0.25;
  const cell = fontSize + buffer * 2;
  const cols = 16;
  const count = 95;
  const rows = Math.ceil(count / cols);
  const width = cols * cell;
  const height = rows * cell;
  const data = new Uint8Array(width * height);
  const canvas = new OffscreenCanvas(cell, cell);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.font = `500 ${fontSize}px -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#000";
  const baseline = buffer + Math.round(fontSize * 0.78);
  const outer = new Float64Array(cell * cell);
  const inner = new Float64Array(cell * cell);
  const f = new Float64Array(cell);
  const z = new Float64Array(cell + 1);
  const v = new Uint16Array(cell);
  const glyphs = [];
  for (let i = 0; i < count; i++) {
    const ch = String.fromCharCode(32 + i);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const advance = ctx.measureText(ch).width / fontSize;
    ctx.clearRect(0, 0, cell, cell);
    ctx.fillText(ch, buffer, baseline);
    const alpha = ctx.getImageData(0, 0, cell, cell).data;
    outer.fill(INF);
    inner.fill(0);
    for (let p = 0; p < cell * cell; p++) {
      const a = alpha[p * 4 + 3] / 255;
      if (a === 0) continue;
      if (a === 1) {
        outer[p] = 0;
        inner[p] = INF;
      } else {
        const d = 0.5 - a;
        outer[p] = d > 0 ? d * d : 0;
        inner[p] = d < 0 ? d * d : 0;
      }
    }
    edt(outer, cell, f, v, z);
    edt(inner, cell, f, v, z);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const d = Math.sqrt(outer[y * cell + x]) - Math.sqrt(inner[y * cell + x]);
        data[(row * cell + y) * width + col * cell + x] = Math.max(0, Math.min(255, Math.round(255 - 255 * (d / radius + cutoff))));
      }
    }
    glyphs.push({
      u0: Math.round(((col * cell) / width) * 65535),
      v0: Math.round(((row * cell) / height) * 65535),
      u1: Math.round((((col + 1) * cell) / width) * 65535),
      v1: Math.round((((row + 1) * cell) / height) * 65535),
      advance,
      blank: ch === " ",
    });
  }
  return { data, width, height, glyphs, cell: cell / fontSize, buffer: buffer / fontSize, baseline: baseline / fontSize };
}

export function measure(atlas, text, size) {
  let w = 0;
  for (let i = 0; i < text.length; i++) w += (atlas.glyphs[text.charCodeAt(i) - 32] ?? atlas.glyphs[31]).advance;
  return w * size;
}
