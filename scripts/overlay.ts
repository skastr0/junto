// Build-time overlay resolution (docs/overlay.md). JUNTO_OVERLAY names a
// checkout of the private overlay repository; the `@junto/overlay` alias then
// points at its overlay/ directory. Unset, the alias points at the in-repo
// stub, and the build is the open-source app. Nothing is resolved at run time.
//
//   bun scripts/overlay.ts --receipt     one line naming the overlay a build uses
//   bun scripts/overlay.ts --brand-dir   the overlay's brand/ directory, or nothing
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export const OVERLAY_ALIAS = "@junto/overlay";

export interface ResolvedOverlay {
  readonly kind: "oss" | "official";
  /** Directory the alias maps to: holds index.ts and renderer.ts(x). */
  readonly dir: string;
}

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function resolveOverlay(env: NodeJS.ProcessEnv = process.env, repoRoot = REPO_ROOT): ResolvedOverlay {
  const raw = (env.JUNTO_OVERLAY ?? "").trim();
  if (raw === "") return { kind: "oss", dir: join(repoRoot, "src", "overlay-oss") };
  const dir = join(isAbsolute(raw) ? raw : resolve(repoRoot, raw), "overlay");
  if (!existsSync(join(dir, "index.ts"))) {
    throw new Error(`JUNTO_OVERLAY=${raw}: expected an overlay checkout with overlay/index.ts`);
  }
  return { kind: "official", dir };
}

/** Alias entries for vite and vitest: the prefix covers `@junto/overlay/renderer`. */
export const overlayAlias = (overlay: ResolvedOverlay): Record<string, string> => ({ [OVERLAY_ALIAS]: overlay.dir });

/**
 * Overlay files live outside this repository, so their bare imports (react,
 * effect, ...) would search the overlay's own tree and find nothing, or a
 * second copy. Resolve them from this app instead: one React, one Effect.
 */
export function overlayDepsPlugin(overlay: ResolvedOverlay, repoRoot = REPO_ROOT): Plugin {
  const inside = overlay.dir + sep;
  const anchor = join(repoRoot, "package.json");
  return {
    name: "junto-overlay-deps",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (overlay.kind === "oss" || !importer?.startsWith(inside)) return null;
      if (/^[./\0]/.test(source) || source.startsWith("@shared") || source.startsWith("@renderer")) return null;
      return this.resolve(source, anchor, { ...options, skipSelf: true });
    },
  };
}

/** The overlay checkout's commit, marked dirty when it has local changes. */
function overlayRevision(dir: string): string {
  const git = (...args: string[]): string =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).stdout?.trim() ?? "";
  const head = git("rev-parse", "--short=12", "HEAD") || "uncommitted";
  return git("status", "--porcelain") === "" ? head : `${head}-dirty`;
}

if (import.meta.main && process.argv.includes("--receipt")) {
  // Package provenance pins this app's commit; the overlay's commit rides here.
  const overlay = resolveOverlay();
  console.log(overlay.kind === "oss" ? "oss (src/overlay-oss)" : `official ${overlayRevision(overlay.dir)} (${overlay.dir})`);
}

/**
 * The overlay's packaging brand (app icon, DMG background) lives in its
 * brand/ directory; an open-source build keeps this repo's neutral mark.
 */
export function overlayBrandDir(overlay: ResolvedOverlay = resolveOverlay()): string | undefined {
  if (overlay.kind === "oss") return undefined;
  const dir = join(overlay.dir, "..", "brand");
  return existsSync(join(dir, "build", "icon.icns")) ? dir : undefined;
}

if (import.meta.main && process.argv.includes("--brand-dir")) {
  const dir = overlayBrandDir();
  if (dir) console.log(dir);
}
