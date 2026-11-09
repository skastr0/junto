// GPU canvas lab: a WebGPU canvas of the factory board's shape, with a driver
// that replays one gesture script through Chromium's real input path and
// writes what every frame cost. See README.md.

const { app, BrowserWindow, protocol, net, contentTracing } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { build } = require("./gesture.cjs");
const { summarize } = require("./summarize.cjs");

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

const flag = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const opts = {
  mode: flag("mode", "frame"),
  scale: Number(flag("scale", "1")),
  load: flag("load", "none"),
  rate: Number(flag("rate", "30")),
  drive: flag("drive", "0") !== "0",
  out: flag("out", ""),
  tracefile: flag("tracefile", ""),
  show: flag("show", "1") !== "0",
  overlay: flag("overlay", "0") !== "0",
  pump: flag("pump", "0") !== "0",
  size: flag("size", "1320x900").split("x").map(Number),
  hz: Number(flag("hz", "120")),
  board: path.resolve(flag("board", path.join(__dirname, "../../e2e/scenarios/zz-idle-probe.factory.json"))),
};

// The installed app's trace categories without the sampling profiler, which
// costs frames of its own. The product arm records the same list.
const TRACE_CATEGORIES = [
  "toplevel",
  "blink",
  "cc",
  "viz",
  "gpu",
  "input",
  "benchmark",
  "latencyInfo",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
];

// A board of the factory fixture's shape, for a checkout without the fixture:
// 112 regions two deep, about 250 seats, 74 notes, about 930 wires.
function synthBoard() {
  const nodes = [];
  const wires = [];
  const quota = [3, 3, 2, 3, 2, 3, 3, 2];
  let seat = 0;
  let note = 0;
  let sub = 0;
  for (let r = 0; r < 16; r++) {
    const rx = (r % 4) * 3200;
    const ry = Math.floor(r / 4) * 3100;
    nodes.push({ kind: "region", id: `region-${r}`, x: rx, y: ry, width: 3000, height: 2900, z: 0, label: `Region ${r + 1}` });
    for (let s = 0; s < 6; s++, sub++) {
      const sx = rx + 80 + (s % 3) * 960;
      const sy = ry + 120 + Math.floor(s / 3) * 1380;
      nodes.push({ kind: "region", id: `region-${r}-${s}`, x: sx, y: sy, width: 900, height: 1300, z: 10, label: `Team ${r + 1}.${s + 1}` });
      for (let k = 0; k < quota[sub % quota.length]; k++, seat++) {
        nodes.push({
          kind: "agent",
          id: `seat-${seat}`,
          x: sx + 60 + (k % 2) * 420,
          y: sy + 120 + Math.floor(k / 2) * 420 + (k % 2) * 160,
          width: 216,
          height: 56,
          z: 200,
          label: `seat ${seat + 1}`,
          harness: ["claude", "codex", "opencode", "pi"][seat % 4],
        });
      }
      if (sub % 4 !== 3 && note < 74) {
        nodes.push({ kind: "note", id: `note-${note++}`, x: sx + 60, y: sy + 1040, width: 240, height: 100, z: 3, text: "Open questions for the review on Thursday" });
      }
    }
  }
  for (let i = 0; i < seat; i++) {
    for (const hop of i % 3 ? [1, 5, 17, 61] : [1, 5, 17]) wires.push({ id: `wire-${wires.length}`, from: `seat-${i}`, to: `seat-${(i + hop) % seat}` });
  }
  return { nodes, wires };
}

protocol.registerSchemesAsPrivileged([{ scheme: "lab", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.commandLine.appendSwitch("disable-renderer-accessibility");
app.setName("gpu-canvas-lab");
app.setPath("userData", path.join(os.tmpdir(), "gpu-canvas-lab"));
if (!opts.show) app.dock?.hide();

const BAR = 26; // the height of the page's top bar; the canvas is below it
const epoch = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  protocol.handle("lab", (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/board.json") {
      const body = fs.existsSync(opts.board) ? fs.readFileSync(opts.board) : Buffer.from(JSON.stringify({ model: synthBoard() }));
      return new Response(body, { headers: { "content-type": "application/json" } });
    }
    const file = path.normalize(path.join(__dirname, url.pathname));
    if (!file.startsWith(__dirname + path.sep)) return new Response("outside the lab folder", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const win = new BrowserWindow({
    width: opts.size[0],
    height: opts.size[1],
    useContentSize: true,
    show: false,
    backgroundColor: "#0d0e11",
    title: "GPU canvas lab",
    webPreferences: { backgroundThrottling: false },
  });
  const wc = win.webContents;
  wc.on("console-message", (event) => {
    if (event.level !== "info" || opts.drive) console.log(`[page] ${event.message}`);
  });
  if (opts.show) win.show();
  await win.loadURL(`lab://app/index.html?mode=${opts.mode}&scale=${opts.scale}&load=${opts.load}&rate=${opts.rate}&overlay=${opts.overlay ? 1 : 0}&pump=${opts.pump ? 1 : 0}`);
  if (!opts.drive) return;

  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) {
    await sleep(100);
    ready = await wc.executeJavaScript("window.__ready === true");
  }
  if (!ready) {
    console.log(JSON.stringify({ error: "the canvas did not start", log: await wc.executeJavaScript("window.__collect ? 'page up' : 'no page'") }));
    app.exit(1);
    return;
  }
  await sleep(1500);
  const frames = wc.mainFrame.framesInSubtree;
  const pids = { host: wc.mainFrame.osProcessId, canvas: frames.length > 1 ? frames[1].osProcessId : -1 };
  if (pids.canvas === pids.host) pids.canvas = -1;
  wc.debugger.attach("1.3");
  const [width, height] = win.getContentSize();
  const script = build(opts.hz);
  const samples = [];
  const sample = () => {
    samples.push({ t: epoch(), procs: app.getAppMetrics().map((p) => ({ type: p.type, pid: p.pid, cpuS: p.cpu.cumulativeCPUUsage ?? 0, mb: p.memory.workingSetSize / 1024 })) });
  };
  if (opts.tracefile) await contentTracing.startRecording({ included_categories: TRACE_CATEGORIES });
  const start = epoch();
  sample();
  await new Promise((resolve) => {
    let next = 0;
    const tick = () => {
      const t = epoch() - start;
      while (next < script.steps.length && script.steps[next].at <= t) {
        const step = script.steps[next++];
        wc.debugger
          .sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: BAR + (height - BAR) / 2, deltaX: step.dx, deltaY: step.dy, modifiers: step.ctrl ? 2 : 0 })
          .catch(() => {});
      }
      if (t >= script.end) resolve();
      else setTimeout(tick, 2);
    };
    tick();
  });
  sample();
  if (opts.tracefile) await contentTracing.stopRecording(opts.tracefile);
  const log = await wc.executeJavaScript("window.__collect()");
  const options = { arm: "gpu", mode: opts.mode, scale: opts.scale, load: opts.load, rate: opts.rate, overlay: opts.overlay, pump: opts.pump, hz: opts.hz, size: opts.size, shown: opts.show, separateProcess: pids.canvas !== -1 };
  const summary = summarize({ log, script, start, samples, pids, options });
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  app.exit(0);
});

app.on("window-all-closed", () => app.quit());
