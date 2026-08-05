/**
 * theme-sheet — visual theme harness.
 *
 * Generates test-results/theme-sheet.html (a self-contained specimen page that
 * links the built stylesheet from out/renderer/assets/) and screenshots it with
 * Playwright's chromium in both modes:
 *   test-results/theme-sheet-dark.png    (default)
 *   test-results/theme-sheet-bright.png  (html[data-theme="bright"])
 *
 * Run: bun run scripts/theme-sheet.ts
 *
 * The page uses real Tailwind utilities where the build emits them
 * (bg-ground/raise/raise-2/inset, text-ink/ink-2/dim/faint, border-stroke,
 * text-amber/amber-hi/cyan/crimson/violet/steel/indigo, font-mono/display)
 * and raw var(--color-*) elsewhere. A few @theme vars unused by the app are
 * tree-shaken out of the built CSS (main-hi, main-fg, second-fg, selection,
 * selection-inactive); the page re-declares those aliases exactly as
 * src/renderer/styles/theme.generated.css does.
 */
import { chromium } from "playwright";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

declare global {
  interface Window {
    __stamp: () => void;
    __selectDemo: () => void;
  }
}

const root = resolve(import.meta.dir, "..");
const assetsDir = resolve(root, "out/renderer/assets");
const cssFile = readdirSync(assetsDir).find((f) => /^index-.*\.css$/.test(f));
if (!cssFile) throw new Error(`no built index-*.css in ${assetsDir}`);
const cssHref = pathToFileURL(resolve(assetsDir, cssFile)).href;

const resultsDir = resolve(root, "test-results");
mkdirSync(resultsDir, { recursive: true });

const HUES = [
  "amber",
  "amber-hi",
  "amber-fg",
  "cyan",
  "cyan-fg",
  "crimson",
  "crimson-fg",
  "violet",
  "steel",
  "indigo",
  "gold",
  "orange",
  "green",
];

const ROLES = ["main", "main-hi", "main-fg", "second", "second-fg", "accent", "accent-fg"];

