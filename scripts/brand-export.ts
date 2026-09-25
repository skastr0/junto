// Brand export: renders the character cast headlessly to SVG and PNG, and
// builds the brand surfaces (macOS icon, DMG background) from the mascot.
// Every critter comes from the app's own portrait renderer; this file only
// frames and rasterizes. Heavy runs go through the shared lock:
//   lockf -k /tmp/junto-heavy.lock bun scripts/brand-export.ts <command>
//
// Commands:
//   one --out file.svg|.png [--seed S] [--config JSON] [--expression E]
//       [--mode light|dark] [--frame tile|round] [--detail rich|card|glyph]
//       [--size N]                      one character; seed defaults to Pip
//   kit --out DIR [--png N]            mascot, expressions, cast, icons, manifest
//   icon [--root DIR]                  build/icon*.icns + assets/brand/junto-icon.png
//   dmg [--root DIR]                   build/dmg-background.png + @2x
//   board [--out file.png]             the mascot election board (docs/brand)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  portraitDataUri,
  portraitSvg,
  type PortraitConfig,
  type PortraitDetail,
  type PortraitFace,
  type PortraitFrame,
} from "../src/shared/agent-portrait";
import { BRAND_EXPRESSIONS, BRAND_FACES, JUNTO_MASCOT } from "../src/shared/brand-mascot";
import { EXPRESSION_FACES, PORTRAIT_EXPRESSIONS } from "../src/shared/portrait-expression";
import { FONT_DISPLAY, hexToOklch, oklchToHex, themeRuntime, type ThemeMode } from "../src/shared/theme";

const ROOT = join(import.meta.dir, "..");

// --- inputs -----------------------------------------------------------------

type Appearance = "light" | "dark";
const themeMode = (appearance: Appearance): ThemeMode => (appearance === "dark" ? "dark" : "bright");

const ALL_FACES: Readonly<Record<string, PortraitFace>> = { ...EXPRESSION_FACES, ...BRAND_FACES };

interface Character {
  readonly seed: string;
  readonly config?: PortraitConfig;
}
const PIP: Character = JUNTO_MASCOT;

const faceFor = (expression: string | undefined): PortraitFace | undefined => {
  if (expression === undefined || expression === "rest" || expression === "resting") return undefined;
  const face = ALL_FACES[expression];
  if (!face) throw new Error(`unknown expression "${expression}"; one of rest, ${Object.keys(ALL_FACES).join(", ")}`);
  return face;
};

const flags = (argv: ReadonlyArray<string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) throw new Error(`unexpected argument "${arg}"`);
    out[arg.slice(2)] = argv[index + 1] ?? "";
    index += 1;
  }
  return out;
};

// --- rasterizing ----------------------------------------------------------------

let browser: Browser | undefined;
let page: Page | undefined;

const tab = async (): Promise<Page> => {
  if (page) return page;
  browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  page = await browser.newPage();
  return page;
};

/** Rasterize an SVG document at an exact pixel size, keeping transparency. */
async function png(svg: string, width: number, height: number, path: string): Promise<void> {
  const p = await tab();
  await p.setViewportSize({ width, height });
  const sized = svg.replace(/^<svg /, `<svg width="${width}" height="${height}" `);
  await p.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
  await p.evaluate(() => document.fonts.ready);
  mkdirSync(dirname(path), { recursive: true });
  await p.screenshot({ path, omitBackground: true, clip: { x: 0, y: 0, width, height } });
}

const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

// --- framing ------------------------------------------------------------------

const f = (value: number): string => String(Math.round(value * 100) / 100);

/** A portrait placed as an isolated image, so ids never collide in a composition. */
const sticker = (
  who: Character,
  opts: { x: number; y: number; size: number; mode: ThemeMode; face?: PortraitFace; rotate?: number; frame?: PortraitFrame; detail?: PortraitDetail },
): string => {
  const href = portraitDataUri({ ...who, mode: opts.mode, detail: opts.detail ?? "rich", face: opts.face, frame: opts.frame });
  const c = opts.size / 2;
  const turn = opts.rotate ? ` transform="rotate(${f(opts.rotate)} ${f(opts.x + c)} ${f(opts.y + c)})"` : "";
  return `<image href="${href}" x="${f(opts.x)}" y="${f(opts.y)}" width="${f(opts.size)}" height="${f(opts.size)}"${turn}/>`;
};

