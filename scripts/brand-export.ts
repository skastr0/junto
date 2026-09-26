// Brand export for the open-source build: the neutral app icon and DMG
// background, drawn from the Junto mark (src/shared/brand-mark.ts), plus any
// one seat's portrait rendered headlessly. The mascot and the brand cast are
// private brand content and export from the overlay repository instead
// (docs/overlay.md). Heavy runs go through the shared lock:
//   lockf -k /tmp/junto-heavy.lock bun scripts/brand-export.ts <command>
//
// Commands:
//   one --out file.svg|.png [--seed S] [--config JSON] [--expression E]
//       [--mode light|dark] [--frame tile|round|bare] [--detail rich|card|glyph]
//       [--size N]                      one seat's portrait
//   icon [--root DIR]                  build/icon*.icns + assets/brand/junto-icon.png
//   dmg [--root DIR]                   build/dmg-background.png + @2x
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { portraitSvg, type PortraitConfig, type PortraitDetail, type PortraitFrame } from "../src/shared/agent-portrait";
import { juntoMarkDataUri } from "../src/shared/brand-mark";
import { EXPRESSION_FACES, type PortraitExpression } from "../src/shared/portrait-expression";
import { FONT_DISPLAY, themeRuntime, type ThemeMode } from "../src/shared/theme";

const ROOT = join(import.meta.dir, "..");

type Appearance = "light" | "dark";
const themeMode = (appearance: Appearance): ThemeMode => (appearance === "dark" ? "dark" : "bright");

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

const f = (value: number): string => String(Math.round(value * 100) / 100);

// --- surfaces -------------------------------------------------------------------

// Apple's macOS icon grid: a 1024 canvas, an 824 body inset 100 on every side,
// continuous (squircle) corners, and a soft drop shadow below. The corner is a
// superellipse, not a circular arc, so the path is sampled rather than arced.
const squirclePath = (x: number, y: number, size: number): string => {
  const r = size / 2;
  const cx = x + r;
  const cy = y + r;
  const n = 5;
  const points: string[] = [];
  for (let step = 0; step < 360; step += 1) {
    const t = (step / 360) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    points.push(`${f(cx + r * Math.sign(cos) * Math.abs(cos) ** (2 / n))} ${f(cy + r * Math.sign(sin) * Math.abs(sin) ** (2 / n))}`);
  }
  return `M${points.join("L")}Z`;
};

/** The app icon: the Junto mark on the Apple body, in the theme's own ground. */
function iconSvg(appearance: Appearance): string {
  const mode = themeMode(appearance);
  const dark = appearance === "dark";
  const t = themeRuntime(mode);
  const body = squirclePath(100, 100, 824);
  const mark = 520;
  const rim = dark ? "rgba(255,244,224,0.12)" : "rgba(255,255,255,0.6)";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">`,
    `<defs>`,
    `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="12"/><feComponentTransfer><feFuncA type="linear" slope="${dark ? 0.5 : 0.28}"/></feComponentTransfer></filter>`,
    `<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${dark ? 0.07 : 0.28}"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
    `</defs>`,
    `<path d="${body}" filter="url(#shadow)"/>`,
    `<path d="${body}" fill="${dark ? t.ground : t.raise}"/>`,
    `<image href="${juntoMarkDataUri(mode)}" x="${512 - mark / 2}" y="${512 - mark / 2}" width="${mark}" height="${mark}"/>`,
    `<path d="${body}" fill="url(#sheen)"/>`,
    `<path d="${body}" fill="none" stroke="${rim}" stroke-width="3"/>`,
    `</svg>`,
  ].join("");
}

/** The DMG window: the mark, the drag hint, and nothing else. */
function dmgSvg(): string {
  const t = themeRuntime("bright");
  const ink = t.ink ?? "#332c27";
  const arrow = "M 474 356 C 560 318, 720 318, 800 352";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`,
    `<defs>`,
    `<marker id="head" viewBox="0 0 20 20" refX="10" refY="10" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M3 3 L15 10 L3 17" fill="none" stroke="${ink}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></marker>`,
    `</defs>`,
    `<rect width="1280" height="720" fill="${t.raise}"/>`,
    `<image href="${juntoMarkDataUri("bright")}" x="604" y="136" width="72" height="72"/>`,
    `<path d="${arrow}" fill="none" stroke="${ink}" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="1 15" opacity="0.8" marker-end="url(#head)"/>`,
    `<text x="640" y="258" text-anchor="middle" font-family='${FONT_DISPLAY}' font-weight="600" font-size="30" letter-spacing="5" fill="${ink}">JUNTO</text>`,
    `<text x="640" y="560" text-anchor="middle" font-family='${FONT_DISPLAY}' font-weight="500" font-size="17" letter-spacing="3.4" fill="${ink}" opacity="0.62">DRAG JUNTO INTO APPLICATIONS</text>`,
    `</svg>`,
  ].join("");
}

// --- commands -------------------------------------------------------------------

async function one(opts: Record<string, string>): Promise<void> {
  const out = opts.out;
  if (!out) throw new Error("one: --out file.svg|.png is required");
  const expression = opts.expression as PortraitExpression | undefined;
  if (expression && !(expression in EXPRESSION_FACES)) throw new Error(`unknown expression "${expression}"`);
  const svg = portraitSvg({
    seed: opts.seed ?? "junto",
    mode: themeMode(opts.mode === "dark" ? "dark" : "light"),
    detail: (opts.detail as PortraitDetail | undefined) ?? "rich",
    frame: (opts.frame as PortraitFrame | undefined) ?? "tile",
    ...(opts.config ? { config: JSON.parse(opts.config) as PortraitConfig } : {}),
    ...(expression ? { face: EXPRESSION_FACES[expression] } : {}),
  });
  if (extname(out) === ".png") {
    const size = Number(opts.size ?? 512);
    await png(svg, size, size, out);
  } else write(out, svg);
  console.log(out);
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
      await png(iconSvg(appearance), pixels, pixels, join(set, `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`));
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
  await png(iconSvg("light"), 256, 256, join(root, "src/renderer/assets/brand/junto-icon.png"));
  console.log(join(root, "assets/brand/junto-icon.png"));
}

async function dmg(opts: Record<string, string>): Promise<void> {
  const root = opts.root ?? ROOT;
  // electron-builder pairs name@2x.png with name.png into a HiDPI TIFF.
  await png(dmgSvg(), 1280, 720, join(root, "build/dmg-background.png"));
  await png(dmgSvg(), 2560, 1440, join(root, "build/dmg-background@2x.png"));
  console.log(join(root, "build/dmg-background.png"));
}

const COMMANDS: Record<string, (opts: Record<string, string>) => Promise<void>> = { one, icon, dmg };

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
