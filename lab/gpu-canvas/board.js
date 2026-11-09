// Board: the fixture's nodes and wires as GPU instance records, tiled `scale`
// times. Every record is fixed size, so a seat's report later rewrites a few
// bytes in place and nothing else moves.

import { measure } from "./sdf.js";

export const RECT_STRIDE = 40; // 10 words: x y w h | fill | stroke | radius kind strokeW spare
export const MARK_STRIDE = 36; // 9 words: cx cy r phase | state changedAt face spare | tint
export const WIRE_STRIDE = 52; // 13 words: a b | c d | color | pulseStart width spare spare
export const GLYPH_STRIDE = 32; // 8 words: x y w h | uv (4 x u16) | color | band
export const NAME_CAP = 18;
export const LINE_CAP = 44;
export const CELL = 1536;
export const LINE_SIZE = 11.5;

export const PHRASES = [
  "reading src/core/seat-state.ts",
  "running bun test tests/canvas-tier.test.ts",
  "editing src/window/components/Canvas.tsx",
  "waiting on a reply from tech-lead",
  "rg -n publishCanvasTier src/window",
  "committing through a private index",
  "tracing the renderer for 30 seconds",
  "thinking about the wire layout",
  "building bundles, all features on",
  "reviewing the diff, 214 lines",
  "writing the accounting package",
  "git log --oneline -20",
  "mailing canvas-lead the numbers",
  "needs you: approve the delete list",
  "done: 3 files changed, tests pass",
  "bun run verify (41 of 63 gates)",
  "reading docs/security-doctrine.md",
  "measuring zoom on the rig board",
];

