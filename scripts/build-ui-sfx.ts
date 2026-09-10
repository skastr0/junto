#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Original UI cues synthesized from integer triangle oscillators. No samples,
// provider output, randomness, timestamps, or encoder dependency.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SFX_SAMPLE_RATE = 24_000;
const FULL_SCALE = 32_767;

interface Tone {
  readonly startMs: number;
  readonly durationMs: number;
  readonly frequency: number;
  readonly amplitude: number;
}

interface Cue {
  readonly durationMs: number;
  readonly tones: readonly Tone[];
}

export const UI_SFX = {
  blocked: {
    durationMs: 240,
    tones: [
      { startMs: 0, durationMs: 210, frequency: 180, amplitude: 5600 },
      { startMs: 0, durationMs: 110, frequency: 360, amplitude: 1400 },
    ],
  },
  attention: {
    durationMs: 300,
    tones: [
      { startMs: 0, durationMs: 110, frequency: 660, amplitude: 5000 },
      { startMs: 130, durationMs: 150, frequency: 880, amplitude: 5000 },
    ],
  },
  cycle: {
    durationMs: 60,
    tones: [
      { startMs: 0, durationMs: 50, frequency: 1100, amplitude: 2500 },
    ],
  },
} as const satisfies Readonly<Record<string, Cue>>;

export type UiSfxId = keyof typeof UI_SFX;

const frames = (milliseconds: number): number =>
  Math.trunc(milliseconds * SFX_SAMPLE_RATE / 1000);

const toneSample = (tone: Tone, frame: number): number => {
  const age = frame - frames(tone.startMs);
  const length = frames(tone.durationMs);
  if (age < 0 || age >= length) return 0;
  const attack = frames(6);
  const ramp = Math.min(
    FULL_SCALE,
    Math.trunc(age * FULL_SCALE / attack),
    Math.trunc((length - 1 - age) * FULL_SCALE / (length - attack)),
  );
  const envelope = Math.trunc(ramp * ramp / FULL_SCALE);
  const phase = (age * tone.frequency) % SFX_SAMPLE_RATE;
  const triangle = Math.trunc(
    (SFX_SAMPLE_RATE - 4 * Math.abs(phase - SFX_SAMPLE_RATE / 2)) *
    tone.amplitude / SFX_SAMPLE_RATE,
  );
  return Math.trunc(triangle * envelope / FULL_SCALE);
};

/** Mono signed 16-bit PCM RIFF/WAVE, with only fmt and data chunks. */
export const synthesizeUiSfx = (id: UiSfxId): Buffer => {
  const cue = UI_SFX[id];
  const count = frames(cue.durationMs);
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SFX_SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SFX_SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(count * 2, 40);
  for (let frame = 0; frame < count; frame += 1) {
    const value = cue.tones.reduce((sum, tone) => sum + toneSample(tone, frame), 0);
    if (Math.abs(value) > FULL_SCALE) throw new Error(`${id}: clipped sample`);
    bytes.writeInt16LE(value, 44 + frame * 2);
  }
  return bytes;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("usage: bun scripts/build-ui-sfx.ts [--check]");
  }
  const check = args[0] === "--check";
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const output = resolve(root, "src/renderer/assets/sfx");
  if (!check) mkdirSync(output, { recursive: true });
  for (const id of Object.keys(UI_SFX) as UiSfxId[]) {
    const path = resolve(output, `${id}.wav`);
    const bytes = synthesizeUiSfx(id);
    if (check) {
      if (!readFileSync(path).equals(bytes)) throw new Error(`${id}: regenerate UI cue`);
    } else {
      writeFileSync(path, bytes);
    }
    console.log(`${check ? "verified" : "wrote"} ${id}.wav (${UI_SFX[id].durationMs} ms)`);
  }
}