// Apple's macOS icon grid: a 1024 canvas, an 824 body inset 100 on every side,
// continuous (squircle) corners, and a soft drop shadow below. The corner is a
// superellipse, not a circular arc, so the path is sampled rather than arced.
const squirclePath = (x: number, y: number, size: number): string => {
  const r = size / 2;
  const cx = x + r;
  const cy = y + r;
  const n = 5; // superellipse exponent close to Apple's continuous corner
  const points: string[] = [];
  for (let step = 0; step < 360; step += 1) {
    const t = (step / 360) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const px = cx + r * Math.sign(cos) * Math.abs(cos) ** (2 / n);
    const py = cy + r * Math.sign(sin) * Math.abs(sin) ** (2 / n);
    points.push(`${f(px)} ${f(py)}`);
  }
  return `M${points.join("L")}Z`;
};

/** A soft wash in the amber family, lightness normalized per appearance. */
const amberTone = (mode: ThemeMode, l: number, c: number, hueShift = 0): string => {
  const base = hexToOklch(themeRuntime(mode).amber ?? "#e8a33d");
  return oklchToHex({ l, c, h: base.h + hueShift });
};

/** The first solid fill a portrait paints: its tile, the ground the critter sits on. */
const tileFill = (who: Character, mode: ThemeMode): string =>
  /<rect [^>]*fill="(#[0-9a-f]{6})"/i.exec(portraitSvg({ ...who, mode, detail: "card" }))?.[1] ?? amberTone(mode, 0.905, 0.034);

/**
 * The app icon: Pip's own portrait, rising from the bottom of the Apple body
 * the way every portrait rises from its tile. The squircle is filled with the
 * portrait's tile color, so the portrait's own corners vanish into it and the
 * squircle is the only silhouette. A fine grain at icon scale stands in for
 * the portrait's `rich` grain, which is tuned for 100px, not 1024. Small sizes
 * switch to the renderer's coarser tiers, tuned for legibility.
 */
function iconSvg(appearance: Appearance, pixels = 1024, face?: PortraitFace): string {
  const mode = themeMode(appearance);
  const dark = appearance === "dark";
  const detail: PortraitDetail = pixels >= 32 ? "card" : "glyph";
  const body = squirclePath(100, 100, 824);
  const size = detail === "glyph" ? 824 : 792;
  const rim = dark ? "rgba(255,244,224,0.12)" : "rgba(255,255,255,0.6)";
  const grain = pixels >= 128;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">`,
    `<defs>`,
    `<clipPath id="body"><path d="${body}"/></clipPath>`,
    `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="12"/><feComponentTransfer><feFuncA type="linear" slope="${dark ? 0.5 : 0.28}"/></feComponentTransfer></filter>`,
    `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.1 0.62"/><feComposite in2="SourceGraphic" operator="in"/></filter>`,
    `<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${dark ? 0.07 : 0.28}"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
    `</defs>`,
    `<path d="${body}" filter="url(#shadow)"/>`,
    `<g clip-path="url(#body)">`,
    `<rect x="100" y="100" width="824" height="824" fill="${tileFill(PIP, mode)}"/>`,
    sticker(PIP, { x: 512 - size / 2, y: 924 - size + (detail === "glyph" ? 0 : 6), size, mode, face, detail }),
    grain ? `<rect x="100" y="100" width="824" height="824" fill="${dark ? "#000" : "#3a2a1a"}" filter="url(#grain)" opacity="${dark ? 0.14 : 0.1}"/>` : "",
    `<rect x="100" y="100" width="824" height="824" fill="url(#sheen)"/>`,
    `</g>`,
    `<path d="${body}" fill="none" stroke="${rim}" stroke-width="3"/>`,
    `</svg>`,
  ].join("");
}

// --- surfaces -------------------------------------------------------------------

