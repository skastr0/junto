// Portrait gallery: renders generated agent portraits in both themes to a
// static page and screenshots it, so the art direction can be judged without
// booting the app. Output is disposable test output (never committed):
//   bun scripts/portrait-gallery.ts [count]
//   -> test-results/portraits/gallery.html, gallery-dark.png, gallery-bright.png
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { portraitDataUri, portraitOptions, portraitDetailFor, portraitGenome, type PortraitDetail } from "../src/shared/agent-portrait";
import { portraitFaceFor, portraitExpression, type ExpressionInput } from "../src/shared/portrait-expression";
import { installCosmeticPacks } from "../src/shared/cosmetics/catalog";
import { decodeCosmeticPacks } from "../src/shared/cosmetics/load";
import { FONT_MONO, themeRuntime, type ThemeMode } from "../src/shared/theme";

// One character across temperament x seat state, for judging expressions.
const MOOD_STATES: ReadonlyArray<readonly [string, Omit<ExpressionInput, "temperament">]> = [
  ["idle", { activity: "rest" }],
  ["working", { activity: "work" }],
  ["going well", { activity: "work", health: "going_well" }],
  ["exceeding", { activity: "work", health: "exceeding" }],
  ["done", { activity: "done" }],
  ["wants you", { activity: "call" }],
  ["blocked", { activity: "halt", signal: "blocked" }],
  ["stuck", { activity: "work", health: "stuck" }],
  ["thrashing", { activity: "work", health: "thrashing" }],
  ["confused", { activity: "work", health: "confused" }],
  ["gone", { activity: "off" }],
];
const MOOD_SEEDS = ["mood-critter-1", "mood-critter-7"];

// How often hundreds of seats repeat their salient look.
const variety = (() => {
  const count = 400;
  const looks = new Set(
    Array.from({ length: count }, (_, index) => {
      const g = portraitGenome(`variety-seat-${index}-${(index * 2654435761) >>> 0}`);
      return `${g.bodyHue}|${g.shape}|${g.topper}|${g.accessory}`;
    }),
  );
  return { count, distinct: looks.size };
})();

const count = Number(process.argv[2] ?? 48);

// Premium packs join like the app build: from the overlay JUNTO_OVERLAY names
// (the private checkout), decoded with the app's pack schema. Unset, the
// gallery shows what an open-source build carries: the base cast only.
const overlayDir = process.env.JUNTO_OVERLAY;
const premiumPacks = overlayDir
  ? decodeCosmeticPacks(
      ((await import(join(resolve(overlayDir), "overlay", "index.ts"))) as { overlay: { cosmetics: ReadonlyArray<unknown> } })
        .overlay.cosmetics,
    )
  : [];
installCosmeticPacks(premiumPacks);
const out = join(process.cwd(), "test-results", "portraits");
mkdirSync(out, { recursive: true });

// Stable UUID-shaped seeds, the same shape node ids have in the app.
const seeds = Array.from({ length: count }, (_, index) => {
  const hex = (n: number): string => (Math.imul(n + 1, 2654435761) >>> 0).toString(16).padStart(8, "0");
  return `${hex(index)}-${hex(index * 7).slice(0, 4)}-4${hex(index * 13).slice(0, 3)}-a${hex(index * 17).slice(0, 3)}-${hex(index * 19)}${hex(index * 23).slice(0, 4)}`;
});

const tiers: ReadonlyArray<readonly [PortraitDetail, number]> = [
  ["rich", 96],
  ["card", 48],
  ["glyph", 28],
  ["glyph", 18],
];

