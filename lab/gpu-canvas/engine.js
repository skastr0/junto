// The engine: one render pass, four instanced pipelines (rects, wires, marks,
// text), a camera, and its own frame timings. Detail levels are decided in the
// shaders from the zoom, so crossing a level costs nothing and fades for free.
// Runs unchanged on a page's main thread, in a worker, or in its own frame.

import { GLYPH_STRIDE, LINE_CAP, LINE_COLOR, LINE_SIZE, MARK_STRIDE, PHRASES, RECT_STRIDE, WIRE_STRIDE, CELL, layoutRun } from "./board.js";

const SEG = 20;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 2.5;
const LOG_CAP = 60000;

const PRELUDE = /* wgsl */ `
struct U { cam: vec4f, view: vec4f, misc: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var glyphTex: texture_2d<f32>;
@group(0) @binding(3) var faceTex: texture_2d<f32>;
const OFF = vec4f(2.0, 2.0, 2.0, 1.0);
fn toClip(w: vec2f) -> vec4f {
  let s = (w - u.cam.xy) * u.cam.z;
  return vec4f(s.x / u.view.x * 2.0 - 1.0, 1.0 - s.y / u.view.y * 2.0, 0.0, 1.0);
}
fn lodNear() -> f32 { return smoothstep(0.56, 0.66, u.cam.z); }
fn lodMid() -> f32 { return smoothstep(0.30, 0.38, u.cam.z); }
fn lodFar() -> f32 { return smoothstep(0.17, 0.23, u.cam.z); }
`;

const RECT = /* wgsl */ `
struct V { @builtin(position) pos: vec4f, @location(0) local: vec2f, @location(1) half: vec2f, @location(2) fill: vec4f, @location(3) stroke: vec4f, @location(4) misc: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4f, @location(1) fill: vec4f, @location(2) stroke: vec4f, @location(3) misc: vec4f) -> V {
  var o: V;
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let half = rect.zw * 0.5;
  let local = corner * (half + 1.5 / u.cam.z);
  var a = 1.0;
  if (misc.y > 0.5) { a = lodMid(); }
  o.pos = toClip(rect.xy + half + local);
  if (a < 0.004) { o.pos = OFF; }
  o.local = local;
  o.half = half;
  o.fill = fill;
  o.stroke = stroke;
  o.misc = vec4f(misc.x, a, misc.z, 0.0);
  return o;
}
@fragment fn fs(i: V) -> @location(0) vec4f {
  let r = min(i.misc.x, min(i.half.x, i.half.y));
  let q = abs(i.local) - i.half + r;
  let d = (length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r) * u.cam.z * u.view.z;
  let cover = clamp(0.5 - d, 0.0, 1.0);
  let sw = max(i.misc.z * u.cam.z * u.view.z, 1.0);
  let inner = clamp(0.5 - (d + sw), 0.0, 1.0);
  let col = mix(i.stroke, i.fill, inner);
  let a = col.a * cover * i.misc.y;
  return vec4f(col.rgb * a, a);
}
`;

const WIRE = /* wgsl */ `
struct V { @builtin(position) pos: vec4f, @location(0) across: f32, @location(1) halfw: f32, @location(2) t: f32, @location(3) color: vec4f, @location(4) pulse: f32, @location(5) vis: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) ab: vec4f, @location(1) cd: vec4f, @location(2) color: vec4f, @location(3) misc: vec4f) -> V {
  var o: V;
  let t = f32(vi >> 1u) / ${SEG}.0;
  let side = f32(vi & 1u) * 2.0 - 1.0;
  let a = ab.xy; let b = ab.zw; let c = cd.xy; let d = cd.zw;
  let m = 1.0 - t;
  let p = m * m * m * a + 3.0 * m * m * t * b + 3.0 * m * t * t * c + t * t * t * d;
  var tan = 3.0 * m * m * (b - a) + 6.0 * m * t * (c - b) + 3.0 * t * t * (d - c);
  if (dot(tan, tan) < 1e-6) { tan = d - a + vec2f(1e-3, 0.0); }
  let n = normalize(vec2f(-tan.y, tan.x));
  let age = u.cam.w - misc.x;
  let live = age >= 0.0 && age < 1.4;
  var halfw = max(misc.y * 0.5 * u.cam.z, 0.6);
  if (live) { halfw = halfw * 1.8; }
  let ext = halfw + 1.0;
  let vis = lodFar();
  o.pos = toClip(p + n * side * ext / u.cam.z);
  if (vis < 0.004) { o.pos = OFF; }
  o.across = side * ext;
  o.halfw = halfw;
  o.t = t;
  o.color = color;
  o.pulse = select(-1.0, age / 1.4, live);
  o.vis = vis;
  return o;
}
@fragment fn fs(i: V) -> @location(0) vec4f {
  let cover = clamp((i.halfw - abs(i.across)) * u.view.z + 0.5, 0.0, 1.0);
  var a = i.color.a;
  var rgb = i.color.rgb;
  if (i.pulse >= 0.0) {
    let k = (i.t - i.pulse) * 9.0;
    let bump = exp(-k * k);
    a = a + (1.0 - a) * (0.2 + 0.8 * bump) * (1.0 - i.pulse * 0.5);
    rgb = mix(rgb, vec3f(1.0), bump * 0.6);
  }
  a = a * cover * i.vis;
  return vec4f(rgb * a, a);
}
`;

