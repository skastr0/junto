import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { overlay } from "@junto/overlay";
import { surfaces } from "@junto/overlay/renderer";
import { overlayManifest } from "@shared/overlay";
import { decodeOverlay, OSS_OVERLAY_MARKER } from "@shared/overlay-contract";
import { hasStore, openStore, store$ } from "../src/renderer/overlay/surfaces";
import { bundleMarkerViolations, fingerprintHits, overlayImportViolations, premiumFingerprints } from "../scripts/lint-overlay";
import { resolveOverlay } from "../scripts/overlay";

describe("overlay contract", () => {
  it("resolves the open-source stub in tests: no store, no premium cosmetics", () => {
    expect(overlayManifest).toEqual({ marker: OSS_OVERLAY_MARKER, name: "Open source", cosmetics: [] });
    expect(decodeOverlay(overlay)).toEqual(overlayManifest);
    expect(surfaces.store).toBeUndefined();
  });

  it("never opens a store in an open-source build", () => {
    expect(hasStore()).toBe(false);
    openStore();
    expect(store$.open.peek()).toBe(false);
  });

  it("degrades a malformed overlay to the open-source app", () => {
    const error = console.error;
    console.error = () => undefined;
    try {
      expect(decodeOverlay({ marker: "premium", name: "", cosmetics: 3 }).marker).toBe(OSS_OVERLAY_MARKER);
    } finally {
      console.error = error;
    }
  });

  it("keeps cosmetic packs raw for the pack decoder", () => {
    const pack = { format: 1, id: "sample" };
    expect(decodeOverlay({ marker: "junto-overlay:junto-premium", name: "Official", cosmetics: [pack] }).cosmetics).toEqual([pack]);
  });
});

describe("build-time overlay resolution", () => {
  it("builds the open-source app when JUNTO_OVERLAY is unset or blank", () => {
    expect(resolveOverlay({}).kind).toBe("oss");
    expect(resolveOverlay({ JUNTO_OVERLAY: "  " }).dir).toMatch(/src[/\\]overlay-oss$/);
  });

  it("points the alias at an overlay checkout and refuses a path without one", () => {
    const root = mkdtempSync(join(tmpdir(), "junto-overlay-"));
    try {
      expect(() => resolveOverlay({ JUNTO_OVERLAY: root })).toThrow(/overlay\/index\.ts/);
      mkdirSync(join(root, "overlay"));
      writeFileSync(join(root, "overlay", "index.ts"), "export const overlay = {};\n");
      expect(resolveOverlay({ JUNTO_OVERLAY: root })).toEqual({ kind: "official", dir: join(root, "overlay") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("overlay gates", () => {
  it("forbids reaching overlay code by path", () => {
    expect(overlayImportViolations("src/renderer/x.ts", `import { overlay } from "../overlay-oss";`)).toHaveLength(1);
    expect(overlayImportViolations("src/x.ts", `const m = await import("/p/junto-premium/overlay");`)).toHaveLength(1);
    expect(overlayImportViolations("src/x.ts", `import { overlay } from "@junto/overlay";`)).toEqual([]);
  });

  it("fails an open-source bundle that carries any overlay marker but its own", () => {
    expect(bundleMarkerViolations(new Set([OSS_OVERLAY_MARKER]), "oss")).toEqual([]);
    expect(bundleMarkerViolations(new Set([OSS_OVERLAY_MARKER, "junto-overlay:junto-premium"]), "oss")).toHaveLength(1);
    expect(bundleMarkerViolations(new Set([OSS_OVERLAY_MARKER]), "official")).toHaveLength(1);
    expect(bundleMarkerViolations(new Set(["junto-overlay:junto-premium"]), "official")).toEqual([]);
  });

  it("fingerprints premium items so an open-source bundle can be searched", () => {
    const prints = premiumFingerprints({
      cosmetics: [
        {
          id: "pack",
          species: [{ id: "blob", name: "Blob" }],
          toppers: [{ id: "horn", name: "Horn", parts: [{ shapes: [{ kind: "path", d: "M 0 0 L 4 -12 L 8 0 Z" }] }] }],
        },
      ],
    });
    expect(prints.map((print) => print.label)).toEqual(['premium species "blob" (pack)', 'premium toppers "horn" (pack)']);
    expect(fingerprintHits('const a={id:"blob",name:"Blob",body:{}}', prints)).toEqual(['premium species "blob" (pack)']);
    expect(fingerprintHits('d:"M 0 0 L 4 -12 L 8 0 Z"', prints)).toEqual(['premium toppers "horn" (pack)']);
    expect(fingerprintHits('{"id": "blob", "name": "Blob"}', prints)).toEqual(['premium species "blob" (pack)']);
    expect(fingerprintHits('{id:"round",name:"Round"} name:"Blob"', prints)).toEqual([]);
  });
});