const swatch = (name: string) => `
  <div class="row">
    <span class="dot" style="background: var(--color-${name})"></span>
    <span class="lbl">${name}</span>
    <span class="sample" style="color: var(--color-${name})">Aa the quick brown fox 0123</span>
    <span class="val" data-var="--color-${name}"></span>
  </div>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>theme sheet</title>
<link rel="stylesheet" href="${cssHref}">
<style>
  /* Aliases tree-shaken from the app build; values mirror theme.generated.css. */
  :root {
    --color-main-hi: var(--color-amber-hi);
    --color-main-fg: var(--color-amber-fg);
    --color-second-fg: var(--color-cyan-fg);
    --color-selection: color-mix(in oklab, var(--color-main) 28%, transparent);
    --color-selection-inactive: color-mix(in oklab, var(--color-main) 16%, transparent);
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 28px; font-size: 11px; line-height: 1.45; }
  h1 { font-size: 15px; margin: 0 0 2px; letter-spacing: 0.04em; }
  h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; margin: 0 0 8px; }
  section { margin-bottom: 18px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 18px; }
  .panel { border-width: 1px; border-style: solid; border-radius: 6px; padding: 10px 12px; }
  .tag { font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; }
  .row { display: flex; align-items: baseline; gap: 8px; padding: 1px 0; }
  .dot { width: 10px; height: 10px; border-radius: 999px; flex: none; align-self: center;
         outline: 1px solid var(--color-stroke); }
  .lbl { width: 78px; flex: none; }
  .sample { flex: 1; white-space: nowrap; overflow: hidden; }
  .val { font-size: 9px; opacity: 0.85; white-space: nowrap; }
  .chip { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px;
          padding: 2px 10px; border-width: 1px; border-style: solid; margin: 0 6px 6px 0; }
  .hairline { height: 34px; display: flex; align-items: center; padding: 0 10px; border-radius: 4px; }
  .btn { display: inline-block; border: 1px solid var(--color-main);
         background: color-mix(in oklab, var(--color-main) 12%, transparent);
         color: var(--color-main-hi); border-radius: 6px; padding: 6px 16px;
         font: inherit; cursor: default; }
  .field { border: 1px solid var(--color-second); border-radius: 6px; padding: 6px 10px;
           box-shadow: 0 0 0 4px var(--color-focus-ring); }
  .sel p { margin: 0; }
  .sel ::selection { background: var(--color-selection); color: var(--color-ink); }
  .scrim-stage { position: relative; height: 150px; border-radius: 6px; overflow: hidden; }
  .scrim { position: absolute; inset: 0; background: var(--color-backdrop); }
  .scrim-card { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
                padding: 10px 16px; border-radius: 6px; }
  .shadow-card { height: 64px; border-radius: 6px; display: flex; align-items: center;
                 justify-content: center; }
  .mode-dark, .mode-bright { display: none; }
  html:not([data-theme="bright"]) .mode-dark { display: inline; }
  html[data-theme="bright"] .mode-bright { display: inline; }
</style>
</head>
<body class="bg-ground text-ink font-mono">

<header style="margin-bottom: 16px">
  <h1 class="font-display text-amber">VELLUM COMMAND — THEME SHEET
    <span class="mode-dark">/ dark</span><span class="mode-bright">/ bright</span></h1>
  <div class="text-faint" style="font-size: 9px">${cssFile}, tokens from src/shared/theme/ via theme.generated.css</div>
</header>

<div class="grid2">
  <section>
    <h2 class="text-dim">surface ladder</h2>
    <div class="panel border-stroke bg-ground"><span class="tag text-faint">ground</span>
      <div class="panel border-stroke bg-raise" style="margin-top:6px"><span class="tag text-faint">raise</span>
        <div class="panel border-stroke bg-raise-2" style="margin-top:6px"><span class="tag text-faint">raise-2</span>
          <div class="panel border-stroke bg-inset" style="margin-top:6px"><span class="tag text-faint">inset</span>
            <div class="panel border-stroke" style="margin-top:6px; background: var(--color-well)"><span class="tag text-faint">well</span></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section>
    <h2 class="text-dim">text ladder</h2>
    <div class="grid2" style="gap:10px">
      <div class="panel border-stroke bg-ground">
        <div class="tag text-faint" style="margin-bottom:6px">on ground</div>
        <div class="text-ink">ink — primary copy 0123</div>
        <div class="text-ink-2">ink-2 — secondary copy</div>
        <div class="text-dim">dim — metadata, captions</div>
        <div class="text-faint">faint — labels, hints</div>
      </div>
      <div class="panel border-stroke bg-raise">
        <div class="tag text-faint" style="margin-bottom:6px">on raise</div>
        <div class="text-ink">ink — primary copy 0123</div>
        <div class="text-ink-2">ink-2 — secondary copy</div>
        <div class="text-dim">dim — metadata, captions</div>
        <div class="text-faint">faint — labels, hints</div>
      </div>
    </div>
  </section>
</div>

<div class="grid2">
  <section>
    <h2 class="text-dim">hairline strokes</h2>
    <div class="hairline border-stroke bg-raise" style="margin-bottom:6px"><span class="text-dim">stroke — ink at 14%</span></div>
    <div class="hairline bg-raise" style="border: 1px solid var(--color-stroke-hi)"><span class="text-dim">stroke-hi — ink at 28%</span></div>
  </section>

  <section>
    <h2 class="text-dim">overlay chips (on raise)</h2>
    <div class="panel border-stroke bg-raise">
      ${[1, 2, 3, 4]
        .map(
          (n) => `
      <span class="chip" style="border-color: var(--color-stroke); background: var(--color-overlay-${n})">
        <span class="text-ink-2">overlay-${n}</span><span class="text-faint">${[3, 5, 7, 10][n - 1]}%</span>
      </span>`,
        )
        .join("")}
    </div>
  </section>
</div>

<section>
  <h2 class="text-dim">hues — dot, name, text sample, resolved value</h2>
  <div class="grid2" style="gap:2px 24px">
    ${HUES.map(swatch).join("")}
  </div>
</section>

<section>
  <h2 class="text-dim">role aliases</h2>
  <div class="grid2" style="gap:2px 24px">
    ${ROLES.map(swatch).join("")}
  </div>
</section>

<div class="grid3">
  <section>
    <h2 class="text-dim">primary action</h2>
    <div class="panel border-stroke bg-raise" style="text-align:center; padding: 18px">
      <span class="btn">Enqueue task</span>
      <div class="text-faint" style="margin-top:8px; font-size:9px">main border, main 12% tint, main-hi text</div>
    </div>
  </section>

  <section>
    <h2 class="text-dim">focus ring</h2>
    <div class="panel border-stroke bg-raise" style="padding: 18px">
      <div class="field text-ink-2">focused field</div>
      <div class="text-faint" style="margin-top:8px; font-size:9px">second border, focus-ring halo (second 10%)</div>
    </div>
  </section>

  <section>
    <h2 class="text-dim">selection</h2>
    <div class="panel border-stroke bg-raise sel" style="padding: 12px">
      <p id="sel-text" class="text-ink-2">Selected text rides var(--color-selection), main at 28% over the surface, ink glyphs on top.</p>
    </div>
  </section>
</div>

<div class="grid2">
  <section>
    <h2 class="text-dim">backdrop scrim</h2>
    <div class="scrim-stage panel border-stroke bg-raise-2">
      <div style="padding: 10px">
        <span class="chip border-stroke"><span class="dot" style="background: var(--color-crimson)"></span><span class="text-ink-2">blocked</span></span>
        <span class="chip border-stroke"><span class="dot" style="background: var(--color-cyan)"></span><span class="text-ink-2">working</span></span>
        <div class="text-dim" style="margin-top:6px">content under the scrim</div>
      </div>
      <div class="scrim"></div>
      <div class="scrim-card panel border-stroke bg-raise"><span class="text-ink">dialog over backdrop</span></div>
    </div>
  </section>

  <section>
    <h2 class="text-dim">shadows</h2>
    <div class="grid2" style="gap:14px">
      <div class="shadow-card bg-raise" style="box-shadow: 0 10px 28px var(--color-shadow-1)"><span class="text-dim">shadow-1</span></div>
      <div class="shadow-card bg-raise" style="box-shadow: 0 3px 10px var(--color-shadow-2)"><span class="text-dim">shadow-2</span></div>
    </div>
  </section>
</div>

<script>
  // Stamp each swatch with its resolved computed color (per active mode).
  window.__stamp = () => {
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    for (const el of document.querySelectorAll("[data-var]")) {
      probe.style.color = "var(" + el.dataset.var + ")";
      el.textContent = getComputedStyle(probe).color;
    }
    probe.remove();
  };
  window.__selectDemo = () => {
    const el = document.getElementById("sel-text");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
  window.__stamp();
  window.__selectDemo();
</script>
</body>
</html>
`;

const htmlPath = resolve(resultsDir, "theme-sheet.html");
writeFileSync(htmlPath, html);
console.log(`wrote ${htmlPath} (css: ${cssFile})`);

// No bundled chromium in this repo (e2e drives Electron); use installed Chrome.
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1600 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("[page]", msg.text());
});
await page.goto(pathToFileURL(htmlPath).href);
await page.waitForTimeout(250);

const overflow = await page.evaluate(() => document.documentElement.scrollHeight);
if (overflow > 1600) console.warn(`warning: content height ${overflow}px exceeds 1600px viewport`);

await page.screenshot({ path: resolve(resultsDir, "theme-sheet-dark.png") });
console.log("wrote test-results/theme-sheet-dark.png");

await page.evaluate(() => {
  document.documentElement.dataset.theme = "bright";
  window.__stamp();
  window.__selectDemo();
});
await page.waitForTimeout(150);
await page.screenshot({ path: resolve(resultsDir, "theme-sheet-bright.png") });
console.log("wrote test-results/theme-sheet-bright.png");

await browser.close();