const MARK = /* wgsl */ `
struct V { @builtin(position) pos: vec4f, @location(0) p: vec2f, @location(1) st: vec4f, @location(2) tint: vec4f, @location(3) px: f32, @location(4) phase: f32, @location(5) hot: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, @location(0) c: vec4f, @location(1) st: vec4f, @location(2) tint: vec4f) -> V {
  var o: V;
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let grow = clamp(13.0 / (c.z * u.cam.z), 1.0, 2.6);
  let r = c.z * grow;
  o.pos = toClip(c.xy + corner * r * 1.6);
  o.p = corner * 1.6;
  o.st = st;
  o.tint = tint;
  o.px = 1.0 / (r * u.cam.z * u.view.z);
  o.phase = c.w;
  o.hot = select(0.0, 1.0, f32(ii) == u.misc.x);
  return o;
}
@fragment fn fs(i: V) -> @location(0) vec4f {
  let d = length(i.p);
  let t = u.cam.w;
  let state = i.st.x;
  let face = 0.8;
  let cell = vec2f(i.st.z % 8.0, floor(i.st.z / 8.0));
  let uv = (cell + (i.p / face) * 0.48 + 0.5) / 8.0;
  let tex = textureSampleLevel(faceTex, samp, uv, 0.0);
  let faceA = clamp((face - d) / i.px + 0.5, 0.0, 1.0);
  var col = tex.rgb * faceA;
  var alpha = faceA;
  let band = clamp((d - 0.87) / i.px + 0.5, 0.0, 1.0) * clamp((1.0 - d) / i.px + 0.5, 0.0, 1.0);
  var ringA = 0.3;
  var ringC = vec3f(0.55, 0.58, 0.64);
  if (state > 0.5 && state < 1.5) {
    let sweep = fract(atan2(i.p.y, i.p.x) / 6.2831853 - t * 0.9 + i.phase);
    ringA = 0.22 + 0.78 * sweep * sweep;
    ringC = i.tint.rgb;
  } else if (state > 1.5 && state < 2.5) {
    ringA = 0.6 + 0.4 * sin(t * 4.0 + i.phase * 6.2831853);
    ringC = vec3f(1.0, 0.72, 0.2);
  } else if (state > 2.5) {
    ringA = 0.85;
    ringC = vec3f(0.35, 0.8, 0.5);
  }
  ringA = min(1.0, ringA + i.hot * 0.5);
  let ra = band * ringA;
  col = col + ringC * ra;
  alpha = alpha + ra;
  let age = t - i.st.y;
  if (age >= 0.0 && age < 0.7) {
    let k = (d - (1.0 + age * 0.75)) / 0.06;
    let w = exp(-k * k) * (1.0 - age / 0.7) * 0.8;
    col = col + ringC * w;
    alpha = alpha + w;
  }
  return vec4f(col, min(alpha, 1.0));
}
`;

const TEXT = /* wgsl */ `
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4f, @location(1) uvr: vec4f, @location(2) color: vec4f, @location(3) band: vec4u) -> V {
  var o: V;
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u));
  var a = 1.0;
  let b = band.x;
  if (b == 0u || b == 1u) { a = lodMid(); }
  else if (b == 2u || b == 3u) { a = lodNear(); }
  else if (b == 4u) { a = 1.0 - lodMid(); }
  a = a * smoothstep(3.0, 5.0, rect.w * u.cam.z * 0.714);
  o.pos = toClip(rect.xy + corner * rect.zw);
  if (a < 0.004 || rect.z <= 0.0) { o.pos = OFF; }
  o.uv = mix(uvr.xy, uvr.zw, corner);
  o.color = vec4f(color.rgb, color.a * a);
  return o;
}
@fragment fn fs(i: V) -> @location(0) vec4f {
  let s = textureSample(glyphTex, samp, i.uv).r;
  let w = max(fwidth(s), 0.0001) * 0.75;
  let a = smoothstep(0.75 - w, 0.75 + w, s) * i.color.a;
  return vec4f(i.color.rgb * a, a);
}
`;