// Cast seeds for brand compositions: picked from the portrait scan for spread
// of hue, shape, and topper. Pip is never one of them.
const CAST: ReadonlyArray<string> = [
  "junto-1", "junto-96", "junto-20", "junto-31", "junto-7", "junto-16", "junto-38", "junto-44",
  "junto-49", "junto-55", "junto-59", "junto-64", "junto-73", "junto-78", "junto-80", "junto-83",
  "junto-89", "junto-92", "junto-99", "junto-103", "junto-105", "junto-12", "junto-24", "junto-113",
];

// The DMG window is 1280 by 720 points with 128pt icons at (360, 360) and
// (920, 360) (package.json "dmg"). Pip leads the eye across the arrow; the
// crew peeks up from the bottom edge the way every portrait rises from its tile.
function dmgSvg(): string {
  const mode = themeMode("light");
  const t = themeRuntime(mode);
  const ink = t.ink ?? "#332c27";
  const cream = amberTone(mode, 0.965, 0.018);
  const peach = amberTone(mode, 0.93, 0.045);
  const mint = oklchToHex({ ...hexToOklch(t.green ?? "#237752"), l: 0.94, c: 0.035 });
  const lilac = oklchToHex({ ...hexToOklch(t.violet ?? "#7a5cc8"), l: 0.94, c: 0.03 });
  const crew: ReadonlyArray<readonly [seed: string, x: number, size: number, rotate: number, face: PortraitFace | undefined]> = [
    ["junto-20", 38, 132, -6, EXPRESSION_FACES.sleepy],
    ["junto-31", 176, 118, 4, undefined],
    ["junto-96", 1000, 124, -3, EXPRESSION_FACES.happy],
    ["junto-1", 1128, 130, 6, EXPRESSION_FACES.curious],
  ];
  const arrow = "M 474 356 C 560 318, 720 318, 800 352";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`,
    `<defs>`,
    `<radialGradient id="wa" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${peach}"/><stop offset="1" stop-color="${peach}" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="wb" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${mint}"/><stop offset="1" stop-color="${mint}" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="wc" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${lilac}"/><stop offset="1" stop-color="${lilac}" stop-opacity="0"/></radialGradient>`,
    `<filter id="soft" x="-10%" y="-10%" width="120%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="6"/><feOffset dy="5"/><feComponentTransfer><feFuncA type="linear" slope="0.16"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    `<marker id="head" viewBox="0 0 20 20" refX="10" refY="10" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M3 3 L15 10 L3 17" fill="none" stroke="${ink}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></marker>`,
    `</defs>`,
    `<rect width="1280" height="720" fill="${cream}"/>`,
    `<ellipse cx="300" cy="250" rx="420" ry="300" fill="url(#wa)" opacity="0.9"/>`,
    `<ellipse cx="1030" cy="200" rx="380" ry="260" fill="url(#wb)" opacity="0.8"/>`,
    `<ellipse cx="660" cy="640" rx="520" ry="220" fill="url(#wc)" opacity="0.7"/>`,
    `<path d="${arrow}" fill="none" stroke="${ink}" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="1 15" opacity="0.8" marker-end="url(#head)"/>`,
    `<g filter="url(#soft)">${sticker(PIP, { x: 584, y: 176, size: 112, mode, face: BRAND_FACES.happy, rotate: -4 })}</g>`,
    `<text x="640" y="120" text-anchor="middle" font-family='${FONT_DISPLAY}' font-weight="600" font-size="30" letter-spacing="5" fill="${ink}">JUNTO</text>`,
    `<text x="640" y="560" text-anchor="middle" font-family='${FONT_DISPLAY}' font-weight="500" font-size="17" letter-spacing="3.4" fill="${ink}" opacity="0.62">DRAG JUNTO INTO APPLICATIONS</text>`,
    ...crew.map(([seed, x, size, rotate, face]) => `<g filter="url(#soft)">${sticker({ seed }, { x, y: 720 - size * 0.66, size, mode, face, rotate })}</g>`),
    `</svg>`,
  ].join("");
}

// The election board: finalists side by side across the brand expressions.
const FINALISTS: ReadonlyArray<readonly [name: string, who: Character, note: string]> = [
  ["Pip", PIP, "elected: amber home hue with a sprout, calm, reads at 16px"],
  ["Tabby", { seed: "junto-1" }, "most charisma, spots get busy small"],
  ["Mochi", { seed: "junto-96" }, "sweet, but the wide bust crowds an icon"],
  ["Sprig", { seed: "junto-20" }, "Pip's green cousin, off the home hue"],
  ["Hop", { seed: "junto-31" }, "ears win the silhouette, cool hue reads cold"],
];

function boardSvg(): string {
  const mode = themeMode("light");
  const t = themeRuntime(mode);
  const ink = t.ink ?? "#332c27";
  const faces: ReadonlyArray<readonly [string, PortraitFace | undefined]> = [
    ["rest", undefined],
    ...BRAND_EXPRESSIONS.map((name) => [name, BRAND_FACES[name]] as const),
  ];
  const cell = 150;
  const left = 250;
  const rowH = 200;
  const width = left + faces.length * (cell + 16) + cell + 70;
  const height = 110 + FINALISTS.length * rowH;
  const rows = FINALISTS.map(([name, who, note], row) => {
    const y = 90 + row * rowH;
    const lead = row === 0;
    return [
      lead ? `<rect x="16" y="${y - 20}" width="${width - 32}" height="${rowH - 6}" rx="22" fill="${amberTone(mode, 0.93, 0.05)}"/>` : "",
      `<text x="40" y="${y + 60}" font-family='${FONT_DISPLAY}' font-weight="600" font-size="34" letter-spacing="4" fill="${ink}">${name.toUpperCase()}</text>`,
      `<text x="40" y="${y + 88}" font-family="Menlo, monospace" font-size="12" fill="${ink}" opacity="0.7">${who.seed}</text>`,
      `<foreignObject x="40" y="${y + 98}" width="190" height="60"><div xmlns="http://www.w3.org/1999/xhtml" style="font:12px Menlo, monospace;color:${ink};opacity:.7">${note}</div></foreignObject>`,
      ...faces.map(([label, face], index) => {
        const x = left + index * (cell + 16);
        return `${sticker(who, { x, y, size: cell, mode, face })}<text x="${x + cell / 2}" y="${y + cell + 20}" text-anchor="middle" font-family="Menlo, monospace" font-size="12" fill="${ink}" opacity="0.7">${label}</text>`;
      }),
      `<rect x="${left + faces.length * (cell + 16) - 4}" y="${y - 4}" width="${cell + 8}" height="${cell + 8}" rx="36" fill="#0c0b0a"/>`,
      sticker(who, { x: left + faces.length * (cell + 16), y, size: cell, mode: "dark" }),
    ].join("");
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${t.raise ?? "#f9f6f1"}"/>`,
    `<text x="40" y="52" font-family='${FONT_DISPLAY}' font-weight="600" font-size="24" letter-spacing="4" fill="${ink}">JUNTO MASCOT ELECTION</text>`,
    ...rows,
    `</svg>`,
  ].join("");
}

