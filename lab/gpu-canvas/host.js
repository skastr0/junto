// The host page stands in for the app's window: it owns the chrome (the HUD),
// feeds seat reports to the canvas, and can burn its own main thread the way
// a working fleet does today. The canvas runs in one of four places:
//   main    this page's main thread
//   worker  a worker drawing to an OffscreenCanvas; input still arrives here
//   frame   a frame from another site, so its own process; input goes there
//   view    a second view in the window: its own process and its own input target

import { bindInput } from "./input.js";

const query = new URLSearchParams(location.search);
const mode = query.get("mode") ?? "frame";
const scale = Number(query.get("scale") ?? 1);
const load = query.get("load") ?? "none";
const rate = Number(query.get("rate") ?? 30);
const overlay = query.get("overlay") === "1";
const pump = query.get("pump") === "1";
const soft = query.get("soft") === "1";
const stage = document.getElementById("stage");
const hud = document.getElementById("hud");

let send = () => {};
let info = null;
let nextId = 1;
const pending = new Map();
const errors = [];
const ask = (type) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ type, id });
  });

const head = () =>
  `${mode}  ${info ? `${info.nodes} nodes, ${info.wires} wires, ${info.glyphs} glyph slots` : "loading"}  fleet ${rate}/s  load ${load}`;

function onEngine(m) {
  if (m.type === "ready") {
    info = m.info;
    hud.textContent = head();
    startFleet(info.seats);
    window.__ready = true;
  } else if (m.type === "stats") {
    hud.textContent = `${m.fps.toFixed(0)} fps   script ${m.cpu.toFixed(2)} ms   gpu ${m.gpu.toFixed(2)} ms   zoom ${m.zoom.toFixed(2)}   |   ${head()}`;
  } else if (m.type === "reply") {
    pending.get(m.id)?.(m.data);
    pending.delete(m.id);
  } else if (m.type === "error") {
    errors.push(m.message);
    console.error(`engine: ${m.message}`);
    hud.textContent = `error: ${m.message}`;
  }
}

function startFleet(seats) {
  if (!(rate > 0)) return;
  let carry = 0;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    carry += ((now - last) / 1000) * rate;
    last = now;
    const n = Math.floor(carry);
    carry -= n;
    if (!n) return;
    const batch = new Int32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const roll = Math.random();
      batch[i * 4] = Math.floor(Math.random() * seats);
      batch[i * 4 + 1] = roll < 0.62 ? 1 : roll < 0.72 ? 2 : roll < 0.86 ? 3 : 0;
      batch[i * 4 + 2] = Math.floor(Math.random() * 1e6);
      batch[i * 4 + 3] = roll < 0.5 ? 1 : 0;
    }
    send({ type: "reports", batch });
  }, 25);
}

// Main thread load shaped like the installed app's renderer under 30 agents:
// "fleet" keeps the thread about 47% busy with a 280 ms task every 4 s,
// "storm" about 80% busy with a 440 ms task (trace of 2026-11-09 22:17Z).
function burn(ms) {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) x += Math.sqrt(x + 1);
  return x;
}
function startLoad() {
  if (load === "none") return;
  const duty = load === "storm" ? 0.8 : 0.47;
  setInterval(() => burn(16 * duty * (0.5 + Math.random())), 16);
  setInterval(() => burn(load === "storm" ? 440 : 280), 4000);
}

const size = () => ({ width: stage.clientWidth, height: stage.clientHeight, dpr: devicePixelRatio });

async function start() {
  if (mode === "view") {
    // The canvas is another view in this window; its port arrives from the
    // main process. Messages wait until it does.
    const waiting = [];
    send = (message) => waiting.push(message);
    addEventListener("message", (event) => {
      if (event.data !== "lab-port" || !event.ports[0]) return;
      const port = event.ports[0];
      port.onmessage = (e) => onEngine(e.data);
      send = (message) => port.postMessage(message);
      for (const message of waiting) send(message);
    });
  } else if (mode === "frame") {
    const frame = document.createElement("iframe");
    frame.src = `lab://canvas/frame.html?scale=${scale}&soft=${soft ? 1 : 0}`;
    stage.append(frame);
    addEventListener("message", (event) => {
      if (event.source === frame.contentWindow) onEngine(event.data);
    });
    send = (message) => frame.contentWindow.postMessage(message, "*");
  } else {
    const canvas = document.createElement("canvas");
    stage.append(canvas);
    if (mode === "worker") {
      const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (event) => onEngine(event.data);
      worker.onerror = (event) => onEngine({ type: "error", message: event.message });
      send = (message, transfer) => worker.postMessage(message, transfer ?? []);
      const offscreen = canvas.transferControlToOffscreen();
      send({ type: "init", canvas: offscreen, scale, soft, ...size() }, [offscreen]);
    } else {
      const { serveEngine } = await import("./port.js");
      const handle = serveEngine(onEngine);
      send = handle;
      send({ type: "init", canvas, scale, soft, ...size() });
    }
    bindInput(canvas, (message) => send(message));
    addEventListener("resize", () => send({ type: "resize", ...size() }));
  }
  if (overlay) {
    // A piece of page chrome over the canvas, to measure what overlap costs.
    const box = document.createElement("div");
    box.id = "overlay";
    document.body.append(box);
  }
  if (pump) {
    // Chromium hands wheel events to a page once per main frame; an empty
    // frame loop keeps main frames coming when the page draws nothing itself.
    const turn = () => requestAnimationFrame(turn);
    turn();
  }
  startLoad();
}

window.__collect = async () => ({ ...(await ask("collect")), errors });
start().catch((error) => onEngine({ type: "error", message: String(error?.stack ?? error) }));
