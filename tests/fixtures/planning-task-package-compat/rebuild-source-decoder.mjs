#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const COHORTS = {
  "released-0.1.14": {
    commit: "1719b8d04576fe85332f4a1bbc8eb0d8814c470c",
    tree: "335aef843a3d9a5f34c061dd953e9c8bddfc3be1",
    archiveBytes: 93_102_080,
    archiveSha256: "a9996ccdc16abee320dd003a56e7e205d1c2137bf8e6bdd23dacc8aac6a129ef",
    executableBytes: 779_771,
    executableSha256: "a7314e9ed1a767426f16021c90be5b3709d1d45325e503a8bc95bddb61ada86d",
    compressedBytes: 191_677,
    compressedSha256: "63553944cfafa8ed50add6db0e465dbd0ed04cf8f8faf503a728c9abd48db2bd",
  },
  "unreleased-protocol1-v2": {
    commit: "57571f60ba1d2033ec27dc536a151f60c8fc8e87",
    tree: "7e62be161016a7165184a899c617e3da8f5ba661",
    archiveBytes: 95_160_320,
    archiveSha256: "95c5c94159543a346861c2250fb9e64b948d268aedd691b84cd926cccd0f6ee6",
    executableBytes: 827_815,
    executableSha256: "209389b4c431d1304aaf3518e0a85af6cac561a8f38399f66fcac6f77ae1bf10",
    compressedBytes: 201_175,
    compressedSha256: "48acbc5ae07e4950dd91229084e805fee3d85e2414cbbfb89d526edb19d770f2",
  },
  "current-v3": {
    commit: "e020eb03bd2caf895796f240dc88909983894c8d",
    tree: "76835a52d5372338c788845555ba1fd4751d16b6",
    archiveBytes: 101_806_080,
    archiveSha256: "0e0a6a89b4939e269150fb8a0771e3a5b3ecf553a7d6a269189ebac30c5a50e9",
    executableBytes: 826_433,
    executableSha256: "5e62fd2f5b74f04b67a463245bae7bcdd225c1bde074cd87d6e79477167901f9",
    compressedBytes: 200_949,
    compressedSha256: "72d1d1daad1f864a18374c3adbbf4916d3dd0ed03f7c0c8292a0b510b08ded78",
  },
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(message);
};
const check = (label, bytes, expectedBytes, expectedSha256) => {
  const actual = sha256(bytes);
  if (bytes.byteLength !== expectedBytes || actual !== expectedSha256) {
    fail(
      `${label} mismatch: expected ${expectedSha256}/${expectedBytes}, got ${actual}/${bytes.byteLength}`,
    );
  }
};
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index === -1 || process.argv[index + 1] === undefined) {
    fail(`missing ${flag}`);
  }
  return process.argv[index + 1];
};
const run = (argv, options = {}) => {
  const child = spawnSync(argv[0], argv.slice(1), {
    encoding: options.binary === true ? null : "utf8",
    cwd: options.cwd,
    timeout: options.timeout ?? 300_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  if (child.error !== undefined || child.status !== 0) {
    fail(
      `${argv.join(" ")} failed: ${child.error?.message ?? String(child.stderr)}`,
    );
  }
  return child.stdout;
};

const cohortName = valueAfter("--cohort");
const expected = COHORTS[cohortName];
if (expected === undefined) fail(`unknown cohort: ${cohortName}`);
const projectRoot = resolve(valueAfter("--project-root"));
const outputRoot = resolve(valueAfter("--output-root"));
mkdirSync(outputRoot, { recursive: true });

const tree = run(
  ["git", "rev-parse", `${expected.commit}^{tree}`],
  { cwd: projectRoot },
).trim();
if (tree !== expected.tree) fail(`${cohortName} tree mismatch: ${tree}`);
const archive = run(
  ["git", "archive", "--format=tar", expected.commit],
  {
    cwd: projectRoot,
    binary: true,
    maxBuffer: expected.archiveBytes + 1024,
  },
);
check(
  `${cohortName} git archive`,
  archive,
  expected.archiveBytes,
  expected.archiveSha256,
);

const work = mkdtempSync(join(tmpdir(), "vellum-command-source-rebuild-"));
try {
  const archivePath = join(work, "source.tar");
  const sourceRoot = join(work, "source");
  writeFileSync(archivePath, archive);
  mkdirSync(sourceRoot);
  run(["/usr/bin/tar", "-xf", archivePath, "-C", sourceRoot]);
  copyFileSync(
    join(SCRIPT_ROOT, "qualification-entry.ts.fixture"),
    join(sourceRoot, "qualification-entry.ts"),
  );
  run(
    [
      "mise",
      "x",
      "bun@1.3.13",
      "--",
      "bun",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    { cwd: sourceRoot },
  );

  const builtPath = join(sourceRoot, "qualification-decoder.mjs");
  const build = () =>
    run(
      [
        "mise",
        "x",
        "bun@1.3.13",
        "--",
        "bun",
        "build",
        "qualification-entry.ts",
        "--target=node",
        "--format=esm",
        "--minify",
        "--outfile",
        builtPath,
      ],
      { cwd: sourceRoot },
    );
  build();
  const first = readFileSync(builtPath);
  check(
    `${cohortName} first executable build`,
    first,
    expected.executableBytes,
    expected.executableSha256,
  );
  rmSync(builtPath);
  build();
  const second = readFileSync(builtPath);
  check(
    `${cohortName} repeat executable build`,
    second,
    expected.executableBytes,
    expected.executableSha256,
  );
  if (!first.equals(second)) fail(`${cohortName} repeat build is not byte-identical`);

  const compressed = run(["/usr/bin/gzip", "-9", "-n", "-c", builtPath], {
    binary: true,
    maxBuffer: expected.compressedBytes + 1024,
  });
  if (compressed.byteLength < 10) fail("gzip output is truncated");
  // The original receipt used gzip's portable unknown-OS marker. Normalize
  // only that header byte. The deflate stream and trailer remain untouched.
  compressed[9] = 19;
  check(
    `${cohortName} compressed transport`,
    compressed,
    expected.compressedBytes,
    expected.compressedSha256,
  );
  const output = join(outputRoot, `${cohortName}-decoder.mjs.gz`);
  writeFileSync(output, compressed);
  process.stdout.write(
    `${JSON.stringify({
      cohort: cohortName,
      commit: expected.commit,
      tree,
      archiveSha256: expected.archiveSha256,
      executableSha256: expected.executableSha256,
      repeatBuildByteIdentical: true,
      compressedSha256: expected.compressedSha256,
      output,
    })}\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