// --- commands -----------------------------------------------------------------

async function one(opts: Record<string, string>): Promise<void> {
  const out = opts.out;
  if (!out) throw new Error("one: --out file.svg|.png is required");
  const appearance: Appearance = opts.mode === "dark" ? "dark" : "light";
  const who: Character = opts.seed ? { seed: opts.seed, config: opts.config ? (JSON.parse(opts.config) as PortraitConfig) : undefined } : PIP;
  const svg = portraitSvg({
    ...who,
    mode: themeMode(appearance),
    detail: (opts.detail as PortraitDetail | undefined) ?? "rich",
    frame: (opts.frame as PortraitFrame | undefined) ?? "tile",
    face: faceFor(opts.expression),
  });
  if (extname(out) === ".png") {
    const size = Number(opts.size ?? 512);
    await png(svg, size, size, out);
  } else write(out, svg);
  console.log(out);
}

async function kit(opts: Record<string, string>): Promise<void> {
  const dir = opts.out;
  if (!dir) throw new Error("kit: --out DIR is required");
  const pngSize = opts.png ? Number(opts.png) : 0;
  const manifest: Array<Record<string, unknown>> = [];
  const emit = async (file: string, who: Character, appearance: Appearance, expression?: string): Promise<void> => {
    const svg = portraitSvg({ ...who, mode: themeMode(appearance), detail: "rich", face: faceFor(expression) });
    write(join(dir, file), svg);
    if (pngSize > 0) await png(svg, pngSize, pngSize, join(dir, file.replace(/\.svg$/, ".png")));
    manifest.push({ file, seed: who.seed, config: who.config ?? null, expression: expression ?? "rest", mode: appearance });
  };
  for (const appearance of ["light", "dark"] as const) {
    await emit(`mascot-${appearance}.svg`, PIP, appearance);
    for (const expression of [...BRAND_EXPRESSIONS, ...PORTRAIT_EXPRESSIONS]) {
      await emit(`mascot/${expression}-${appearance}.svg`, PIP, appearance, expression);
    }
    for (const [index, seed] of CAST.entries()) {
      await emit(`cast/${String(index + 1).padStart(2, "0")}-${appearance}.svg`, { seed }, appearance);
    }
    await png(iconSvg(appearance), 1024, 1024, join(dir, `icon-${appearance}.png`));
    manifest.push({ file: `icon-${appearance}.png`, mode: appearance, size: 1024 });
  }
  write(
    join(dir, "manifest.json"),
    `${JSON.stringify({ mascot: JUNTO_MASCOT, brandExpressions: BRAND_EXPRESSIONS, files: manifest }, null, 2)}\n`,
  );
  console.log(`${dir}: ${manifest.length} files`);
}