const page = (mode: ThemeMode): string => {
  const t = themeRuntime(mode);
  const cell = (seed: string, detail: PortraitDetail, size: number): string =>
    `<img width="${size}" height="${size}" src="${portraitDataUri({ seed, mode, detail })}" alt="" style="border-radius:${Math.round(size * 0.24)}px;box-shadow:0 0 0 1px ${t.stroke}">`;
  const grid = (detail: PortraitDetail, size: number): string =>
    `<h2>${detail} ${size}px</h2><div class="grid" style="grid-template-columns:repeat(12, ${Math.max(size, 28) + 24}px)">${seeds
      .map((seed) => {
        const g = portraitGenome(seed);
        return `<figure>${cell(seed, detail, size)}${size >= 96 ? `<figcaption>${g.bodyHue} ${g.shape}<br>${g.topper} ${g.eyes} ${g.mouth}</figcaption>` : ""}</figure>`;
      })
      .join("")}</div>`;
  const inContext = seeds
    .slice(0, 6)
    .map(
      (seed, index) =>
        `<div class="card"><img width="28" height="28" src="${portraitDataUri({ seed, mode, detail: "glyph" })}" style="border-radius:7px"><div><div class="name">${["planner", "reviewer", "builder-2", "scout", "docs", "overseer"][index]}</div><div class="sub">claude code, running</div></div></div>`,
    )
    .join("");
  // Round portraits inside stand-in rings: the seat draws the real, living
  // ring; these only judge readability of the porthole at seat sizes.
  const rings = [t.amber, t.cyan, t.green, t.violet, t.stroke, t.orange];
  const ringed = (size: number): string =>
    `<div class="seats">${seeds
      .slice(0, 12)
      .map((seed, index) => {
        const ring = rings[index % rings.length];
        const dashed = index % 3 === 1 ? "dashed" : "solid";
        return `<div class="seat"><span class="ring" style="border:2px ${dashed} ${ring};padding:2px"><img width="${size}" height="${size}" src="${portraitDataUri({ seed, mode, detail: portraitDetailFor(size), frame: "round" })}" style="border-radius:50%;display:block"></span>${size >= 36 ? `<div><div class="name">${["planner", "reviewer", "builder-2", "scout", "docs", "overseer"][index % 6]}</div><div class="sub">${["working", "waiting on you", "going well", "blocked", "done", "thrashing"][index % 6]}</div></div>` : ""}</div>`;
      })
      .join("")}</div>`;
  const moods = MOOD_SEEDS.map(
    (seed) => `<table class="moods"><tr><th></th>${MOOD_STATES.map(([label]) => `<th>${label}</th>`).join("")}</tr>${(
      [
        ["moody", -0.8],
        ["even", 0],
        ["cheerful", 0.8],
      ] as const
    )
      .map(
        ([label, temperament]) =>
          `<tr><th>${label}</th>${MOOD_STATES.map(([, state]) => {
            const input = { ...state, temperament };
            return `<td><img width="64" height="64" style="border-radius:50%" src="${portraitDataUri({ seed, mode, detail: "card", frame: "round", face: portraitFaceFor(input) })}"><div>${portraitExpression(input)}</div><img width="28" height="28" style="border-radius:50%;margin-top:4px" src="${portraitDataUri({ seed, mode, detail: "glyph", frame: "round", face: portraitFaceFor(input) })}"></td>`;
          }).join("")}</tr>`,
      )
      .join("")}</table>`,
  ).join("");
  // The second cast one trait at a time, on a fixed critter, so each new
  // species, topper, pattern, and prop can be judged on its own.
  const showcaseSeed = seeds[4] ?? "showcase";
  const showcase = (trait: "shape" | "topper" | "marking" | "accessory", options: ReadonlyArray<string>): string =>
    `<div class="grid" style="grid-template-columns:repeat(12, 96px)">${options
      .map(
        (option) =>
          `<figure><img width="80" height="80" style="border-radius:50%" src="${portraitDataUri({ seed: showcaseSeed, mode, detail: "rich", frame: "round", config: { accessory: "none", topper: "none", shape: "round", [trait]: option } })}"><figcaption>${option}</figcaption></figure>`,
      )
      .join("")}</div>`;
  const bareRow = `<div class="bare">${seeds
    .slice(0, 10)
    .map((seed) => `<img width="120" height="120" src="${portraitDataUri({ seed, mode, detail: "rich", frame: "bare" })}">`)
    .join("")}</div>`;
  // Base vs premium: each premium item on the same critters as the base row.
  const premiumSeeds = seeds.slice(0, 6);
  const premiumRow = (label: string, config: Record<string, string>): string =>
    `<div class="premium-row"><div class="premium-label">${label}</div>${premiumSeeds
      .map((seed) => `<img width="72" height="72" style="border-radius:50%" src="${portraitDataUri({ seed, mode, detail: "rich", frame: "round", config })}">`)
      .join("")}<img width="96" height="96" src="${portraitDataUri({ seed: premiumSeeds[0] ?? "p", mode, detail: "rich", frame: "bare", config })}"></div>`;
  const premium = premiumPacks.length
    ? premiumPacks
        .map(
          (pack) =>
            `<h2>premium pack: ${pack.name} (official build only)</h2>${premiumRow("base look", { accessory: "none" })}${(pack.accessories ?? [])
              .map((item) => premiumRow(item.name, { accessory: `${pack.id}:${item.id}` }))
              .join("")}${(pack.palettes ?? []).map((item) => premiumRow(`${item.name} color`, { bodyHue: `${pack.id}:${item.id}`, accessory: "none" })).join("")}`,
        )
        .join("")
    : `<h2>open-source build: base cast only (set JUNTO_OVERLAY to add premium packs)</h2>`;
  return `<section class="theme" style="background:${t.ground};color:${t.ink}">
<h1>Agent portraits, ${mode}</h1>
${premium}
<h2>new species</h2>${showcase("shape", portraitOptions().shape.slice(6))}
<h2>new ears and toppers</h2>${showcase("topper", portraitOptions().topper.slice(9))}
<h2>new patterns</h2>${showcase("marking", portraitOptions().marking.slice(5))}
<h2>hats and props</h2>${showcase("accessory", portraitOptions().accessory.slice(1))}
<h2>bare frame, transparent (brand, landing, video)</h2>${bareRow}
<h2>variety: ${variety.distinct} distinct looks (color, species, ears, prop) across ${variety.count} seats</h2>
<h2>expressions: temperament x seat state</h2>${moods}
<h2>round seat, 40px in a stand-in ring</h2>${ringed(40)}
<h2>round seat, 28px</h2>${ringed(28)}
<h2>round seat, 20px</h2>${ringed(20)}
<h2>on a node header</h2><div class="cards" style="--raise:${t.raise};--stroke:${t.stroke};--dim:${t.dim}">${inContext}</div>
${tiers.map(([detail, size]) => grid(detail, size)).join("")}
</section>`;
};

