/**
 * The preload bundle gate at commit time: electron-vite's preload build,
 * run in memory with `preloadBundleGuard` (scripts/preload-bundle-guard.ts),
 * the same plugin `electron.vite.config.ts` puts on every real build. The
 * settings below mirror electron-vite's preload preset: Node built-ins and
 * `electron` external, packages in `dependencies` external, the rest bundled.
 */
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { externalizeDepsPlugin } from "electron-vite";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import {
  type PreloadBundleReport,
  preloadBundleGuard,
  preloadModuleRefusal,
} from "../scripts/preload-bundle-guard";
import { overlayAlias, resolveOverlay } from "../scripts/overlay";

const root = process.cwd();

const bundlePreload = async (
  entry: string,
): Promise<PreloadBundleReport & { readonly error?: string }> => {
  let report: PreloadBundleReport = { bundled: [], external: [], refusals: [] };
  try {
    await build({
      configFile: false,
      root,
      logLevel: "silent",
      resolve: {
        alias: {
          "@main": resolve(root, "src/main"),
          "@preload": resolve(root, "src/preload"),
          "@renderer": resolve(root, "src/renderer"),
          "@shared": resolve(root, "src/shared"),
          ...overlayAlias(resolveOverlay({})),
        },
      },
      plugins: [
        externalizeDepsPlugin(),
        preloadBundleGuard((found) => {
          report = found;
        }),
      ],
      ssr: { noExternal: true },
      build: {
        write: false,
        ssr: true,
        minify: false,
        reportCompressedSize: false,
        lib: { entry, formats: ["cjs"] },
        rollupOptions: {
          external: ["electron", /^electron\/.+/, ...builtinModules.flatMap((name) => [name, `node:${name}`])],
        },
      },
    });
    return report;
  } catch (error) {
    return { ...report, error: error instanceof Error ? error.message : String(error) };
  }
};

describe("sandboxed preload bundle", () => {
  it("carries only src/preload, src/shared and require(\"electron\")", async () => {
    const result = await bundlePreload(resolve(root, "src/preload/index.ts"));
    expect(result.error).toBeUndefined();
    expect(result.refusals).toEqual([]);
    expect(result.bundled).toContain("src/preload/index.ts");
    expect(result.external).toEqual(["electron"]);
  }, 60_000);

  it("refuses Effect and a Node built-in, naming each module and its importer", async () => {
    const entry = "tests/fixtures/preload-bundle-refused.ts";
    const result = await bundlePreload(resolve(root, entry));
    expect(result.error).toContain("the preload bundle carries modules a sandboxed preload cannot run");
    expect(result.error).toContain(`node:fs (imported by ${entry})`);
    const effect = result.refusals.find((refusal) => refusal.module === "effect");
    expect(effect).toMatchObject({ importers: [entry], reason: expect.stringMatching(/^Effect is refused/) });
    expect(result.refusals.find((refusal) => refusal.module === "node:fs")).toMatchObject({
      importers: [entry],
      reason: expect.stringContaining("may require only electron"),
    });
  }, 60_000);

  it("allows the preload's own folders and electron, and nothing else", () => {
    expect(preloadModuleRefusal(root, resolve(root, "src/preload/index.ts"), false)).toBeUndefined();
    expect(preloadModuleRefusal(root, resolve(root, "src/shared/ipc.ts"), false)).toBeUndefined();
    expect(preloadModuleRefusal(root, "electron", true)).toBeUndefined();
    expect(preloadModuleRefusal(root, resolve(root, "src/main/runtime.ts"), false)).toMatch(/bundles only/);
    expect(preloadModuleRefusal(root, resolve(root, "node_modules/ws/index.js"), false)).toMatch(/bundles only/);
    expect(preloadModuleRefusal(root, "ws", true)).toMatch(/may require only/);
    expect(preloadModuleRefusal(root, "effect", true)).toMatch(/^Effect is refused/);
  });
});
