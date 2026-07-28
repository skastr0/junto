#!/usr/bin/env node
/**
 * Regenerate electron-builder updater metadata for a final macOS zip.
 *
 * After notarize-app.sh staples the .app and re-zips, the pre-staple
 * `.zip.blockmap` and `latest-mac.yml` still describe the old archive bytes.
 * This helper rebuilds both from the final zip using app-builder's blockmap
 * tool (same codec electron-builder uses).
 *
 * Writes ONLY to the staged output paths — never mutates release/ in place.
 *
 *   node scripts/refresh-mac-updater-metadata.mjs \
 *     --zip /path/to/final.zip \
 *     --blockmap-out /stage/final.zip.blockmap \
 *     [--yml-in /path/to/latest-mac.yml --yml-out /stage/latest-mac.yml] \
 *     [--app-builder /path/to/app-builder]
 *
 * stdout: JSON { size, sha512, blockmapOut, ymlUpdated, ymlOut?, matchedUrls }
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function usage(exitCode = 0) {
  process.stderr.write(
    "usage: refresh-mac-updater-metadata.mjs --zip PATH --blockmap-out PATH [--yml-in PATH --yml-out PATH] [--app-builder PATH]\n",
  );
  process.exit(exitCode);
}

function fail(message) {
  throw new Error(message);
}

function die(message) {
  process.stderr.write(`vellum: error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage(0);
    if (!arg.startsWith("--")) fail(`unknown argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (value == null || value.startsWith("--")) fail(`missing value for --${key}`);
    out[key] = value;
  }
  return out;
}

function assertAbsoluteNonEmpty(label, value) {
  if (!value || !isAbsolute(value) || value.includes("\0")) {
    fail(`${label} must be an absolute path`);
  }
}

function safeArtifactName(name) {
  // electron-builder / builder-util sanitizeFileName: spaces and unsafe → '-'
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, "-");
}

function zipUrlCandidates(zipPath) {
  const base = basename(zipPath);
  const safe = safeArtifactName(base);
  const set = new Set([base, safe]);
  return set;
}

function isZipUpdateUrl(url, candidates) {
  if (typeof url !== "string" || !url.endsWith(".zip")) return false;
  if (candidates.has(url) || candidates.has(basename(url))) return true;
  // Tolerate path-style urls and productName spacing variants.
  const leaf = basename(url);
  const leafSafe = safeArtifactName(leaf);
  for (const c of candidates) {
    if (leaf === c || leafSafe === c || leafSafe === safeArtifactName(c)) return true;
  }
  return false;
}

function resolveAppBuilder(explicit) {
  if (explicit) {
    assertAbsoluteNonEmpty("app-builder", explicit);
    if (!existsSync(explicit)) fail(`app-builder not found: ${explicit}`);
    return explicit;
  }
  try {
    const mod = require("app-builder-bin");
    const path = mod.appBuilderPath || mod;
    if (typeof path === "string" && existsSync(path)) return path;
  } catch {
    // fall through
  }
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const candidates = [
    join(repoRoot, "node_modules/app-builder-bin/mac/app-builder"),
    join(repoRoot, `node_modules/app-builder-bin/mac/app-builder_${arch}`),
    join(repoRoot, "node_modules/app-builder-bin/mac/app-builder_arm64"),
    join(repoRoot, "node_modules/app-builder-bin/mac/app-builder_amd64"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  fail("could not resolve app-builder binary (install electron-builder deps)");
}

function hashFileSha512Base64(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha512");
    createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on("error", reject)
      .on("data", (chunk) => {
        hash.update(chunk);
      })
      .on("end", () => resolveHash(hash.digest("base64")));
  });
}

function runBlockmap(appBuilder, zipPath, blockmapOut) {
  const result = spawnSync(
    appBuilder,
    ["blockmap", "--input", zipPath, "--output", blockmapOut],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    fail(
      `app-builder blockmap failed (exit ${result.status}): ${result.stderr || result.stdout || ""}`.trim(),
    );
  }
  const raw = (result.stdout || "").trim();
  if (!raw) fail("app-builder blockmap produced empty stdout");
  let info;
  try {
    info = JSON.parse(raw);
  } catch (e) {
    fail(`app-builder blockmap stdout is not JSON: ${raw.slice(0, 200)}`);
  }
  if (typeof info.size !== "number" || typeof info.sha512 !== "string" || !info.sha512) {
    fail("app-builder blockmap JSON missing size/sha512");
  }
  if (!existsSync(blockmapOut)) fail(`blockmap output missing: ${blockmapOut}`);
  return info;
}

function loadYaml(path) {
  let yaml;
  try {
    yaml = require("js-yaml");
  } catch {
    fail("js-yaml is required to rewrite latest-mac.yml");
  }
  const text = readFileSync(path, "utf8");
  const doc = yaml.load(text);
  if (doc == null || typeof doc !== "object" || Array.isArray(doc)) {
    fail("latest-mac.yml must be a YAML mapping");
  }
  return { yaml, doc };
}

function updateLatestMacYml(ymlIn, ymlOut, zipPath, size, sha512) {
  const { yaml, doc } = loadYaml(ymlIn);
  const candidates = zipUrlCandidates(zipPath);
  const matchedUrls = [];

  if (!Array.isArray(doc.files)) {
    fail("latest-mac.yml missing files[]");
  }

  for (const entry of doc.files) {
    if (entry == null || typeof entry !== "object") continue;
    if (!isZipUpdateUrl(entry.url, candidates)) continue;
    entry.sha512 = sha512;
    entry.size = size;
    matchedUrls.push(String(entry.url));
  }

  if (matchedUrls.length === 0) {
    fail(
      `latest-mac.yml has no zip file entry matching ${basename(zipPath)} (or sanitized name)`,
    );
  }

  // Backward-compat top-level path/sha512 describe the primary (zip) artifact.
  if (typeof doc.path === "string" && isZipUpdateUrl(doc.path, candidates)) {
    doc.sha512 = sha512;
    if ("size" in doc) doc.size = size;
  } else if (matchedUrls.length > 0 && typeof doc.sha512 === "string") {
    // path may use a safe name already matched via files[]; keep top-level sha in sync
    // when path is the primary zip-like artifact.
    if (typeof doc.path === "string" && String(doc.path).endsWith(".zip")) {
      doc.sha512 = sha512;
      if ("size" in doc) doc.size = size;
    }
  }

  const dumped = yaml.dump(doc, {
    lineWidth: -1,
    noRefs: true,
    sortingKeys: false,
  });
  writeFileSync(ymlOut, dumped, "utf8");
  return matchedUrls;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const zipPath = args.zip;
  const blockmapOut = args["blockmap-out"];
  const ymlIn = args["yml-in"];
  const ymlOut = args["yml-out"];
  const appBuilderArg = args["app-builder"];

  if (!zipPath || !blockmapOut) usage(1);
  assertAbsoluteNonEmpty("zip", zipPath);
  assertAbsoluteNonEmpty("blockmap-out", blockmapOut);
  if (!existsSync(zipPath)) fail(`zip not found: ${zipPath}`);

  if ((ymlIn && !ymlOut) || (!ymlIn && ymlOut)) {
    fail("--yml-in and --yml-out must be provided together");
  }
  if (ymlIn) {
    assertAbsoluteNonEmpty("yml-in", ymlIn);
    assertAbsoluteNonEmpty("yml-out", ymlOut);
    if (!existsSync(ymlIn)) fail(`yml-in not found: ${ymlIn}`);
  }

  const appBuilder = resolveAppBuilder(appBuilderArg);
  const info = runBlockmap(appBuilder, zipPath, blockmapOut);

  // Defense in depth: recompute sha512 from the zip and require agreement.
  const independentSha = await hashFileSha512Base64(zipPath);
  if (independentSha !== info.sha512) {
    fail("app-builder sha512 disagrees with independent zip hash");
  }

  let ymlUpdated = false;
  /** @type {string[]} */
  let matchedUrls = [];
  if (ymlIn && ymlOut) {
    matchedUrls = updateLatestMacYml(ymlIn, ymlOut, zipPath, info.size, info.sha512);
    ymlUpdated = true;
  }

  process.stdout.write(
    `${JSON.stringify({
      size: info.size,
      sha512: info.sha512,
      blockmapOut,
      ymlUpdated,
      ymlOut: ymlUpdated ? ymlOut : null,
      matchedUrls,
      appBuilder,
    })}\n`,
  );
}

// Export pure helpers for unit tests (same file, no second source of truth).
export {
  safeArtifactName,
  zipUrlCandidates,
  isZipUpdateUrl,
  updateLatestMacYml,
  hashFileSha512Base64,
};

const isDirect =
  process.argv[1] != null &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  main().catch((err) => {
    die(err instanceof Error ? err.message : String(err));
  });
}