const html = (modes: ReadonlyArray<ThemeMode>): string => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:${FONT_MONO};font-size:11px}
.theme{padding:28px 32px 36px;width:max-content;min-width:100%;box-sizing:border-box}
h1{font-size:15px;margin:0 0 8px;letter-spacing:.04em}
h2{font-size:11px;font-weight:500;opacity:.6;margin:22px 0 10px;text-transform:uppercase;letter-spacing:.12em}
.grid{display:grid;gap:10px 6px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px}
figcaption{font-size:9px;opacity:.55;text-align:center;line-height:1.3}
.cards{display:flex;gap:12px;flex-wrap:wrap}
.card{display:flex;gap:10px;align-items:center;background:var(--raise);border:1px solid var(--stroke);border-radius:8px;padding:10px 14px;min-width:170px}
.seats{display:flex;gap:18px;flex-wrap:wrap;align-items:center}.seat{display:flex;gap:10px;align-items:center;min-width:150px}.ring{display:inline-block;border-radius:50%}
.moods{border-collapse:collapse;margin-bottom:18px}.moods th{font-weight:500;opacity:.6;font-size:10px;padding:4px 6px;text-align:center}.moods td{text-align:center;padding:4px 6px;font-size:9px;opacity:.9}.moods td div{opacity:.6}
.bare{display:flex;gap:10px;flex-wrap:wrap;padding:14px;border-radius:10px;background:repeating-conic-gradient(rgba(128,128,128,.18) 0 25%, transparent 0 50%) 0 0/16px 16px}
.premium-row{display:flex;gap:10px;align-items:center;margin:6px 0}.premium-label{width:130px;font-size:11px;opacity:.7}
.name{font-size:12px}.sub{color:var(--dim);font-size:10px;margin-top:2px}
</style></head><body>${modes.map(page).join("")}</body></html>`;

writeFileSync(join(out, "gallery.html"), html(["dark", "bright"]));

// System Chrome when present; the bundled headless shell otherwise.
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
try {
  const tab = await browser.newPage({ viewport: { width: 2000, height: 900 }, deviceScaleFactor: 2 });
  for (const mode of ["dark", "bright"] as const) {
    await tab.setContent(html([mode]));
    await tab.screenshot({ path: join(out, `gallery-${mode}.png`), fullPage: true });
  }
} finally {
  await browser.close();
}
console.log(`wrote ${out}/gallery.html, gallery-dark.png, gallery-bright.png`);
