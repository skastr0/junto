// CPU profile of one warm reopen; prints the top self-time functions.
import { _electron } from "/Users/guilhermecastro/Projects/junto/node_modules/playwright-core/index.mjs";
const [editor, port] = process.argv.slice(2);
const app = await _electron.launch({ executablePath: "/Users/guilhermecastro/Projects/junto/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", args: ["electron-main.cjs"], env: { ...process.env, SPIKE_URL: `http://localhost:${port}/?editor=${editor}&theme=dark` } });
const page = await app.firstWindow();
await page.waitForFunction(() => window.spike?.ready !== undefined, null, { timeout: 60_000 });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
const ms = await page.evaluate(() => window.spike.reopen());
const { profile } = await cdp.send("Profiler.stop");
const dt = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i]);
  const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`;
  dt.set(key, (dt.get(key) ?? 0) + profile.timeDeltas[i] / 1000);
}
console.log("reopen ms", Math.round(ms));
for (const [k, v] of [...dt].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(Math.round(v), k);
await app.close();
