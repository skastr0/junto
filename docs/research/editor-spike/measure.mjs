// Drives one editor in Electron 43 (the app's Chromium) and prints JSON:
// open time cold and warm, per-key latency, undo, find, heap and DOM size,
// and screenshots. Usage: node measure.mjs <editor> <theme> <port>
import { _electron } from "/Users/guilhermecastro/Projects/junto/node_modules/playwright-core/index.mjs";

const [editor, theme, port] = process.argv.slice(2);
const ELECTRON = "/Users/guilhermecastro/Projects/junto/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
const app = await _electron.launch({
  executablePath: ELECTRON,
  args: ["electron-main.cjs"],
  env: { ...process.env, SPIKE_URL: `http://localhost:${port}/?editor=${editor}&theme=${theme}` },
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.waitForFunction(() => window.spike?.ready !== undefined, null, { timeout: 60_000 });
const out = { editor, theme };
Object.assign(out, await page.evaluate(() => ({
  openColdMs: Math.round(window.spike.ready),
  firstTextColdMs: Math.round(window.spike.firstText ?? -1),
  longTasksToReadyMs: Math.round(window.spike.longTasksToReady),
})));
await page.screenshot({ path: `shots/${editor}-${theme}-open.png` });

const warm = [];
for (let i = 0; i < 3; i += 1) warm.push(Math.round(await page.evaluate(() => window.spike.reopen())));
out.openWarmMs = warm;
out.domNodes = await page.evaluate(() => {
  const host = window.spike.mounted.host();
  return host.querySelectorAll("*").length;
});

// Per-key latency: keydown to the frame after the DOM changed for it.
await page.evaluate(() => {
  window.lat = [];
  window.events = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name === "keydown") window.events.push(Math.round(e.duration));
  }).observe({ type: "event", durationThreshold: 16 });
  const host = window.spike.mounted.host();
  let pending;
  new MutationObserver(() => {
    if (pending === undefined) return;
    const t0 = pending;
    pending = undefined;
    requestAnimationFrame(() => setTimeout(() => window.lat.push(performance.now() - t0), 0));
  }).observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
  window.addEventListener("keydown", (e) => { pending = e.timeStamp; }, true);
});
await page.evaluate(() => window.spike.mounted.focusLineEnd(2500));
await page.waitForTimeout(500);
out.caretLineBeforeTyping = await page.evaluate(() => window.spike.mounted.caretLine());
const typed = "const spikeValue = compute(alpha, beta);";
await page.keyboard.press("Enter");
for (const ch of typed) {
  await page.keyboard.type(ch);
  await page.waitForTimeout(60);
}
await page.waitForTimeout(400);
const lat = await page.evaluate(() => window.lat.slice());
const sorted = [...lat].sort((a, b) => a - b);
const pct = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10;
out.typing = { keys: typed.length + 1, measured: lat.length, p50Ms: pct(0.5), p95Ms: pct(0.95), maxMs: pct(1), keydownToPresentedFrame: await page.evaluate(() => { const e = window.events.slice().sort((a, b) => a - b); return { n: e.length, p50Ms: e[Math.floor(e.length / 2)], maxMs: e[e.length - 1] }; }) };
const afterTyping = await page.evaluate(() => window.spike.mounted.getText());
out.typedLandedOnLine = afterTyping.split("\n").findIndex((l) => l.includes(typed)) + 1;
await page.screenshot({ path: `shots/${editor}-${theme}-typed.png` });

// Undo back to the original, then redo once.
let presses = 0;
const undoStart = Date.now();
for (; presses < 200; presses += 1) {
  if (await page.evaluate(() => window.spike.mounted.getText() === window.spike.fixture)) break;
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(30);
}
const restoredText = await page.evaluate(() => window.spike.mounted.getText());
out.undo = { presses, originalRestoredExactly: await page.evaluate(() => window.spike.mounted.getText() === window.spike.fixture), wallMs: Date.now() - undoStart };
await page.keyboard.press("Meta+Shift+z");
await page.waitForTimeout(200);
out.undo.redoChangesText = await page.evaluate(() => window.spike.mounted.getText() !== window.spike.fixture);

// Find: Cmd+F, a query with several matches, Enter twice.
const query = "Effect.gen";
out.find = { query };
await page.evaluate(() => window.spike.mounted.focusLineEnd(1));
await page.keyboard.press("Meta+f");
await page.waitForTimeout(300);
await page.keyboard.type(query);
await page.waitForTimeout(300);
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const first = await page.evaluate(() => window.spike.mounted.caretLine());
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const second = await page.evaluate(() => window.spike.mounted.caretLine());
const expected = afterTyping === "" ? [] : restoredText.split("\n").flatMap((l, i) => (l.includes(query) ? [i + 1] : []));
out.find.matchLines = expected.slice(0, 4);
out.find.caretAfterEnter = [first, second];
await page.screenshot({ path: `shots/${editor}-${theme}-find.png` });

out.heapMb = await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1e6));
out.errors = errors;
console.log(JSON.stringify(out));
await app.close();
