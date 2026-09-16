#!/usr/bin/env bun
/** Assemble corresponding-source materials beside the Linux desktop bootstrap binary. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LINUX_DESKTOP_BOOTSTRAP_VERSION } from "../src/main/vellum-command/update/linux-first-install";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LINUX_DESKTOP_BOOTSTRAP_NAME =
  "vellum-command-desktop-bootstrap-linux-x64";

export const linuxDesktopBootstrapReleaseAssets = (
  version: string = LINUX_DESKTOP_BOOTSTRAP_VERSION,
): readonly string[] => [
  LINUX_DESKTOP_BOOTSTRAP_NAME,
  `${LINUX_DESKTOP_BOOTSTRAP_NAME}.sha256`,
  `${LINUX_DESKTOP_BOOTSTRAP_NAME}.attestation.jsonl`,
  `${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink.js`,
  `${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink.json`,
  `${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink-notices.txt`,
  `${LINUX_DESKTOP_BOOTSTRAP_NAME}-bun-notices.tar.gz`,
  `Junto-linux-desktop-bootstrap-${version}-source.tar.gz`,
  "RELINK.md",
];

const digestFile = (path: string): { readonly bytes: number; readonly sha256: string } => {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
};

export const prepareLinuxDesktopBootstrapRelease = (input: {
  readonly commit: string;
  readonly bunVersion: string;
  readonly distDirectory?: string;
}): {
  readonly assets: readonly string[];
  readonly receipt: Record<string, unknown>;
} => {
  const dist = resolve(input.distDirectory ?? resolve(root, "dist"));
  mkdirSync(dist, { recursive: true });
  const binary = resolve(dist, LINUX_DESKTOP_BOOTSTRAP_NAME);
  const relinkJs = `${binary}-relink.js`;
  const relinkJson = `${binary}-relink.json`;
  const relinkNotices = `${binary}-relink-notices.txt`;
  const receipt = JSON.parse(readFileSync(relinkJson, "utf8")) as Record<string, unknown>;
  if (
    receipt.schema !== "vellum-command/cli-relink/v1" ||
    receipt.sourceCommit !== input.commit ||
    receipt.bunVersion !== input.bunVersion
  ) {
    throw new Error("CLI relink receipt does not match clean release source/runtime");
  }
  const payload = receipt.payload as { bytes: number; sha256: string };
  const notices = receipt.notices as { bytes: number; sha256: string };
  const compiled = receipt.binary as { bytes: number; sha256: string };
  const actualJs = digestFile(relinkJs);
  const actualNotices = digestFile(relinkNotices);
  const actualBinary = digestFile(binary);
  if (
    actualJs.bytes !== payload.bytes || actualJs.sha256 !== payload.sha256 ||
    actualNotices.bytes !== notices.bytes || actualNotices.sha256 !== notices.sha256 ||
    actualBinary.bytes !== compiled.bytes || actualBinary.sha256 !== compiled.sha256
  ) {
    throw new Error("CLI relink material no longer matches the compiled payload");
  }

  const bunNotices = resolve(dist, `${LINUX_DESKTOP_BOOTSTRAP_NAME}-bun-notices.tar.gz`);
  run("tar", [
    "-C",
    resolve(root, "third_party"),
    "--format=ustar",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--sort=name",
    "-czf",
    bunNotices,
    "bun-1.3.13",
  ]);

  const sourceArchive = resolve(
    dist,
    `Junto-linux-desktop-bootstrap-${LINUX_DESKTOP_BOOTSTRAP_VERSION}-source.tar.gz`,
  );
  run("git", [
    "-C",
    root,
    "archive",
    "--format=tar.gz",
    `--prefix=Junto-linux-desktop-bootstrap-${LINUX_DESKTOP_BOOTSTRAP_VERSION}/`,
    `--output=${sourceArchive}`,
    input.commit,
  ]);

  const recipe = `# Rebuilding the Junto Linux desktop bootstrap

This download contains the exact dependency-bundled application object compiled
into bootstrap ${LINUX_DESKTOP_BOOTSTRAP_VERSION}. Its digest, feature profile
and compiler version are recorded in ${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink.json;
application and bundled JavaScript dependency licenses are in
${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink-notices.txt. Native Bun 1.3.13 runtime
notices travel in ${LINUX_DESKTOP_BOOTSTRAP_NAME}-bun-notices.tar.gz. The matching
source tree is Junto-linux-desktop-bootstrap-${LINUX_DESKTOP_BOOTSTRAP_VERSION}-source.tar.gz.

Corresponding Bun/WebKit/TinyCC source archives are not stored in git. From the
extracted source tree, prepare them with:

\`\`\`sh
bun scripts/prepare-runtime-sources.ts --directory /path/to/runtime-sources --cache-dir /path/to/source-cache
\`\`\`

Then follow third_party/bun-1.3.13/README.md to rebuild Bun with changed LGPL
libraries. Using that rebuilt native Bun executable, compile this object:

\`\`\`sh
/path/to/rebuilt/bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig --no-compile-autoload-package-json --outfile ${LINUX_DESKTOP_BOOTSTRAP_NAME} ${LINUX_DESKTOP_BOOTSTRAP_NAME}-relink.js
./${LINUX_DESKTOP_BOOTSTRAP_NAME} --version
\`\`\`

The application-object compile needs no npm packages, repository checkout, or
network access. It uses the running Bun executable as the runtime. This does
not claim byte-identical output or an executed full WebKit rebuild.
`;
  writeFileSync(resolve(dist, "RELINK.md"), recipe);
  writeFileSync(
    `${binary}.sha256`,
    `${actualBinary.sha256}  ${LINUX_DESKTOP_BOOTSTRAP_NAME}\n`,
  );
  return { assets: linuxDesktopBootstrapReleaseAssets(), receipt };
};

if (import.meta.main) {
  const commit = process.env.GITHUB_SHA ??
    spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })
      .stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("bootstrap release requires an exact 40-hex source commit");
  }
  const prepared = prepareLinuxDesktopBootstrapRelease({
    commit,
    bunVersion: "1.3.13",
  });
  process.stdout.write(`${JSON.stringify({
    bootstrapVersion: LINUX_DESKTOP_BOOTSTRAP_VERSION,
    commit,
    assets: prepared.assets,
  })}\n`);
}