function drawFaces() {
  const canvas = new OffscreenCanvas(512, 512);
  const c = canvas.getContext("2d");
  for (let i = 0; i < 64; i++) {
    const x = (i % 8) * 64;
    const y = Math.floor(i / 8) * 64;
    const hue = (i * 47) % 360;
    const g = c.createLinearGradient(x, y, x + 64, y + 64);
    g.addColorStop(0, `hsl(${hue} 45% 36%)`);
    g.addColorStop(1, `hsl(${(hue + 40) % 360} 50% 20%)`);
    c.fillStyle = g;
    c.fillRect(x, y, 64, 64);
    c.fillStyle = `hsl(${hue} 30% 80%)`;
    c.beginPath();
    c.arc(x + 32, y + 26, 11, 0, 6.2832);
    c.fill();
    c.beginPath();
    c.ellipse(x + 32, y + 62, 20, 17, 0, 0, 6.2832);
    c.fill();
  }
  return canvas;
}

const median = (list) => {
  if (!list.length) return 0;
  const sorted = Float64Array.from(list).sort();
  return sorted[sorted.length >> 1];
};

export async function createEngine({ canvas, width, height, dpr, board, atlas, onStats, onError }) {
  if (!navigator.gpu) throw new Error("WebGPU is not available here");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  const timed = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({ requiredFeatures: timed ? ["timestamp-query"] : [] });
  device.addEventListener("uncapturederror", (e) => onError(e.error.message));
  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });
  const view = { width, height, dpr };
  const sizeCanvas = () => {
    canvas.width = Math.max(1, Math.round(view.width * view.dpr));
    canvas.height = Math.max(1, Math.round(view.height * view.dpr));
  };
  sizeCanvas();

  const vertexBuffer = (data) => {
    const buffer = device.createBuffer({ size: Math.max(4, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    if (data.byteLength) device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const rectBuf = vertexBuffer(board.rectBuf);
  const markBuf = vertexBuffer(board.markBuf);
  const wireBuf = vertexBuffer(board.wireBuf);
  const glyphBuf = vertexBuffer(board.glyphBuf);
  const mark8 = new Uint8Array(board.markBuf);
  const markF = new Float32Array(board.markBuf);
  const wire8 = new Uint8Array(board.wireBuf);
  const wireF = new Float32Array(board.wireBuf);
  const glyph8 = new Uint8Array(board.glyphBuf);

  const glyphTex = device.createTexture({ size: [atlas.width, atlas.height], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: glyphTex }, atlas.data, { bytesPerRow: atlas.width }, [atlas.width, atlas.height]);
  const faceTex = device.createTexture({
    size: [512, 512],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: drawFaces() }, { texture: faceTex }, [512, 512]);
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

  const uni = new Float32Array(12);
  const ubuf = device.createBuffer({ size: uni.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    ],
  });
  const bind = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: ubuf } },
      { binding: 1, resource: sampler },
      { binding: 2, resource: glyphTex.createView() },
      { binding: 3, resource: faceTex.createView() },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const blend = {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  };
  const pipeline = async (name, code, arrayStride, attributes) => {
    const module = device.createShaderModule({ code: PRELUDE + code });
    const info = await module.getCompilationInfo();
    for (const m of info.messages) if (m.type === "error") onError(`${name} shader ${m.lineNum}:${m.linePos} ${m.message}`);
    return device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: "vs", buffers: [{ arrayStride, stepMode: "instance", attributes }] },
      fragment: { module, entryPoint: "fs", targets: [{ format, blend }] },
      primitive: { topology: "triangle-strip" },
    });
  };
  const at = (shaderLocation, offset, fmt) => ({ shaderLocation, offset, format: fmt });
  const rectPipe = await pipeline("rect", RECT, RECT_STRIDE, [at(0, 0, "float32x4"), at(1, 16, "unorm8x4"), at(2, 20, "unorm8x4"), at(3, 24, "float32x4")]);
  const wirePipe = await pipeline("wire", WIRE, WIRE_STRIDE, [at(0, 0, "float32x4"), at(1, 16, "float32x4"), at(2, 32, "unorm8x4"), at(3, 36, "float32x4")]);
  const markPipe = await pipeline("mark", MARK, MARK_STRIDE, [at(0, 0, "float32x4"), at(1, 16, "float32x4"), at(2, 32, "unorm8x4")]);
  const textPipe = await pipeline("text", TEXT, GLYPH_STRIDE, [at(0, 0, "float32x4"), at(1, 16, "unorm16x4"), at(2, 24, "unorm8x4"), at(3, 28, "uint8x4")]);

  const querySet = timed ? device.createQuerySet({ type: "timestamp", count: 2 }) : null;
  const resolveBuf = timed ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const readbacks = timed ? [0, 1, 2, 3].map(() => device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })) : [];

  // Camera: world position of the top-left corner, and zoom.
  const fit = Math.min(view.width / board.bounds.width, view.height / board.bounds.height) * 0.95;
  const cam = { x: 0, y: 0, z: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, fit)) };
  cam.x = board.bounds.width / 2 - view.width / 2 / cam.z;
  cam.y = board.bounds.height / 2 - view.height / 2 / cam.z;
  let hover = -1;

  const inputs = [];
  const batches = [];
  const applyInput = (m) => {
    if (m.type === "wheel") {
      if (m.ctrl) {
        const wx = cam.x + m.x / cam.z;
        const wy = cam.y + m.y / cam.z;
        const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.z * 2 ** (-m.dy * 0.02)));
        if (z === cam.z) return false;
        cam.z = z;
        cam.x = wx - m.x / z;
        cam.y = wy - m.y / z;
        return true;
      }
      cam.x += (m.dx * 1.2) / cam.z;
      cam.y += (m.dy * 1.2) / cam.z;
      return m.dx !== 0 || m.dy !== 0;
    }
    cam.x -= m.dx / cam.z;
    cam.y -= m.dy / cam.z;
    return m.dx !== 0 || m.dy !== 0;
  };

  const applyReports = (batch, time) => {
    for (let i = 0; i < batch.length; i += 4) {
      const s = batch[i] % board.seatCount;
      const mo = s * 9;
      markF[mo + 4] = batch[i + 1];
      markF[mo + 5] = time;
      device.queue.writeBuffer(markBuf, s * MARK_STRIDE + 16, mark8, s * MARK_STRIDE + 16, 8);
      const slot = board.seatLine[s];
      layoutRun(board.glyph, slot, LINE_CAP, PHRASES[batch[i + 2] % PHRASES.length], board.seatLineX[s], board.seatLineY[s], LINE_SIZE, LINE_COLOR, 2, atlas);
      device.queue.writeBuffer(glyphBuf, slot * GLYPH_STRIDE, glyph8, slot * GLYPH_STRIDE, LINE_CAP * GLYPH_STRIDE);
      const wires = board.seatWireCount[s];
      if (batch[i + 3] && wires) {
        const w = board.seatWires[board.seatWireStart[s] + (batch[i + 2] % wires)];
        wireF[w * 13 + 9] = time;
        device.queue.writeBuffer(wireBuf, w * WIRE_STRIDE + 36, wire8, w * WIRE_STRIDE + 36, 4);
      }
    }
  };

  // Frame log: when each frame started, whether the camera moved in it, what
  // it cost in script and on the GPU, and how old the oldest input in it was.
  const fT = new Float64Array(LOG_CAP);
  const fCpu = new Float32Array(LOG_CAP);
  const fGpu = new Float32Array(LOG_CAP).fill(-1);
  const fLat = new Float32Array(LOG_CAP).fill(-1);
  const fZoom = new Float32Array(LOG_CAP);
  const fMoved = new Uint8Array(LOG_CAP);
  const fReports = new Uint16Array(LOG_CAP);
  let frames = 0;
  let statAt = performance.now();
  let statFrom = 0;
  const started = performance.now();
  const raf = (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 8));

  const frame = () => {
    raf(frame);
    const t0 = performance.now();
    const time = (t0 - started) / 1000;
    const id = frames < LOG_CAP ? frames : LOG_CAP - 1;
    let moved = false;
    if (inputs.length) {
      fLat[id] = performance.timeOrigin + t0 - inputs[0].t;
      for (const m of inputs) moved = applyInput(m) || moved;
      inputs.length = 0;
    }
    let reports = 0;
    for (const batch of batches) {
      applyReports(batch, time);
      reports += batch.length / 4;
    }
    batches.length = 0;

    uni[0] = cam.x;
    uni[1] = cam.y;
    uni[2] = cam.z;
    uni[3] = time;
    uni[4] = view.width;
    uni[5] = view.height;
    uni[6] = view.dpr;
    uni[8] = hover;
    device.queue.writeBuffer(ubuf, 0, uni);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0.051, g: 0.055, b: 0.067, a: 1 }, loadOp: "clear", storeOp: "store" }],
      ...(timed ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    });
    pass.setBindGroup(0, bind);
    pass.setPipeline(rectPipe);
    pass.setVertexBuffer(0, rectBuf);
    pass.draw(4, board.regionCount, 0, 0);
    if (cam.z > 0.168 && board.wireCount) {
      pass.setPipeline(wirePipe);
      pass.setVertexBuffer(0, wireBuf);
      pass.draw((SEG + 1) * 2, board.wireCount);
    }
    if (cam.z > 0.298 && board.rectCount > board.regionCount) {
      pass.setPipeline(rectPipe);
      pass.setVertexBuffer(0, rectBuf);
      pass.draw(4, board.rectCount - board.regionCount, 0, board.regionCount);
    }
    pass.setPipeline(markPipe);
    pass.setVertexBuffer(0, markBuf);
    pass.draw(4, board.seatCount);
    pass.setPipeline(textPipe);
    pass.setVertexBuffer(0, glyphBuf);
    if (cam.z > 0.298) {
      const cols = board.gridCols;
      const cx0 = Math.min(cols - 1, Math.max(0, Math.floor(cam.x / CELL) - 1));
      const cx1 = Math.min(cols - 1, Math.max(0, Math.floor((cam.x + view.width / cam.z) / CELL)));
      const cy0 = Math.min(board.gridRows - 1, Math.max(0, Math.floor(cam.y / CELL) - 1));
      const cy1 = Math.min(board.gridRows - 1, Math.max(0, Math.floor((cam.y + view.height / cam.z) / CELL)));
      for (let cy = cy0; cy <= cy1; cy++) {
        const from = board.cellStart[cy * cols + cx0];
        const to = board.cellStart[cy * cols + cx1 + 1];
        if (to > from) pass.draw(4, to - from, 0, from);
      }
    }
    if (cam.z < 0.385 && board.glanceCount) pass.draw(4, board.glanceCount, 0, board.glanceStart);
    pass.end();
    const readback = timed ? readbacks.pop() : undefined;
    if (timed) {
      encoder.resolveQuerySet(querySet, 0, 2, resolveBuf, 0);
      if (readback) encoder.copyBufferToBuffer(resolveBuf, 0, readback, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
    if (readback) {
      readback.mapAsync(GPUMapMode.READ).then(
        () => {
          const ns = new BigInt64Array(readback.getMappedRange());
          fGpu[id] = Number(ns[1] - ns[0]) / 1e6;
          readback.unmap();
          readbacks.push(readback);
        },
        () => readbacks.push(readback),
      );
    }

    const t1 = performance.now();
    fT[id] = performance.timeOrigin + t0;
    fCpu[id] = t1 - t0;
    fZoom[id] = cam.z;
    fMoved[id] = moved ? 1 : 0;
    fReports[id] = Math.min(65535, reports);
    frames++;
    if (t1 - statAt >= 1000) {
      const to = Math.min(frames, LOG_CAP);
      onStats({
        fps: ((to - statFrom) * 1000) / (t1 - statAt),
        cpu: median(fCpu.subarray(statFrom, to)),
        gpu: median(Array.from(fGpu.subarray(statFrom, to)).filter((v) => v >= 0)),
        zoom: cam.z,
      });
      statAt = t1;
      statFrom = to;
    }
  };
  raf(frame);

  const info = {
    nodes: board.nodeCount,
    seats: board.seatCount,
    wires: board.wireCount,
    glyphs: board.glyphCount,
    gpuTimer: timed,
    adapter: adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.device}`.trim() : "",
    format,
    pixels: [canvas.width, canvas.height],
    bufferBytes: board.rectBuf.byteLength + board.markBuf.byteLength + board.wireBuf.byteLength + board.glyphBuf.byteLength,
  };

  return {
    info,
    input: (m) => {
      inputs.push(m);
    },
    pointer: (m) => {
      hover = board.seatAt(cam.x + m.x / cam.z, cam.y + m.y / cam.z);
    },
    reports: (batch) => {
      batches.push(batch);
    },
    resize: (w, h, r) => {
      view.width = w;
      view.height = h;
      view.dpr = r;
      sizeCanvas();
    },
    collect: () => {
      const n = Math.min(frames, LOG_CAP);
      return {
        n,
        info: { ...info, pixels: [canvas.width, canvas.height] },
        t: Array.from(fT.subarray(0, n)),
        cpu: Array.from(fCpu.subarray(0, n)),
        gpu: Array.from(fGpu.subarray(0, n)),
        lat: Array.from(fLat.subarray(0, n)),
        zoom: Array.from(fZoom.subarray(0, n)),
        moved: Array.from(fMoved.subarray(0, n)),
        reports: Array.from(fReports.subarray(0, n)),
      };
    },
  };
}