// iconutil's ladder: point size, and whether the entry is the @2x rendition.
const ICONSET: ReadonlyArray<readonly [points: number, scale: 1 | 2]> = [
  [16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2],
];

async function icns(appearance: Appearance, out: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "junto-icon-"));
  const set = join(work, "icon.iconset");
  try {
    for (const [points, scale] of ICONSET) {
      const pixels = points * scale;
      await png(iconSvg(appearance, pixels), pixels, pixels, join(set, `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`));
    }
    execFileSync("iconutil", ["-c", "icns", set, "-o", out]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(out);
}

// `--root DIR` writes the same tree somewhere else, for previews.
async function icon(opts: Record<string, string>): Promise<void> {
  const root = opts.root ?? ROOT;
  mkdirSync(join(root, "build"), { recursive: true });
  await icns("light", join(root, "build/icon.icns"));
  await icns("light", join(root, "build/icon-light.icns"));
  await icns("dark", join(root, "build/icon-dark.icns"));
  // Linux and the README use the 1024 PNG master.
  await png(iconSvg("light"), 1024, 1024, join(root, "assets/brand/junto-icon.png"));
  console.log(join(root, "assets/brand/junto-icon.png"));
}

async function dmg(opts: Record<string, string>): Promise<void> {
  const root = opts.root ?? ROOT;
  // electron-builder pairs name@2x.png with name.png into a HiDPI TIFF.
  await png(dmgSvg(), 1280, 720, join(root, "build/dmg-background.png"));
  await png(dmgSvg(), 2560, 1440, join(root, "build/dmg-background@2x.png"));
  console.log(join(root, "build/dmg-background.png"));
}

async function board(opts: Record<string, string>): Promise<void> {
  const out = opts.out ?? join(ROOT, "docs/brand/mascot-election.png");
  const svg = boardSvg();
  const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg) ?? [];
  await png(svg, Number(w), Number(h), out);
  console.log(out);
}

const COMMANDS: Record<string, (opts: Record<string, string>) => Promise<void>> = { one, kit, icon, dmg, board };

const [command = "", ...rest] = process.argv.slice(2);
const run = COMMANDS[command];
if (!run) {
  console.error(`usage: bun scripts/brand-export.ts <${Object.keys(COMMANDS).join("|")}> [flags]`);
  process.exit(2);
}
try {
  await run(flags(rest));
} finally {
  await browser?.close();
}
