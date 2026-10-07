import { createPackage } from "@electron/asar";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import electronViteConfig from "../electron.vite.config";
import { overlay } from "@junto/overlay";
import { surfaces } from "@junto/overlay/renderer";
import { overlayManifest } from "@shared/overlay";
import { decodeOverlay, OSS_OVERLAY_MARKER } from "@shared/overlay-contract";
import { hasStore, openStore, store$ } from "../src/renderer/overlay/surfaces";
import {
  bundleMarkerViolations,
  checkBundle,
  fingerprintHits,
  overlayImportViolations,
  premiumFingerprints,
  premiumUiHits,
} from "../scripts/lint-overlay";
import { resolveOverlay } from "../scripts/overlay";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
afterEach(() => vi.unstubAllEnvs());

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

  it("rejects an existing overlay in production regardless of preview or payment environment", () => {
    const root = mkdtempSync(join(tmpdir(), "junto-overlay-production-"));
    try {
      mkdirSync(join(root, "overlay"));
      writeFileSync(join(root, "overlay", "index.ts"), "export const overlay = {};\n");
      expect(() => resolveOverlay({
        JUNTO_OVERLAY: root,
        NODE_ENV: "development",
        JUNTO_ALLOW_UNRELEASED_OVERLAY: "1",
        JUNTO_OVERLAY_MODE: "preview",
        JUNTO_PAYMENT_CHECKOUT_URL: "https://checkout.example.invalid",
      })).toThrow(/unreleased.*production/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Plus in the production build preflight before compilation", () => {
    const root = mkdtempSync(join(tmpdir(), "junto-overlay-preflight-"));
    try {
      mkdirSync(join(root, "overlay"));
      writeFileSync(join(root, "overlay", "index.ts"), "export const overlay = {};\n");
      const result = spawnSync("/bin/bash", ["scripts/build-app.sh", "--preflight-only"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          JUNTO_FEATURE_PROFILE: "ship",
          JUNTO_ALLOW_FEATURE_OVERRIDES: "1",
          JUNTO_OVERLAY: root,
          NODE_ENV: "development",
          JUNTO_ALLOW_UNRELEASED_OVERLAY: "1",
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/unreleased.*production/i);
      expect(result.stdout).not.toContain("building fresh package runtimes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("points a preview alias at an overlay checkout and refuses a path without one", () => {
    const root = mkdtempSync(join(tmpdir(), "junto-overlay-"));
    try {
      expect(() => resolveOverlay({ JUNTO_OVERLAY: root }, undefined, "preview")).toThrow(/overlay\/index\.ts/);
      mkdirSync(join(root, "overlay"));
      writeFileSync(join(root, "overlay", "index.ts"), "export const overlay = {};\n");
      expect(resolveOverlay({ JUNTO_OVERLAY: root }, undefined, "preview")).toEqual({ kind: "official", dir: join(root, "overlay") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Vite overlay build intent", () => {
  it.each(["production", "development", "staging"])("blocks Plus in a build using %s mode", async (mode) => {
    vi.stubEnv("JUNTO_OVERLAY", "/unreleased-overlay");
    vi.stubEnv("NODE_ENV", "development");
    expect(() => electronViteConfig({ command: "build", mode })).toThrow(/unreleased.*production/i);
  });

  it("allows Plus only in development or the named overlay preview build", async () => {
    const root = mkdtempSync(join(tmpdir(), "junto-overlay-vite-"));
    try {
      mkdirSync(join(root, "overlay"));
      writeFileSync(join(root, "overlay", "index.ts"), "export const overlay = {};\n");
      vi.stubEnv("JUNTO_OVERLAY", root);
      for (const intent of [
        { command: "serve" as const, mode: "development" },
        { command: "build" as const, mode: "overlay-preview" },
      ]) {
        const config = await electronViteConfig(intent);
        for (const target of [config.main, config.preload, config.renderer]) {
          expect(target?.define?.__JUNTO_PREMIUM__).toBe("true");
          expect(target?.resolve?.alias).toMatchObject({ "@junto/overlay": join(root, "overlay") });
        }
      }
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

  it("finds premium UI an open-source bundle must not carry", () => {
    expect(premiumUiHits('jsx("div", { "data-testid": "overlay-store" })')).toEqual(["the store host"]);
    expect(premiumUiHits("title: `${name}, not unlocked on this install`")).toEqual(["locked item copy"]);
    expect(premiumUiHits('{ id: "palette", label: "Open settings" }')).toEqual([]);
  });

  it("rejects stale preview output after JUNTO_OVERLAY is unset, while admitting OSS output", async () => {
    const root = mkdtempSync(join(tmpdir(), "junto-overlay-output-"));
    try {
      vi.stubEnv("JUNTO_OVERLAY", "");
      writeFileSync(join(root, "index.js"), 'const marker = "junto-overlay:unreleased"; const ui = "overlay-store";');
      expect(await checkBundle(root)).toEqual(expect.arrayContaining([
        "open-source bundle carries junto-overlay:unreleased",
        "open-source bundle carries premium UI: the store host",
      ]));
      writeFileSync(join(root, "index.js"), `const marker = ${JSON.stringify(OSS_OVERLAY_MARKER)};`);
      expect(await checkBundle(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["darwin", "linux"])("rejects a preview archive in the actual %s packaging hook", async (platform) => {
    const root = mkdtempSync(join(tmpdir(), "junto-overlay-package-"));
    const stage = join(root, "stage");
    const resources = platform === "darwin"
      ? join(root, "Junto.app", "Contents", "Resources")
      : join(root, "resources");
    const archive = join(resources, "app.asar");
    try {
      vi.stubEnv("JUNTO_OVERLAY", "");
      mkdirSync(join(stage, "out", "renderer", "assets"), { recursive: true });
      mkdirSync(resources, { recursive: true });
      const bundle = join(stage, "out", "renderer", "assets", "index.js");
      writeFileSync(bundle, 'const marker = "junto-overlay:unreleased"; const ui = "overlay-store";');
      await createPackage(stage, archive);
      expect(await checkBundle(archive, { asar: true })).toEqual(expect.arrayContaining([
        "open-source bundle carries junto-overlay:unreleased",
        "open-source bundle carries premium UI: the store host",
      ]));
      await expect(checkBundle(archive, { asar: true, preview: true })).rejects.toThrow(/cannot allow preview overlays/);

      const hook = new URL("../scripts/electron-builder-after-pack.mjs", import.meta.url).href;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import afterPack from ${JSON.stringify(hook)};
        await afterPack(${JSON.stringify({
          electronPlatformName: platform,
          appOutDir: root,
          packager: { appInfo: { productName: "Junto", productFilename: "Junto" }, executableName: "junto" },
        })});
      `], { encoding: "utf8", env: { ...process.env, JUNTO_ALLOW_UNRELEASED_OVERLAY: "1" } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("open-source bundle carries junto-overlay:unreleased");

      writeFileSync(bundle, `const marker = ${JSON.stringify(OSS_OVERLAY_MARKER)};`);
      const cleanArchive = join(resources, "clean.asar");
      await createPackage(stage, cleanArchive);
      expect(await checkBundle(cleanArchive, { asar: true })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("checks compiled output before either native packager creates a package attempt", () => {
    for (const name of ["package-app-macos.sh", "package-app-linux.sh"]) {
      const script = readFileSync(join(repoRoot, "scripts", name), "utf8");
      const gate = script.indexOf('$SCRIPT_DIR/lint-overlay.ts" --bundle');
      expect(gate).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(script.indexOf('ATTEMPT_DIR="$(mktemp'));
      expect(gate).toBeLessThan(script.indexOf("bunx --no-install electron-builder"));
      expect(script).not.toContain('lint-overlay.ts" --bundle --preview');
    }
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
