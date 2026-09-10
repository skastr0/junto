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
  existsSync,
  unlinkSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { assertExactCommittedCheckout } from "./package-runtime-provenance";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { featureBunDefineArgs, resolveBuildFeatures } from "./build-features";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const controls = {
  "vellum-command": {
    source: "src/cli/main.ts",
    output: "dist/vellum-command",
  },
  "vellum-command-dev": {
    source: "src/cli/main.ts",
    output: "dist/vellum-command-dev",
  },
} as const;

export type StandaloneControl = keyof typeof controls;

export const standaloneControlBuild = (
  control: StandaloneControl = "vellum-command",
) => {
  const selected = controls[control];
  const resolvedFeatures = resolveBuildFeatures(process.env);
  return {
    ...selected,
    featureDefines: featureBunDefineArgs(resolvedFeatures),
    profile: resolvedFeatures.profile,
    fingerprint: resolvedFeatures.fingerprint,
  };
};

const main = async (): Promise<void> => {
  const [rawControl, ...extraArgs] = process.argv.slice(2);
  if (!rawControl || extraArgs.length > 0 || !(rawControl in controls)) {
    throw new Error(
      "usage: bun scripts/build-standalone-cli.ts vellum-command|vellum-command-dev",
    );
  }

  const control = rawControl as StandaloneControl;
  const build = standaloneControlBuild(control);
  const output = resolve(root, build.output);
  const stage = `${output}.new.${process.pid}`;
  const payload = `${output}-relink.js`;
  const payloadStage = `${payload}.new.${process.pid}.js`;
  const metadataStage = `${payload}.meta.${process.pid}.json`;
  let sourceCommit: string | null = null;
  try {
    sourceCommit = (await assertExactCommittedCheckout(root)).commit;
  } catch {
    /* Developer builds may use uncommitted source; release binding refuses them. */
  }
  mkdirSync(dirname(output), { recursive: true });

  // Retain the exact application object linked into Bun. Recipients can compile
  // this self-contained payload with their rebuilt runtime without npm packages.
  const bundled = spawnSync(
    process.execPath,
    [
      "build",
      "--target=bun",
      `--metafile=${metadataStage}`,
      ...build.featureDefines,
      "--outfile",
      payloadStage,
      resolve(root, build.source),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (bundled.status !== 0)
    throw new Error(`standalone ${control} application bundle failed`);
  const metadata = JSON.parse(readFileSync(metadataStage, "utf8")) as {
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
  const dependencies = [
    ...new Set(
      Object.keys(metadata.inputs)
        .filter((file) => file.includes("node_modules/"))
        .map((file) => {
          const relative = file.split("node_modules/").at(-1)!;
          const parts = relative.split("/");
          return parts[0]!.startsWith("@")
            ? parts.slice(0, 2).join("/")
            : parts[0]!;
        }),
    ),
  ].sort();
  const notices = [
    "Vellum Command application object\n\n" +
      readFileSync(resolve(root, "LICENSE"), "utf8"),
  ];
  for (const dependency of dependencies) {
    const directory = resolve(root, "node_modules", dependency);
    const pkg = JSON.parse(
      readFileSync(resolve(directory, "package.json"), "utf8"),
    ) as { name: string; version: string };
    const license = [
      "LICENSE",
      "LICENSE.md",
      "LICENSE.txt",
      "license",
      "license.md",
    ]
      .map((name) => resolve(directory, name))
      .find(existsSync);
    if (license === undefined)
      throw new Error(
        `bundled CLI dependency lacks a retained license: ${dependency}`,
      );
    notices.push(
      `${pkg.name}@${pkg.version}\n\n${readFileSync(license, "utf8")}`,
    );
  }
  writeFileSync(
    `${output}-relink-notices.txt`,
    notices.join("\n\n--------------------\n\n"),
  );
  unlinkSync(metadataStage);
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
    schema: "vellum-command/cli-relink/v1",
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
