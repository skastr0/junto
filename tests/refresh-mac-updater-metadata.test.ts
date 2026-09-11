import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as typeof import("js-yaml");

const root = join(import.meta.dirname, "..");
const helper = join(root, "scripts", "refresh-mac-updater-metadata.mjs");
const {
  isZipUpdateUrl,
  safeArtifactName,
  updateLatestMacYml,
  zipUrlCandidates,
} = require(helper) as {
  readonly isZipUpdateUrl: (
    url: string,
    candidates: ReadonlySet<string>,
  ) => boolean;
  readonly safeArtifactName: (name: string) => string;
  readonly updateLatestMacYml: (
    ymlIn: string,
    ymlOut: string,
    zipPath: string,
    size: number,
    sha512: string,
  ) => string[];
  readonly zipUrlCandidates: (zipPath: string) => Set<string>;
};
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "vellum-mac-updater-meta.")));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("refresh-mac-updater-metadata helpers", () => {
  it("sanitizes productName spaces the way electron-builder safe names do", () => {
    expect(safeArtifactName("Vellum Command-0.1.0-arm64-mac.zip")).toBe(
      "Vellum-Command-0.1.0-arm64-mac.zip",
    );
    const candidates = zipUrlCandidates("/release/Vellum Command-0.1.0-arm64-mac.zip");
    expect(candidates.has("Vellum Command-0.1.0-arm64-mac.zip")).toBe(true);
    expect(candidates.has("Vellum-Command-0.1.0-arm64-mac.zip")).toBe(true);
    expect(isZipUpdateUrl("Vellum-Command-0.1.0-arm64-mac.zip", candidates)).toBe(true);
    expect(isZipUpdateUrl("Vellum-Command-0.1.0-arm64-mac.dmg", candidates)).toBe(false);
  });

  it("rewrites only zip entries in latest-mac.yml", () => {
    const dir = temporaryRoot();
    const ymlIn = join(dir, "latest-mac.yml");
    const ymlOut = join(dir, "out.yml");
    writeFileSync(
      ymlIn,
      [
        "version: 0.1.0",
        "files:",
        "  - url: Vellum-Command-0.1.0-arm64-mac.zip",
        "    sha512: old-zip",
        "    size: 1",
        "  - url: Vellum-Command-0.1.0-arm64-mac.dmg",
        "    sha512: old-dmg",
        "    size: 2",
        "path: Vellum-Command-0.1.0-arm64-mac.zip",
        "sha512: old-zip",
        "releaseDate: '2026-01-01T00:00:00.000Z'",
        "",
      ].join("\n"),
    );

    const matched = updateLatestMacYml(
      ymlIn,
      ymlOut,
      "/release/Vellum Command-0.1.0-arm64-mac.zip",
      99,
      "new-zip-sha",
    );
    expect(matched).toEqual(["Vellum-Command-0.1.0-arm64-mac.zip"]);

    const doc = yaml.load(readFileSync(ymlOut, "utf8")) as {
      files: Array<{ url: string; sha512: string; size: number }>;
      path: string;
      sha512: string;
    };
    expect(doc.files[0]).toEqual({
      url: "Vellum-Command-0.1.0-arm64-mac.zip",
      sha512: "new-zip-sha",
      size: 99,
    });
    expect(doc.files[1]).toEqual({
      url: "Vellum-Command-0.1.0-arm64-mac.dmg",
      sha512: "old-dmg",
      size: 2,
    });
    expect(doc.sha512).toBe("new-zip-sha");
    expect(doc.path).toBe("Vellum-Command-0.1.0-arm64-mac.zip");
  });

  it("rejects yml with no matching zip entry", () => {
    const dir = temporaryRoot();
    const ymlIn = join(dir, "latest-mac.yml");
    const ymlOut = join(dir, "out.yml");
    writeFileSync(
      ymlIn,
      ["version: 0.1.0", "files:", "  - url: other-mac.dmg", "    sha512: x", "    size: 1", ""].join(
        "\n",
      ),
    );
    expect(() =>
      updateLatestMacYml(ymlIn, ymlOut, "/release/Vellum Command-0.1.0-arm64-mac.zip", 1, "s"),
    ).toThrow(/no zip file entry matching/);
  });
});

