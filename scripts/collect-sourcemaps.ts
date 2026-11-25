#!/usr/bin/env bun
/**
 * Collects the release's source maps into one archive named by version and
 * commit, kept with the release outputs and never inside the app:
 *
 *   bun scripts/collect-sourcemaps.ts --out <dir> [--root <repo>]
 *
 * Writes <dir>/junto-sourcemaps-<version>-<commit12>.tar.gz holding every
 * out/**\/*.map and a manifest.json (version, commit, and for each map the
 * bundle it maps, with both hashes). It refuses to run when a program has no
 * map (the window, the preload, main, the core process, the terminal process,
 * the overseer host), and never replaces an archive that exists. The commit is
 * the one out/ was built from (out/build-source.json), else HEAD. To map a
 * logged bundle line back to source: scripts/sourcemap-resolve.ts, docs/source-maps.md.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The programs a release builds, and the one bundle of each that must have a map. */
export const PROGRAM_BUNDLES: ReadonlyArray<{ readonly program: string; readonly bundle: RegExp }> = [
  { program: "window", bundle: /^out\/renderer\/assets\/index-[^/]+\.js$/u },
  { program: "preload", bundle: /^out\/preload\/index\.cjs$/u },
  { program: "main", bundle: /^out\/main\/index\.js$/u },
  { program: "core process", bundle: /^out\/main\/core-process\.js$/u },
  { program: "terminal process", bundle: /^out\/main\/terminal-process\.js$/u },
  { program: "overseer host", bundle: /^out\/main\/overseer-host\.js$/u },
];

export type ManifestEntry = {
  readonly map: string;
  readonly mapBytes: number;
  readonly mapSha256: string;
  readonly bundle: string;
  readonly bundleSha256: string | null;
};

export type Manifest = {
  readonly schema: "junto/source-maps/v1";
  readonly version: string;
  readonly commit: string;
  readonly collectedAt: string;
  readonly maps: ReadonlyArray<ManifestEntry>;
};

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const walk = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

const builtCommit = (root: string): string => {
  const stamp = join(root, "out/build-source.json");
  if (existsSync(stamp)) {
    const commit = (JSON.parse(readFileSync(stamp, "utf8")) as { sourceCommit?: unknown }).sourceCommit;
    if (typeof commit === "string" && /^[0-9a-f]{40}$/u.test(commit)) return commit;
  }
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) throw new Error("no commit: out/build-source.json has none and git rev-parse HEAD failed");
  return head.stdout.trim();
};

export const collectSourceMaps = (root: string, outDir: string): { readonly archive: string; readonly manifest: Manifest } => {
  const outRoot = join(root, "out");
  if (!existsSync(outRoot)) throw new Error(`no out/ under ${root}: build first (bun run build:bundles)`);
  const maps = walk(outRoot)
    .filter((file) => file.endsWith(".map"))
    .map((file) => relative(root, file).split("\\").join("/"))
    .sort();
  const missing = PROGRAM_BUNDLES.filter(({ bundle }) => !maps.some((map) => bundle.test(map.slice(0, -".map".length))));
  if (missing.length > 0) throw new Error(`no source map for: ${missing.map(({ program }) => program).join(", ")}`);

  const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const commit = builtCommit(root);
  const archive = join(outDir, `junto-sourcemaps-${version}-${commit.slice(0, 12)}.tar.gz`);
  if (existsSync(archive)) throw new Error(`${archive} already exists; a release archive is never replaced`);

  const entries: ManifestEntry[] = maps.map((map) => {
    const bundle = map.slice(0, -".map".length);
    const bundlePath = join(root, bundle);
    return {
      map,
      mapBytes: statSync(join(root, map)).size,
      mapSha256: sha256(join(root, map)),
      bundle,
      bundleSha256: existsSync(bundlePath) ? sha256(bundlePath) : null,
    };
  });
  const manifest: Manifest = { schema: "junto/source-maps/v1", version, commit, collectedAt: new Date().toISOString(), maps: entries };

  const stage = mkdtempSync(join(tmpdir(), "junto-sourcemaps-"));
  try {
    for (const map of maps) {
      mkdirSync(dirname(join(stage, map)), { recursive: true });
      cpSync(join(root, map), join(stage, map));
    }
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(outDir, { recursive: true });
    const tar = spawnSync("tar", ["-czf", archive, "-C", stage, "manifest.json", "out"], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return { archive, manifest };
};

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const outDir = flag("--out");
  if (outDir === undefined) {
    console.error("usage: bun scripts/collect-sourcemaps.ts --out <dir> [--root <repo>]");
    process.exitCode = 2;
  } else {
    try {
      const { archive, manifest } = collectSourceMaps(resolve(flag("--root") ?? join(dirname(modulePath), "..")), resolve(outDir));
      console.log(`junto: source maps ${basename(archive)}: ${String(manifest.maps.length)} maps, commit ${manifest.commit.slice(0, 12)}, version ${manifest.version}`);
      console.log(archive);
    } catch (error) {
      console.error(`junto: error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
