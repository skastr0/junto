/**
 * Bundle the Node-only Linux Remote entry to out/remote/vellum-command-remote.js.
 *
 * - Target: node (not bun compile, not ELECTRON_RUN_AS_NODE)
 * - electron is external; deploy-darwin/linux stay external (CC-only providers)
 * - Forbidden: load-time electron import, BrowserWindow, renderer, browser composition
 * - License channel defines mirror electron-vite main build
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PRODUCTION_LICENSE_BUILD_PROFILE } from "./license-build-profile";
import {
  featureBunDefineArgs,
  resolveBuildFeatures,
} from "./build-features";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src/main/vellum-remote.ts");
const outDir = join(root, "out/remote");
const outfile = join(outDir, "vellum-command-remote.js");

if (
  process.env.VELLUM_COMMAND_LICENSE_CHANNEL !== undefined &&
  process.env.VELLUM_COMMAND_LICENSE_CHANNEL !== "production"
) {
  throw new Error(
    "remote packaging requires VELLUM_COMMAND_LICENSE_CHANNEL=production",
  );
}
const appVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  .version as string;
const resolvedBuildFeatures = resolveBuildFeatures(process.env);

mkdirSync(outDir, { recursive: true });

const result = spawnSync(
  "bun",
  [
    "build",
    entry,
    "--target=node",
    "--format=esm",
    `--outfile=${outfile}`,
    "--packages=bundle",
    // Never ship Electron into the Node Remote process.
    "--external=electron",
    `--define=__VELLUM_COMMAND_LICENSE_CHANNEL__=${JSON.stringify(PRODUCTION_LICENSE_BUILD_PROFILE.channel)}`,
    `--define=__VELLUM_COMMAND_DODO_BUSINESS_ID__=${JSON.stringify(PRODUCTION_LICENSE_BUILD_PROFILE.businessId)}`,
    `--define=__VELLUM_COMMAND_DODO_PRODUCT_ID__=${JSON.stringify(PRODUCTION_LICENSE_BUILD_PROFILE.productId)}`,
    `--define=__VELLUM_COMMAND_MAC_UPDATE_FEED_URL__=${JSON.stringify("")}`,
    `--define=__VELLUM_COMMAND_APP_VERSION__=${JSON.stringify(appVersion)}`,
    ...featureBunDefineArgs(resolvedBuildFeatures),
  ],
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

if (result.status !== 0) {
  process.stderr.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  throw new Error(
    `remote:build failed (exit ${String(result.status)}): ${
      result.stderr?.trim() || result.stdout?.trim() || "unknown"
    }`,
  );
}

let body = readFileSync(outfile, "utf8");

// CC-only deploy helpers may still contain a lazy try/require("electron") for
// macOS app provenance. Rewrite every residual require so the Node Remote never
// resolves the electron package (even inside an unreachable branch).
body = body.replace(
  /(?:__require|require)\s*\(\s*["']electron["']\s*\)/gu,
  '(() => { throw new Error("electron is forbidden in vellum-command-remote"); })()',
);
// ESM external imports that slipped through (should be none after graph trim).
if (/(?:^|\n)\s*import\s+[^;]*\bfrom\s+["']electron["']/u.test(body)) {
  throw new Error("remote:build retained a static electron import");
}

writeFileSync(outfile, body, { encoding: "utf8" });
body = readFileSync(outfile, "utf8");

const forbidden: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
}> = [
  {
    pattern: /(?:^|\n)\s*import\s+[^;]*\bfrom\s+["']electron["']/u,
    label: "static electron import",
  },
  {
    pattern: /(?:__require|require)\s*\(\s*["']electron["']\s*\)/u,
    label: "require(electron)",
  },
  { pattern: /\bBrowserWindow\b/u, label: "BrowserWindow" },
  {
    pattern: /startBrowserComposition|browser\/composition(?:-host)?/u,
    label: "browser-composition",
  },
  {
    pattern: /from\s+["'][^"']*\/renderer\/[^"']+["']/u,
    label: "renderer import",
  },
  {
    // Product process must never opt into ELECTRON_RUN_AS_NODE.
    pattern: /ELECTRON_RUN_AS_NODE\s*=\s*["']?1/u,
    label: "ELECTRON_RUN_AS_NODE=1",
  },
];

const hits = forbidden.flatMap(({ pattern, label }) =>
  pattern.test(body) ? [label] : [],
);

if (hits.length > 0) {
  throw new Error(`remote:build emitted forbidden symbols: ${hits.join(", ")}`);
}

const withShebang = body.startsWith("#!")
  ? body
  : `#!/usr/bin/env node\n${body}`;
writeFileSync(outfile, withShebang, { encoding: "utf8", mode: 0o755 });

process.stdout.write(`remote:build → ${outfile}\n`);
