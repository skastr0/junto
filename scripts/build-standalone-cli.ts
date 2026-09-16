/**
 * Compile one packaged control CLI with the resolved feature profile.
 *
 * This is deliberately the only public `bun build --compile` path for the
 * packaged control binaries. A bare `bun run cli:build` must mean the same
 * ship profile as `build-app.sh`, not an ambient source-run profile.
 */
import {
  chmodSync,
  mkdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { assertExactCommittedCheckout } from "./package-runtime-provenance";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  featureBunDefineArgs,
  featureViteDefines,
  resolveBuildFeatures,
} from "./build-features";
import { collectStandaloneCliNotices } from "./standalone-cli-notices";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const controls = {
  "junto": {
    source: "src/cli/main.ts",
    output: "dist/junto",
  },
  "junto-dev": {
    source: "src/cli/main.ts",
    output: "dist/junto-dev",
  },
  "junto-desktop-bootstrap-linux-x64": {
    source: "scripts/linux-desktop-bootstrap.ts",
    output: "dist/junto-desktop-bootstrap-linux-x64",
  },
} as const;

export type StandaloneControl = keyof typeof controls;

export const standaloneControlBuild = (
  control: StandaloneControl = "junto",
) => {
  const selected = controls[control];
  const resolvedFeatures = resolveBuildFeatures(process.env);
  return {
    ...selected,
    featureDefines: featureBunDefineArgs(resolvedFeatures),
    defineValues: featureViteDefines(resolvedFeatures),
    profile: resolvedFeatures.profile,
    fingerprint: resolvedFeatures.fingerprint,
  };
};

const main = async (): Promise<void> => {
  const [rawControl, ...extraArgs] = process.argv.slice(2);
  if (!rawControl || extraArgs.length > 0 || !(rawControl in controls)) {
    throw new Error(
      "usage: bun scripts/build-standalone-cli.ts junto|junto-dev|junto-desktop-bootstrap-linux-x64",
    );
  }

  const control = rawControl as StandaloneControl;
  const build = standaloneControlBuild(control);
  const output = resolve(root, build.output);
  const stage = `${output}.new.${process.pid}`;
  const payload = `${output}-relink.js`;
  const payloadStage = `${payload}.new.${process.pid}.js`;
  let sourceCommit: string | null = null;
  try {
    sourceCommit = (await assertExactCommittedCheckout(root)).commit;
  } catch {
    /* Developer builds may use uncommitted source; release binding refuses them. */
  }
  mkdirSync(dirname(output), { recursive: true });

  // Retain the exact application object linked into Bun. Recipients can compile
  // this self-contained payload with their rebuilt runtime without npm packages.
  const bundled = await Bun.build({
    entrypoints: [resolve(root, build.source)],
    target: "bun",
    outdir: dirname(payloadStage),
    naming: basename(payloadStage),
    metafile: true,
    define: build.defineValues,
    plugins: [
      {
        name: "standalone-native-filesystem",
        setup(builder) {
          // @electron/asar also supports Electron's original-fs builtin. This
          // standalone Bun process always uses its ordinary native filesystem.
          builder.onResolve({ filter: /^original-fs$/u }, () => ({
            path: "native-fs",
            namespace: "standalone-native-fs",
          }));
          builder.onLoad(
            { filter: /.*/u, namespace: "standalone-native-fs" },
            () => ({
              contents: 'module.exports = require("node:fs");',
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  if (!bundled.success || bundled.metafile === undefined) {
    for (const log of bundled.logs) process.stderr.write(`${String(log)}\n`);
    throw new Error(`standalone ${control} application bundle failed`);
  }
  const metadata = (
    typeof bundled.metafile === "string"
      ? JSON.parse(bundled.metafile)
      : bundled.metafile
  ) as {
    inputs: Record<string, unknown>;
    outputs: Record<
      string,
      { imports: ReadonlyArray<{ path: string; external?: boolean }> }
    >;
  };
  const outputs = Object.values(metadata.outputs);
  const builtins = new Set(
    builtinModules.flatMap((name) => [name, `node:${name}`]),
  );
  if (
    outputs.length !== 1 ||
    outputs.some((item) =>
      item.imports.some(
        (entry) =>
          entry.external &&
          !builtins.has(entry.path) &&
          entry.path !== "bun" &&
          !entry.path.startsWith("bun:"),
      ),
    )
  ) {
    throw new Error("CLI relink object requires external application files");
  }
  const collected = collectStandaloneCliNotices(
    root,
    Object.keys(metadata.inputs),
  );
  const dependencies = collected.dependencies;
  const notices = [
    "Junto application object\n\n" +
      readFileSync(resolve(root, "LICENSE"), "utf8"),
    ...collected.notices,
  ];
  writeFileSync(
    `${output}-relink-notices.txt`,
    notices.join("\n\n--------------------\n\n"),
  );
  renameSync(payloadStage, payload);
  const result = spawnSync(
    process.execPath,
    [
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "--outfile",
      stage,
      payload,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(
      `standalone ${control} build failed (exit ${String(result.status)})`,
    );
  }

  chmodSync(stage, 0o755);
  renameSync(stage, output);
  const fingerprint = (file: string) => {
    const bytes = readFileSync(file);
    return {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const receipt = {
    schema: "junto/cli-relink/v1",
    sourceCommit,
    bunVersion: Bun.version,
    featureProfile: build.profile,
    featureFingerprint: build.fingerprint,
    payload: fingerprint(payload),
    notices: fingerprint(`${output}-relink-notices.txt`),
    dependencies,
    binary: fingerprint(output),
  };
  writeFileSync(`${output}-relink.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(
    `standalone ${control} build (${build.profile}, ${build.fingerprint}) → ${output}\n`,
  );
};

if (import.meta.main) await main();