const rgba = (r, g, b, a) => ((Math.round(a * 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;

const INK = rgba(232, 233, 236, 1);
const INK_SOFT = rgba(139, 143, 152, 1);
const INK_REGION = rgba(169, 173, 182, 0.9);
const INK_GLANCE = rgba(200, 204, 212, 0.55);
const INK_NOTE = rgba(214, 206, 178, 0.92);
export const LINE_COLOR = INK_SOFT;

const HARNESS_TINT = {
  claude: rgba(232, 138, 96, 1),
  codex: rgba(120, 208, 170, 1),
  opencode: rgba(126, 170, 255, 1),
  pi: rgba(196, 150, 255, 1),
};
const TINT_DEFAULT = rgba(126, 170, 255, 1);

export function layoutRun(glyph, slot, cap, text, x, baseline, size, color, band, atlas) {
  const { f32, u16, u32 } = glyph;
  let pen = x;
  const n = Math.min(cap, text.length);
  for (let i = 0; i < cap; i++) {
    const o = (slot + i) * 8;
    if (i >= n) {
      f32[o + 2] = 0;
      f32[o + 3] = 0;
      continue;
    }
    const g = atlas.glyphs[text.charCodeAt(i) - 32] ?? atlas.glyphs[31];
    const side = g.blank ? 0 : atlas.cell * size;
    f32[o] = pen - atlas.buffer * size;
    f32[o + 1] = baseline - atlas.baseline * size;
    f32[o + 2] = side;
    f32[o + 3] = side;
    const u = (slot + i) * 16 + 8;
    u16[u] = g.u0;
    u16[u + 1] = g.v0;
    u16[u + 2] = g.u1;
    u16[u + 3] = g.v1;
    u32[o + 6] = color;
    u32[o + 7] = band;
    pen += g.advance * size;
  }
}

function wrap(atlas, text, size, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(atlas, next, size) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export function buildBoard(model, scale, atlas) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of model.nodes) {
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.width);
    y1 = Math.max(y1, n.y + n.height);
  }
  const bw = x1 - x0;
  const bh = y1 - y0;
  const gap = 900;
  const cols = Math.ceil(Math.sqrt(scale));
  const rowsN = Math.ceil(scale / cols);
  const nodes = [];
  const wires = [];
  for (let k = 0; k < scale; k++) {
    const ox = (k % cols) * (bw + gap) - x0;
    const oy = Math.floor(k / cols) * (bh + gap) - y0;
    const ids = new Map();
    for (const n of model.nodes) {
      const c = { ...n, x: n.x + ox, y: n.y + oy };
      ids.set(n.id, c);
      nodes.push(c);
    }
    for (const w of model.wires) {
      const a = ids.get(w.from);
      const b = ids.get(w.to);
      if (a && b) wires.push({ a, b });
    }
  }
  const bounds = { x: 0, y: 0, width: cols * (bw + gap) - gap, height: rowsN * (bh + gap) - gap };

  const regions = nodes.filter((n) => n.kind === "region").sort((a, b) => a.z - b.z);
  const notes = nodes.filter((n) => n.kind === "note");
  const terms = nodes.filter((n) => n.kind === "terminal");
  const seats = nodes.filter((n) => n.kind === "agent");
  seats.forEach((s, i) => {
    s.seat = i;
  });

  // Rects: regions first (drawn under the wires), then notes, terminals, cards.
  const rectCount = regions.length + notes.length + terms.length + seats.length;
  const rectBuf = new ArrayBuffer(rectCount * RECT_STRIDE);
  const rf = new Float32Array(rectBuf);
  const ru = new Uint32Array(rectBuf);
  let ri = 0;
  const putRect = (n, fill, stroke, radius, kind, strokeW) => {
    const o = ri * 10;
    rf[o] = n.x;
    rf[o + 1] = n.y;
    rf[o + 2] = n.width;
    rf[o + 3] = n.height;
    ru[o + 4] = fill;
    ru[o + 5] = stroke;
    rf[o + 6] = radius;
    rf[o + 7] = kind;
    rf[o + 8] = strokeW;
    ri++;
  };
  for (const n of regions) putRect(n, rgba(255, 255, 255, 0.022), rgba(255, 255, 255, 0.13), 18, 0, 1);
  for (const n of notes) putRect(n, rgba(44, 41, 30, 0.96), rgba(214, 190, 120, 0.22), 8, 1, 1);
  for (const n of terms) putRect(n, rgba(16, 18, 22, 1), rgba(255, 255, 255, 0.16), 8, 1, 1);
  for (const n of seats) putRect(n, rgba(27, 29, 35, 1), rgba(255, 255, 255, 0.1), 12, 1, 1);

  // Marks: one ring and portrait per seat.
  const markBuf = new ArrayBuffer(seats.length * MARK_STRIDE);
  const mf = new Float32Array(markBuf);
  const mu = new Uint32Array(markBuf);
  seats.forEach((n, i) => {
    const o = i * 9;
    const roll = (i * 37) % 100;
    mf[o] = n.x + 28;
    mf[o + 1] = n.y + n.height / 2;
    mf[o + 2] = 22;
    mf[o + 3] = ((i * 61) % 100) / 100;
    mf[o + 4] = roll < 60 ? 1 : roll < 70 ? 2 : roll < 85 ? 3 : 0;
    mf[o + 5] = -10;
    mf[o + 6] = i % 64;
    mu[o + 8] = HARNESS_TINT[n.harness] ?? TINT_DEFAULT;
  });

  // Wires: a cubic from the right side of one node to the left side of the next.
  const wireBuf = new ArrayBuffer(wires.length * WIRE_STRIDE);
  const wf = new Float32Array(wireBuf);
  const wu = new Uint32Array(wireBuf);
  const seatWireLists = seats.map(() => []);
  wires.forEach((w, i) => {
    const o = i * 13;
    const sx = w.a.x + w.a.width;
    const sy = w.a.y + w.a.height / 2;
    const tx = w.b.x;
    const ty = w.b.y + w.b.height / 2;
    const d = tx - sx;
    const off = d >= 0 ? 0.5 * d : 6.25 * Math.sqrt(-d);
    wf[o] = sx;
    wf[o + 1] = sy;
    wf[o + 2] = sx + off;
    wf[o + 3] = sy;
    wf[o + 4] = tx - off;
    wf[o + 5] = ty;
    wf[o + 6] = tx;
    wf[o + 7] = ty;
    wu[o + 8] = rgba(128, 160, 198, 0.2);
    wf[o + 9] = -10;
    wf[o + 10] = 1.5;
    if (w.a.seat !== undefined) seatWireLists[w.a.seat].push(i);
    if (w.b.seat !== undefined) seatWireLists[w.b.seat].push(i);
  });
  const seatWireStart = new Int32Array(seats.length);
  const seatWireCount = new Int32Array(seats.length);
  const seatWires = new Int32Array(seatWireLists.reduce((sum, l) => sum + l.length, 0));
  let sw = 0;
  seatWireLists.forEach((list, i) => {
    seatWireStart[i] = sw;
    seatWireCount[i] = list.length;
    for (const w of list) seatWires[sw++] = w;
  });

  // Text runs. Cell runs are sorted row-major so each visible row of cells is
  // one contiguous draw; region glance names sit in a tail that is always drawn.
  const gridCols = Math.max(1, Math.ceil(bounds.width / CELL));
  const gridRows = Math.max(1, Math.ceil(bounds.height / CELL));
  const cellOf = (x, y) =>
    Math.min(gridRows - 1, Math.max(0, Math.floor(y / CELL))) * gridCols + Math.min(gridCols - 1, Math.max(0, Math.floor(x / CELL)));
  const runs = [];
  const glance = [];
  for (const n of regions) {
    const label = String(n.label ?? "");
    runs.push({ text: label, cap: Math.min(28, label.length), x: n.x + 18, y: n.y + 32, size: 16, color: INK_REGION, band: 0 });
    const size = Math.max(36, Math.min(260, (n.width * 0.6) / Math.max(1, measure(atlas, label, 1))));
    glance.push({ text: label, cap: Math.min(28, label.length), x: n.x + (n.width - measure(atlas, label, size)) / 2, y: n.y + n.height / 2 + size * 0.35, size, color: INK_GLANCE, band: 4 });
  }
  for (const n of notes) {
    wrap(atlas, String(n.text ?? ""), 13, n.width - 24).slice(0, Math.max(1, Math.floor((n.height - 16) / 18))).forEach((line, i) => {
      runs.push({ text: line, cap: line.length, x: n.x + 12, y: n.y + 24 + i * 18, size: 13, color: INK_NOTE, band: 3 });
    });
  }
  for (const n of terms) {
    const label = String(n.label ?? "");
    runs.push({ text: label, cap: label.length, x: n.x + 14, y: n.y + n.height / 2 + 4, size: 12, color: INK_SOFT, band: 1 });
  }
  seats.forEach((n, i) => {
    const label = String(n.label ?? "");
    runs.push({ text: label, cap: NAME_CAP, x: n.x + 60, y: n.y + 24, size: 14, color: INK, band: 1 });
    runs.push({ text: PHRASES[i % PHRASES.length], cap: LINE_CAP, x: n.x + 60, y: n.y + 42, size: LINE_SIZE, color: LINE_COLOR, band: 2, seat: i });
  });
  for (const r of runs) r.cell = cellOf(r.x, r.y);
  runs.sort((a, b) => a.cell - b.cell);

  const cellSlots = runs.reduce((sum, r) => sum + r.cap, 0);
  const glanceSlots = glance.reduce((sum, r) => sum + r.cap, 0);
  const glyphBuf = new ArrayBuffer(Math.max(1, cellSlots + glanceSlots) * GLYPH_STRIDE);
  const glyph = { f32: new Float32Array(glyphBuf), u16: new Uint16Array(glyphBuf), u32: new Uint32Array(glyphBuf) };
  const cellStart = new Uint32Array(gridCols * gridRows + 1);
  const seatLine = new Int32Array(seats.length);
  const seatLineX = new Float32Array(seats.length);
  const seatLineY = new Float32Array(seats.length);
  let slot = 0;
  let cell = 0;
  for (const r of runs) {
    while (cell <= r.cell) cellStart[cell++] = slot;
    layoutRun(glyph, slot, r.cap, r.text, r.x, r.y, r.size, r.color, r.band, atlas);
    if (r.seat !== undefined) {
      seatLine[r.seat] = slot;
      seatLineX[r.seat] = r.x;
      seatLineY[r.seat] = r.y;
    }
    slot += r.cap;
  }
  while (cell <= gridCols * gridRows) cellStart[cell++] = slot;
  const glanceStart = slot;
  for (const r of glance) {
    layoutRun(glyph, slot, r.cap, r.text, r.x, r.y, r.size, r.color, r.band, atlas);
    slot += r.cap;
  }

  // Hit testing: seats bucketed on a coarse grid.
  const HIT = 512;
  const hit = new Map();
  seats.forEach((n, i) => {
    for (let gy = Math.floor(n.y / HIT); gy <= Math.floor((n.y + n.height) / HIT); gy++) {
      for (let gx = Math.floor(n.x / HIT); gx <= Math.floor((n.x + n.width) / HIT); gx++) {
        const key = gy * 65536 + gx;
        const list = hit.get(key);
        if (list) list.push(i);
        else hit.set(key, [i]);
      }
    }
  });
  const seatAt = (x, y) => {
    const list = hit.get(Math.floor(y / HIT) * 65536 + Math.floor(x / HIT));
    if (!list) return -1;
    for (const i of list) {
      const n = seats[i];
      if (x >= n.x && x <= n.x + n.width && y >= n.y && y <= n.y + n.height) return i;
    }
    return -1;
  };

  return {
    bounds,
    rectBuf,
    rectCount,
    regionCount: regions.length,
    markBuf,
    seatCount: seats.length,
    wireBuf,
    wireCount: wires.length,
    glyphBuf,
    glyph,
    glyphCount: cellSlots + glanceSlots,
    cellStart,
    gridCols,
    gridRows,
    glanceStart,
    glanceCount: glanceSlots,
    seatLine,
    seatLineX,
    seatLineY,
    seatWireStart,
    seatWireCount,
    seatWires,
    seatAt,
    nodeCount: nodes.length,
  };
}
