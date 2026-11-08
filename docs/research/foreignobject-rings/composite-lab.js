// Does Chromium composite a transform animation inside SVG foreignObject?
const { app, BrowserWindow, contentTracing } = require("electron");
const fs = require("fs");
const path = require("path");

const part = `<div class="part"></div>`;
const style = `<style>
html,body{margin:0;background:#111}
.part{width:40px;height:40px;border:4px solid #0ff;border-top-color:transparent;border-radius:50%;animation:spin 1.44s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>`;
const CASES = {
  html: `${style}<div style="position:absolute;left:100px;top:100px">${part}</div>`,
  htmlOffscreen: `${style}<div style="position:absolute;left:-1000px;top:100px">${part}</div>`,
  foreignObject: `${style}<svg width="400" height="300"><foreignObject x="100" y="100" width="60" height="60">${part}</foreignObject></svg>`,
  foreignObjectGroup: `${style}<svg width="400" height="300"><g transform="translate(20 20) scale(1.5)"><foreignObject x="50" y="50" width="60" height="60">${part}</foreignObject></g></svg>`,
  foreignObjectClipped: `${style}<svg width="400" height="300"><foreignObject x="2000" y="100" width="60" height="60">${part}</foreignObject></svg>`,
};

const run = async (name, html) => {
  const win = new BrowserWindow({ width: 800, height: 600, show: true, webPreferences: { backgroundThrottling: false } });
  const page = path.join(__dirname, `${name}.html`);
  fs.writeFileSync(page, `<!doctype html><meta charset=utf-8>${html}`);
  await win.loadFile(page);
  await new Promise((r) => setTimeout(r, 500));
  await contentTracing.startRecording({ included_categories: ["blink.animations", "devtools.timeline", "benchmark", "rail", "cc", "disabled-by-default-devtools.timeline"] });
  // Restart the animation inside the trace so its start (and compositing verdict) is recorded.
  await win.webContents.executeJavaScript(`document.querySelectorAll('.part').forEach(e=>{e.style.animation='none';e.offsetWidth;e.style.animation=''});`);
  await new Promise((r) => setTimeout(r, 1500));
  const file = await contentTracing.stopRecording(path.join(__dirname, `${name}.json`));
  win.destroy();
  const trace = JSON.parse(fs.readFileSync(file, "utf8"));
  const events = (trace.traceEvents || trace).filter((e) => e.name === "Animation");
  const data = events.map((e) => e.args && e.args.data).filter((d) => d && Object.keys(d).length);
  const updates = (trace.traceEvents || trace).filter((e) => e.name === "UpdateLayoutTree" || e.name === "Layerize" || e.name === "PaintArtifactCompositor::Update").length;
  console.log(JSON.stringify({ name, animationEvents: events.length, data, mainThreadUpdates: updates }));
};

app.whenReady().then(async () => {
  for (const [name, html] of Object.entries(CASES).filter(([n]) => n === process.env.CASE)) { try { await run(name, html); } catch (e) { console.log(JSON.stringify({ name, error: String(e).slice(0, 200) })); } }
  app.quit();
});
