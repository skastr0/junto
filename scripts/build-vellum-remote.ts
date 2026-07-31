/**
 * Bundle the Node-only Linux Remote entry to out/remote/vellum-remote.js.
 *
 * - Target: node (not bun compile, not ELECTRON_RUN_AS_NODE)
 * - electron is external + forbidden in the emitted graph
 * - License channel defines mirror electron-vite main build
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src/main/vellum-remote.ts");
const outDir = join(root, "out/remote");
const outfile = join(outDir, "vellum-remote.js");

const licenseChannel = process.env.VELLUM_LICENSE_CHANNEL ?? "development";
if (!["development", "beta", "production"].includes(licenseChannel)) {
  throw new Error(
    "VELLUM_LICENSE_CHANNEL must be development, beta, or production",
  );
}

const businessId = (process.env.VELLUM_DODO_BUSINESS_ID ?? "").trim();
const productId = (process.env.VELLUM_DODO_PRODUCT_ID ?? "").trim();

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
    "--external=electron",
    `--define=__VELLUM_LICENSE_CHANNEL__=${JSON.stringify(licenseChannel)}`,
    `--define=__VELLUM_DODO_BUSINESS_ID__=${JSON.stringify(businessId)}`,
    `--define=__VELLUM_DODO_PRODUCT_ID__=${JSON.stringify(productId)}`,
    `--define=__VELLUM_MAC_UPDATE_FEED_URL__=${JSON.stringify("")}`,
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

const body = readFileSync(outfile, "utf8");

const forbidden: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /from\s+["']electron["']/u, label: "static electron import" },
  { pattern: /require\s*\(\s*["']electron["']\s*\)/u, label: "require(electron)" },
  { pattern: /\bBrowserWindow\b/u, label: "window-host-symbol" },
  { pattern: /browser-composition/u, label: "browser-composition path" },
  {
    pattern: /from\s+["'][^"']*\/renderer\//u,
    label: "renderer import",
  },
  { pattern: /ELECTRON_RUN_AS_NODE/u, label: "ELECTRON_RUN_AS_NODE" },
];

const hits = forbidden.flatMap(({ pattern, label }) =>
  pattern.test(body) ? [label] : [],
);

if (hits.length > 0) {
  throw new Error(
    `remote:build emitted forbidden symbols: ${hits.join(", ")}`,
  );
}

// Tiny shebang helper for direct node execution in release trees.
const withShebang = body.startsWith("#!")
  ? body
  : `#!/usr/bin/env node\n${body}`;
writeFileSync(outfile, withShebang, { encoding: "utf8", mode: 0o755 });

process.stdout.write(`remote:build → ${outfile}\n`);
