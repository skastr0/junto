/**
 * `portrait.get` with format "png": the SVG from companionPortraitSvg drawn
 * into a size x size PNG for the phone. resvg runs as wasm, so the packaged
 * Electron main and the compiled junto CLI share one rasterizer and no native
 * module needs signing. The SVG goes in and PNG bytes come out; nothing is
 * logged, kept or sent anywhere else.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

const wasmPath = async (): Promise<string> =>
  process.versions.bun !== undefined
    ? (await import("./portrait-png-wasm.bun")).default
    : require.resolve("@resvg/resvg-wasm/index_bg.wasm");

// initWasm may run once per process; every caller shares the first load.
let ready: Promise<void> | undefined;
const loadResvg = (): Promise<void> => {
  ready ??= wasmPath()
    .then((path) => readFile(path))
    .then((bytes) => initWasm(bytes))
    .catch((cause: unknown) => {
      ready = undefined;
      throw cause;
    });
  return ready;
};

export const rasterizePortraitSvg = async (svg: string, size: number): Promise<Uint8Array> => {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`portrait size must be a positive integer, got ${size}`);
  await loadResvg();
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } });
  try {
    const image = resvg.render();
    try {
      if (image.width !== size || image.height !== size) {
        throw new Error(`portrait rendered at ${image.width}x${image.height}, not ${size}x${size}`);
      }
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
};