describe("refresh-mac-updater-metadata CLI", () => {
  it("runs the TypeScript blockmap generator and rewrites yml against zip bytes", () => {
    const dir = temporaryRoot();
    const blockmapOut = join(dir, "out.blockmap");
    const ymlOut = join(dir, "latest-mac.yml");
    const syntheticZip = join(dir, "Vellum Command-0.1.0-arm64-mac.zip");
    writeFileSync(syntheticZip, Buffer.alloc(64 * 1024, 7));
    const syntheticYml = join(dir, "in.yml");
    writeFileSync(
      syntheticYml,
      [
        "version: 0.1.0",
        "files:",
        "  - url: Vellum-Command-0.1.0-arm64-mac.zip",
        "    sha512: stale",
        "    size: 1",
        "  - url: Vellum-Command-0.1.0-arm64-mac.dmg",
        "    sha512: dmg-stale",
        "    size: 2",
        "path: Vellum-Command-0.1.0-arm64-mac.zip",
        "sha512: stale",
        "releaseDate: '2026-01-01T00:00:00.000Z'",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      [
        helper,
        "--zip",
        syntheticZip,
        "--blockmap-out",
        blockmapOut,
        "--yml-in",
        syntheticYml,
        "--yml-out",
        ymlOut,
      ],
      { encoding: "utf8", cwd: root },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      size: number;
      sha512: string;
      ymlUpdated: boolean;
      matchedUrls: string[];
    };
    expect(payload.ymlUpdated).toBe(true);
    expect(payload.size).toBe(statSync(syntheticZip).size);
    expect(payload.matchedUrls).toEqual(["Vellum-Command-0.1.0-arm64-mac.zip"]);
    expect(statSync(blockmapOut).size).toBeGreaterThan(0);

    const independent = createHash("sha512").update(readFileSync(syntheticZip)).digest("base64");
    expect(payload.sha512).toBe(independent);

    const doc = yaml.load(readFileSync(ymlOut, "utf8")) as {
      files: Array<{ url: string; sha512: string; size: number }>;
      sha512: string;
    };
    expect(doc.files[0].sha512).toBe(independent);
    expect(doc.files[0].size).toBe(payload.size);
    expect(doc.files[1].sha512).toBe("dmg-stale");
    expect(doc.sha512).toBe(independent);

    const zipBefore = readFileSync(syntheticZip);
    const blockmap = gunzipSync(readFileSync(blockmapOut));
    const parsed = JSON.parse(blockmap.toString("utf8")) as {
      version: number;
      files: Array<{ name: string; offset: number; checksums: string[]; sizes: number[] }>;
    };
    expect(Number(parsed.version)).toBe(2);
    expect(parsed.files[0]?.sizes.reduce((sum, size) => sum + size, 0)).toBe(payload.size);
    expect(parsed.files[0]?.checksums.length).toBe(parsed.files[0]?.sizes.length);
    expect(readFileSync(syntheticZip)).toEqual(zipBefore);
  });

  it("rejects adversarial YAML merge-key chains without hanging", () => {
    const dir = temporaryRoot();
    const ymlIn = join(dir, "latest-mac.yml");
    const ymlOut = join(dir, "out.yml");
    const aliases = Array.from({ length: 64 }, (_, index) => `a${index}: &a${index}\n  <<: *a${index === 0 ? "a0" : `a${index - 1}`}`).join("\n");
    writeFileSync(ymlIn, `version: 0.1.0\n${aliases}\nfiles:\n  - url: other.zip\n`);
    const result = spawnSync(
      process.execPath,
      [helper, "--zip", join(dir, "missing.zip"), "--blockmap-out", join(dir, "out.blockmap"), "--yml-in", ymlIn, "--yml-out", ymlOut],
      { encoding: "utf8", cwd: root, timeout: 5_000 },
    );
    expect(result.status).not.toBe(0);
  });

  it("fails closed when the zip is missing", () => {
    const dir = temporaryRoot();
    const result = spawnSync(
      process.execPath,
      [helper, "--zip", join(dir, "missing.zip"), "--blockmap-out", join(dir, "out.blockmap")],
      { encoding: "utf8", cwd: root },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/zip not found/);
  });
});
