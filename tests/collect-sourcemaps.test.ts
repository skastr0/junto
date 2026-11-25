import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSourceMaps } from "../scripts/collect-sourcemaps";

/**
 * The release keeps every source map as one archive named by version and
 * commit, and refuses to make one that lacks a program (docs/source-maps.md).
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUNDLES = [
  "out/renderer/assets/index-AbCd1234.js",
  "out/preload/index.cjs",
  "out/main/index.js",
  "out/main/core-process.js",
  "out/main/terminal-process.js",
  "out/main/overseer-host.js",
];

describe("collecting a release's source maps", () => {
  let root = "";
  let outDir = "";
  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const build = async (without?: string): Promise<void> => {
    await write("package.json", JSON.stringify({ version: "1.2.3" }));
    await write("out/build-source.json", JSON.stringify({ sourceCommit: COMMIT }));
    for (const bundle of BUNDLES) {
      await write(bundle, `// ${bundle}\n`);
      if (bundle !== without) await write(`${bundle}.map`, `{"version":3,"sources":[],"mappings":""}`);
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-collect-root-"));
    outDir = await mkdtemp(join(tmpdir(), "junto-collect-out-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes one archive named by version and the commit the build came from, with a manifest and every map", async () => {
    await build();
    const { archive, manifest } = collectSourceMaps(root, outDir);
    expect(basename(archive)).toBe("junto-sourcemaps-1.2.3-0123456789ab.tar.gz");
    expect(manifest.commit).toBe(COMMIT);
    expect(manifest.maps.map((entry) => entry.bundle).sort()).toEqual([...BUNDLES].sort());
    expect(manifest.maps.every((entry) => entry.bundleSha256 !== null && entry.mapSha256.length === 64)).toBe(true);
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
    expect(listing).toContain("manifest.json");
    expect(listing).toContain("out/main/core-process.js.map");
    expect(listing).toContain("out/renderer/assets/index-AbCd1234.js.map");
  });

  it("refuses a build in which a program has no map, naming it", async () => {
    await build("out/main/terminal-process.js");
    expect(() => collectSourceMaps(root, outDir)).toThrow(/no source map for: terminal process/u);
  });

  it("never replaces an archive that exists", async () => {
    await build();
    collectSourceMaps(root, outDir);
    expect(() => collectSourceMaps(root, outDir)).toThrow(/already exists/u);
  });
});
