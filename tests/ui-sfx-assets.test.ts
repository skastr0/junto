import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { synthesizeUiSfx, UI_SFX, type UiSfxId } from "../scripts/build-ui-sfx";

describe("original UI cue assets", () => {
  it.each(Object.keys(UI_SFX) as UiSfxId[])("%s is reproducible, short, and unclipped", (id) => {
    const bytes = readFileSync(resolve(import.meta.dirname, `../src/renderer/assets/sfx/${id}.wav`));
    expect(bytes.equals(synthesizeUiSfx(id))).toBe(true);
    expect(synthesizeUiSfx(id).equals(synthesizeUiSfx(id))).toBe(true);

    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    expect(bytes.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(bytes.readUInt32LE(16)).toBe(16);
    expect(bytes.readUInt16LE(20)).toBe(1); // PCM, no codec dependency.
    expect(bytes.readUInt16LE(22)).toBe(1); // Mono.
    expect(bytes.readUInt32LE(24)).toBe(24_000);
    expect(bytes.readUInt32LE(28)).toBe(48_000);
    expect(bytes.readUInt16LE(32)).toBe(2);
    expect(bytes.readUInt16LE(34)).toBe(16);
    expect(bytes.toString("ascii", 36, 40)).toBe("data");
    expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44);

    const count = (bytes.length - 44) / 2;
    const duration = count / bytes.readUInt32LE(24);
    expect(duration).toBeGreaterThanOrEqual(0.05);
    expect(duration).toBeLessThanOrEqual(0.35);
    expect(bytes.readInt16LE(44)).toBe(0);
    expect(bytes.readInt16LE(bytes.length - 2)).toBe(0);

    let peak = 0;
    let energy = 0;
    for (let frame = 0; frame < count; frame += 1) {
      const sample = bytes.readInt16LE(44 + frame * 2) / 32_767;
      peak = Math.max(peak, Math.abs(sample));
      energy += sample * sample;
    }
    expect(peak).toBeGreaterThan(0.02);
    expect(peak).toBeLessThan(0.25);
    expect(Math.sqrt(energy / count)).toBeGreaterThan(0.005);
  });
});
