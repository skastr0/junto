/**
 * Render every Junto cue to a WAV, through the real engine graph and mixer
 * in headless Chromium (OfflineAudioContext), and measure each cue's
 * loudness so urgency ordering is heard, not assumed.
 *
 *   bun scripts/sound-demo/render.ts           write .local/sound/junto-cues.{wav,txt}
 *   bun scripts/sound-demo/render.ts --open    and open the WAV
 *
 * Exits non-zero if a more urgent family measures quieter than a calmer one.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { CueId, CueVariant } from "../../src/renderer/lib/sound/cues";
import type { Shot } from "./page";

const ROOT = resolve(import.meta.dir, "../..");
const OUT = join(ROOT, ".local/sound");
const RATE = 48_000;

const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "page.ts")],
  target: "browser",
  format: "iife",
  minify: false,
});
if (!built.success) throw new AggregateError(built.logs, "sound demo bundle failed");
const code = await built.outputs[0]!.text();

const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());

type Rendered = { left: Float32Array; right: Float32Array };

const decode = (b64: string): Float32Array => {
  const bytes = Buffer.from(b64, "base64");
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>sound</title>");
  await page.addScriptTag({ content: code });
  const cues = await page.evaluate(() => window.__sound.cues);
  const seconds = (id: CueId) => cues.find((c) => c.id === id)!.seconds;

  const render = async (shots: ReadonlyArray<Shot>, length: number): Promise<Rendered> => {
    const out = await page.evaluate(([s, l]) => window.__sound.render(s, l), [shots, length] as const);
    return { left: decode(out.left), right: decode(out.right) };
  };

  // Loudness: the loudest 400 ms window of each cue alone, in dBFS.
  const loudness = new Map<CueId, number>();
  for (const { id } of cues) {
    const { left, right } = await render([{ cue: id, at: 0.05, variant: { count: 1 } }], seconds(id) + 1.5);
    const win = Math.floor(RATE * 0.4);
    const hop = Math.floor(RATE * 0.05);
    let best = 0;
    for (let start = 0; start + win <= left.length; start += hop) {
      let sum = 0;
      for (let i = start; i < start + win; i += 1) sum += (left[i]! ** 2 + right[i]! ** 2) / 2;
      best = Math.max(best, Math.sqrt(sum / win));
    }
    loudness.set(id, 20 * Math.log10(Math.max(best, 1e-9)));
  }

  // The demo: every cue, calm to urgent, then bursts, then a busy canvas.
  const sheet: string[] = [];
  const shots: Shot[] = [];
  let t = 0.4;
  const put = (cue: CueId, variant: CueVariant, note: string, gap = 0.9): void => {
    shots.push({ cue, at: t, variant });
    sheet.push(`${t.toFixed(1).padStart(5)}s  ${note}`);
    t += seconds(cue) + gap;
  };
  sheet.push("Every cue, calm to urgent");
  const calmToUrgent = [...cues].sort((a, b) => a.urgency - b.urgency);
  for (const cue of calmToUrgent) {
    if (cue.id === "mail") {
      for (const tone of ["notice", "prompt", "answer"] as const) {
        put("mail", { count: 1, tone }, `${cue.label} (${tone})`, 0.5);
      }
      continue;
    }
    put(cue.id, { count: 1 }, cue.label);
  }
  t += 0.8;
  sheet.push("Bursts the mixer folded into one play");
  put("working", { count: 3 }, "Started working, three seats at once");
  put("done", { count: 4 }, "Done, four seats at once");
  put("squad", { count: 6 }, "Squad of six placed");
  put("mail", { count: 5, tone: "prompt" }, "A burst of mail");
  t += 0.8;
  const busySeconds = 14;
  const busy = await page.evaluate(([at, s]) => window.__sound.busyCanvas(at, s), [t, busySeconds] as const);
  const heard = (cue: CueId) => busy.shots.filter((shot) => shot.cue === cue).length;
  sheet.push(
    `${t.toFixed(1).padStart(5)}s  A busy canvas: 50 seats, ${busy.raw} events in ${busySeconds}s, ` +
      `${busy.shots.length} sounded, of them ${heard("waiting")} waiting on you and ${heard("blocked")} blocked`,
  );
  shots.push(...busy.shots);
  const length = t + busySeconds + 3;

  const { left, right } = await render(shots, length);

  const pcm = Buffer.alloc(44 + left.length * 4);
  pcm.write("RIFF", 0);
  pcm.writeUInt32LE(36 + left.length * 4, 4);
  pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(RATE, 24);
  pcm.writeUInt32LE(RATE * 4, 28);
  pcm.writeUInt16LE(4, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36);
  pcm.writeUInt32LE(left.length * 4, 40);
  let peak = 0;
  for (let i = 0; i < left.length; i += 1) {
    for (const [c, channel] of [left, right].entries()) {
      const v = Math.max(-1, Math.min(1, channel[i]!));
      peak = Math.max(peak, Math.abs(v));
      pcm.writeInt16LE(Math.round(v * 32_767), 44 + i * 4 + c * 2);
    }
  }

  const table = [...cues]
    .sort((a, b) => b.urgency - a.urgency || loudness.get(b.id)! - loudness.get(a.id)!)
    .map((c) => `  ${c.label.padEnd(24)} urgency ${c.urgency}  ${loudness.get(c.id)!.toFixed(1)} dBFS`);

  // Families by urgency tier must be ordered by measured loudness.
  const tiers = [0, 1, 2, 3, 4].map((u) => cues.filter((c) => c.urgency === u).map((c) => loudness.get(c.id)!));
  const violations: string[] = [];
  for (let u = 1; u < tiers.length; u += 1) {
    const quietest = Math.min(...tiers[u]!);
    const loudestBelow = Math.max(...tiers[u - 1]!);
    if (!(quietest > loudestBelow)) {
      violations.push(`urgency ${u} quietest ${quietest.toFixed(1)} <= urgency ${u - 1} loudest ${loudestBelow.toFixed(1)}`);
    }
  }

  mkdirSync(OUT, { recursive: true });
  const wav = join(OUT, "junto-cues.wav");
  writeFileSync(wav, pcm);
  const text = [
    `Junto cues, ${length.toFixed(1)}s, 48 kHz stereo, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS at the default volume`,
    "",
    ...sheet,
    "",
    "Loudness (loudest 400 ms, default volume)",
    ...table,
    ...(violations.length > 0 ? ["", "ORDER VIOLATIONS", ...violations] : []),
  ].join("\n");
  writeFileSync(join(OUT, "junto-cues.txt"), `${text}\n`);
  console.log(text);
  console.log(`\n${wav}`);
  if (process.argv.includes("--open")) Bun.spawn(["open", wav]);
  if (violations.length > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
