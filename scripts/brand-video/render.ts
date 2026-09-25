#!/usr/bin/env bun
/**
 * Brand video renderer. Bundles scene.ts for the browser, paints every frame
 * in headless Chrome as a pure function of time, and pipes the frames to
 * ffmpeg. Deterministic: the same commit renders the same video.
 *
 *   bun scripts/brand-video/render.ts --out ../junto-landing/public/video
 *   bun scripts/brand-video/render.ts --cut loop --out <dir>
 *   bun scripts/brand-video/render.ts --stills 1.5,6,12.4     (PNGs to test-results/brand-video)
 *
 * Claims: a beat renders only when the app code it shows is committed here.
 * The core beats must be; preambles and squads join once theirs land.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import type { Beats, SceneOptions } from "./scene";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const fps = Number(arg("fps") ?? 30);
const cutArg = arg("cut") ?? "all";
const outDir = resolve(arg("out") ?? join(ROOT, "test-results", "brand-video"));
const stills = arg("stills")
  ?.split(",")
  .map(Number)
  .filter((n) => Number.isFinite(n));

const committed = (path: string): boolean =>
  spawnSync("git", ["ls-files", "--error-unmatch", path], { cwd: ROOT, stdio: "ignore" }).status === 0;

const CORE_SOURCES = [
  "src/shared/agent-portrait.ts",
  "src/shared/portrait-expression.ts",
  "src/renderer/lib/activity-rings.ts",
  "src/renderer/lib/multi-prompt.ts",
  "src/renderer/lib/wire-pulse.ts",
  "src/renderer/components/feed/OperatorFeed.tsx",
  "src/shared/brand-mascot.ts",
];
const OPTIONAL_SOURCES: Readonly<Record<keyof Beats, string>> = {
  preambles: "src/renderer/components/nodes/PreambleBubble.tsx",
  squads: "src/renderer/lib/squads.ts",
};

const missing = CORE_SOURCES.filter((path) => !committed(path));
if (missing.length > 0) {
  console.error(`brand-video: core beats show app code that is not committed: ${missing.join(", ")}`);
  process.exit(1);
}
const beats: Beats = {
  preambles: committed(OPTIONAL_SOURCES.preambles),
  squads: committed(OPTIONAL_SOURCES.squads),
};
for (const [beat, on] of Object.entries(beats)) {
  console.error(`brand-video: ${beat} ${on ? "on" : `off (${OPTIONAL_SOURCES[beat as keyof Beats]} not committed)`}`);
}

const bundle = await Bun.build({
  entrypoints: [join(ROOT, "scripts", "brand-video", "scene.ts")],
  target: "browser",
  format: "esm",
});
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log);
  process.exit(1);
}
const script = await bundle.outputs[0]!.text();

type PageApi = {
  prepare: (options: SceneOptions) => Promise<{ duration: number; scenes: ReadonlyArray<{ id: string; start: number; dur: number }> }>;
  draw: (t: number) => void;
  png: () => string;
  jpeg: (quality: number) => string;
};
declare const window: { __junto?: PageApi };

const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());

const openStage = async (cut: SceneOptions["cut"]) => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => console.error(`brand-video: page error: ${error.message}`));
  await page.setContent('<!doctype html><html><body style="margin:0"><canvas id="stage"></canvas></body></html>');
  await page.addScriptTag({ content: script, type: "module" });
  await page.waitForFunction(() => window.__junto !== undefined);
  const info = await page.evaluate((options) => window.__junto!.prepare(options), { cut, beats } satisfies SceneOptions);
  return { page, info };
};

const dataOf = (url: string): Buffer => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

const encode = async (cut: SceneOptions["cut"], name: string, posterAt: (duration: number) => number): Promise<void> => {
  const { page, info } = await openStage(cut);
  mkdirSync(outDir, { recursive: true });
  const frames = Math.round(info.duration * fps);
  console.error(
    `brand-video: ${name} ${info.duration.toFixed(2)}s, ${String(frames)} frames at ${String(fps)} fps` +
      (cut === "full" ? `\n  ${info.scenes.map((s) => `${s.id}@${s.start.toFixed(1)}`).join("  ")}` : ""),
  );
  const mp4 = join(outDir, `${name}.mp4`);
  const webm = join(outDir, `${name}.webm`);
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-an", mp4,
      "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
      "-pix_fmt", "yuv420p", "-an", webm,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const done = once(ffmpeg, "exit");
  const started = Date.now();
  for (let i = 0; i < frames; i += 1) {
    const url = await page.evaluate((t) => {
      window.__junto!.draw(t);
      return window.__junto!.png();
    }, i / fps);
    if (!ffmpeg.stdin.write(dataOf(url))) await once(ffmpeg.stdin, "drain");
    if (i % (fps * 5) === 0) console.error(`  frame ${String(i)}/${String(frames)} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  ffmpeg.stdin.end();
  const [code] = (await done) as [number | null];
  if (code !== 0) throw new Error(`ffmpeg exited ${String(code)}`);
  const poster = join(outDir, `${name}-poster.jpg`);
  const jpeg = await page.evaluate((t) => {
    window.__junto!.draw(t);
    return window.__junto!.jpeg(0.9);
  }, posterAt(info.duration));
  writeFileSync(poster, dataOf(jpeg));
  await page.close();
  for (const file of [mp4, webm, poster]) {
    console.error(`  ${file}  ${(statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
  }
};

try {
  if (stills && stills.length > 0) {
    const cut = cutArg === "loop" ? "loop" : "full";
    const { page } = await openStage(cut);
    mkdirSync(outDir, { recursive: true });
    for (const t of stills) {
      const url = await page.evaluate((at) => {
        window.__junto!.draw(at);
        return window.__junto!.png();
      }, t);
      const file = join(outDir, `still-${cut}-${t.toFixed(2)}.png`);
      writeFileSync(file, dataOf(url));
      console.error(`  ${file}`);
    }
  } else {
    if (cutArg === "full" || cutArg === "all") await encode("full", "junto-intro", (d) => d - 0.05);
    if (cutArg === "loop" || cutArg === "all") await encode("loop", "junto-loop", () => 0);
  }
} finally {
  await browser.close();
}
