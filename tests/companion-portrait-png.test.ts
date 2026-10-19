import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { rasterizePortraitSvg } from "../src/main/junto/companion/portrait-png";
import { companionPortraitSvg } from "../src/shared/companion-portrait";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Chunk = { readonly type: string; readonly data: Buffer };

const chunks = (png: Uint8Array): Chunk[] => {
  const buf = Buffer.from(png);
  const out: Chunk[] = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    out.push({ type: buf.toString("latin1", at + 4, at + 8), data: buf.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
};

const predict = (filter: number, a: number, b: number, c: number): number => {
  if (filter === 0) return 0;
  if (filter === 1) return a;
  if (filter === 2) return b;
  if (filter === 3) return (a + b) >> 1;
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// Decodes 8-bit RGBA without interlace, which is what resvg writes.
const rgbaPixels = (png: Uint8Array): { width: number; height: number; pixels: Buffer } => {
  const all = chunks(png);
  const ihdr = all[0]!;
  expect(ihdr.type).toBe("IHDR");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  expect([ihdr.data[8], ihdr.data[9], ihdr.data[12]]).toEqual([8, 6, 0]);
  const raw = inflateSync(Buffer.concat(all.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4]! : 0;
      pixels[y * stride + x] = (line[x]! + predict(filter, a, b, c)) & 0xff;
    }
  }
  return { width, height, pixels };
};

const colours = (pixels: Buffer): Set<number> => {
  const seen = new Set<number>();
  for (let at = 0; at < pixels.length; at += 4) seen.add(pixels.readUInt32BE(at));
  return seen;
};

describe("rasterizePortraitSvg", () => {
  for (const size of [16, 128, 1024]) {
    for (const theme of ["bright", "dark"] as const) {
      it(`draws a ${size} x ${size} ${theme} portrait as a real PNG`, async () => {
        const svg = companionPortraitSvg({ portraitIdentity: "agent-01M4G25KD4JNH7ZP39XQKAC2TK", size, theme });
        const png = await rasterizePortraitSvg(svg, size);

        expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
        const decoded = rgbaPixels(png);
        expect(decoded.width).toBe(size);
        expect(decoded.height).toBe(size);
        expect(colours(decoded.pixels).size).toBeGreaterThan(1);
        // A 1024 portrait's grain filter takes most of a second alone; a full run shares the CPU.
      }, 20_000);
    }
  }

  it("draws the bright and dark themes differently", async () => {
    const draw = (theme: "bright" | "dark") =>
      rasterizePortraitSvg(companionPortraitSvg({ portraitIdentity: "agent-x", size: 64, theme }), 64);
    const [bright, dark] = await Promise.all([draw("bright"), draw("dark")]);
    expect(rgbaPixels(bright).pixels.equals(rgbaPixels(dark).pixels)).toBe(false);
  });

  it("refuses a size that is not a positive integer", async () => {
    const svg = companionPortraitSvg({ portraitIdentity: "agent-x", size: 16, theme: "dark" });
    for (const size of [0, -1, 1.5, Number.NaN]) {
      await expect(rasterizePortraitSvg(svg, size)).rejects.toThrow(RangeError);
    }
  });
});
