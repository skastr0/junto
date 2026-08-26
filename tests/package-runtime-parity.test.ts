import { createPackage } from "@electron/asar";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAIN_PROVENANCE_SOURCE_RELATIVE,
  PACKAGE_RUNTIME_PROVENANCE_SCHEMA,
  REMOTE_PROVENANCE_SOURCE_RELATIVE,
  makePackageRuntimeProvenance,
  preparePackageRuntimes,
  readPackageSourceFacts,
  resetOwnedRemoteOutput,
  verifyPackagedRuntimeParity,
  verifyPreparedPackageRuntimes,
  type PackageSourceFacts,
} from "../scripts/package-runtime-provenance";
import {
  HISTORICAL_COMPARISON_RELATIVE,
  loadHistoricalPackageComparison,
  plantHistoricalStaleRemote,
} from "../scripts/qualify-package-runtime-parity";
import { REMOTE_ENTRY_SOURCE_RELATIVE } from "../scripts/build-linux-remote-runtime";

const repoRoot = path.resolve(import.meta.dirname, "..");
const source: PackageSourceFacts = {
  appVersion: "0.1.14",
  sourceCommit: "a".repeat(40),
  currentStateSchemaVersion: 20,
  migrationHead: {
    fromVersion: 19,
    toVersion: 20,
    name: "witness-every-projected-work-table",
  },
  migrationIdentitySha256:
    "b545aa0771810a631eeeea9f7b642467e6cca327ba74392298457aab1cec1955",
};

const writeProvenance = async (input: {
  readonly runtime: "electron-main" | "linux-remote";
  readonly payload: Buffer;
  readonly file: string;
  readonly facts?: PackageSourceFacts;
}): Promise<void> => {
  const provenance = makePackageRuntimeProvenance({
    runtime: input.runtime,
    source: input.facts ?? source,
    payload: input.payload,
  });
  await mkdir(path.dirname(input.file), { recursive: true });
  await writeFile(input.file, `${JSON.stringify(provenance, null, 2)}\n`);
};

const createSyntheticLinuxRuntime = async (input: {
  readonly root: string;
  readonly includeAsarRemote?: boolean;
  readonly remoteFacts?: PackageSourceFacts;
}): Promise<{
  readonly runtimeRoot: string;
  readonly mainPayload: Buffer;
  readonly remotePayload: Buffer;
}> => {
  const appStage = path.join(input.root, "app-stage");
  const runtimeRoot = path.join(input.root, "runtime");
  const mainPayload = Buffer.from("console.log('schema-20-main');\n");
  const remotePayload = Buffer.from("console.log('schema-20-remote');\n");
  await mkdir(path.join(appStage, "out/main"), { recursive: true });
  await writeFile(path.join(appStage, "out/main/index.js"), mainPayload);
  await writeFile(
    path.join(appStage, "package.json"),
    `${JSON.stringify({ name: "fixture", version: source.appVersion })}\n`,
  );
  await writeProvenance({
    runtime: "electron-main",
    payload: mainPayload,
    file: path.join(appStage, MAIN_PROVENANCE_SOURCE_RELATIVE),
  });
  if (input.includeAsarRemote === true) {
    await mkdir(path.join(appStage, "out/remote"), { recursive: true });
    await writeFile(
      path.join(appStage, "out/remote/vellum-command-remote.js"),
      "stale Remote must not be in app.asar\n",
    );
  }
  await mkdir(path.join(runtimeRoot, "resources/app-remote"), {
    recursive: true,
  });
  await createPackage(appStage, path.join(runtimeRoot, "resources/app.asar"));
  await writeFile(
    path.join(
      runtimeRoot,
      "resources/app-remote/vellum-command-remote.js",
    ),
    remotePayload,
  );
  await writeProvenance({
    runtime: "linux-remote",
    payload: remotePayload,
    file: path.join(
      runtimeRoot,
      "resources/app-remote/package-runtime-provenance.json",
    ),
    facts: input.remoteFacts,
  });
  return { runtimeRoot, mainPayload, remotePayload };
};

describe("package runtime source provenance", () => {
  it("reads schema 20, its final migration, identity, app version, and commit", async () => {
    const facts = await readPackageSourceFacts({
      repoRoot,
      requireClean: false,
    });
    expect(facts).toMatchObject({
      appVersion: "0.1.14",
      currentStateSchemaVersion: 20,
      migrationHead: {
        fromVersion: 19,
        toVersion: 20,
        name: "witness-every-projected-work-table",
      },
      migrationIdentitySha256:
        "b545aa0771810a631eeeea9f7b642467e6cca327ba74392298457aab1cec1955",
    });
    expect(facts.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("binds every manifest to the exact payload hash", () => {
    const payload = Buffer.from("runtime bytes\n");
    const provenance = makePackageRuntimeProvenance({
      runtime: "electron-main",
      source,
      payload,
    });
    expect(provenance).toMatchObject({
      schema: PACKAGE_RUNTIME_PROVENANCE_SCHEMA,
      product: "Vellum Command",
      runtime: "electron-main",
      appVersion: source.appVersion,
      sourceCommit: source.sourceCommit,
      state: {
        currentStateSchemaVersion: 20,
        migrationHead: source.migrationHead,
        migrationIdentitySha256: source.migrationIdentitySha256,
      },
      payload: {
        packagedPath: "out/main/index.js",
        bytes: payload.byteLength,
      },
    });
    expect(provenance.payload.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("removes only the Remote output directory and refuses a symlink", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "vellum-command-package-owned-output-"),
    );
    try {
      await mkdir(path.join(root, "out/remote"), { recursive: true });
      await writeFile(path.join(root, "out/remote/stale"), "schema 18\n");
      await writeFile(path.join(root, "out/main-sibling"), "keep\n");
      await resetOwnedRemoteOutput(root);
      await expect(
        readFile(path.join(root, "out/main-sibling"), "utf8"),
      ).resolves.toBe("keep\n");
      expect(await lstat(path.join(root, "out/remote"))).toMatchObject({});
      expect(
        await readFile(path.join(root, "out/remote/stale")).catch(
          () => undefined,
        ),
      ).toBeUndefined();

      await rm(path.join(root, "out/remote"), { recursive: true });
      await writeFile(path.join(root, "outside"), "do not touch\n");
      await symlink(path.join(root, "outside"), path.join(root, "out/remote"));
      await expect(resetOwnedRemoteOutput(root)).rejects.toThrow(/symlink/u);
      await expect(readFile(path.join(root, "outside"), "utf8")).resolves.toBe(
        "do not touch\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prepares main and a freshly rebuilt Remote while preserving siblings", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "vellum-command-package-prepare-"),
    );
    try {
      await mkdir(path.join(root, "out/main"), { recursive: true });
      await mkdir(path.join(root, "out/remote"), { recursive: true });
      await writeFile(path.join(root, "out/main/index.js"), "main fresh\n");
      await writeFile(path.join(root, "out/remote/old"), "schema 18\n");
      await writeFile(path.join(root, "out/sibling"), "keep\n");
      let oldWasRemoved = false;
      await preparePackageRuntimes({
        repoRoot: root,
        target: "linux",
        source,
        buildRemote: async (candidateRoot) => {
          oldWasRemoved = !(await lstat(
            path.join(candidateRoot, "out/remote/old"),
          ).catch(() => undefined));
          await writeFile(
            path.join(candidateRoot, REMOTE_ENTRY_SOURCE_RELATIVE),
            "remote fresh schema 20\n",
          );
        },
      });
      expect(oldWasRemoved).toBe(true);
      await expect(readFile(path.join(root, "out/sibling"), "utf8")).resolves.toBe(
        "keep\n",
      );
      const verified = await verifyPreparedPackageRuntimes({
        repoRoot: root,
        target: "linux",
        expected: source,
      });
      expect(verified.runtimes.electronMain.payloadSha256).not.toBe(
        verified.runtimes.linuxRemote?.payloadSha256,
      );
      await expect(
        readFile(path.join(root, REMOTE_PROVENANCE_SOURCE_RELATIVE), "utf8"),
      ).resolves.toContain('"currentStateSchemaVersion": 20');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("extracted package runtime parity", () => {
  it("accepts two payload-bound runtimes from one schema-20 source cohort", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "vellum-command-package-parity-"),
    );
    try {
      const candidate = await createSyntheticLinuxRuntime({ root });
      const receipt = await verifyPackagedRuntimeParity({
        repoRoot: root,
        target: "linux",
        runtimeRoot: candidate.runtimeRoot,
        expected: source,
      });
      expect(receipt).toMatchObject({
        target: "linux",
        appVersion: source.appVersion,
        sourceCommit: source.sourceCommit,
        state: {
          currentStateSchemaVersion: 20,
          migrationHead: source.migrationHead,
          migrationIdentitySha256: source.migrationIdentitySha256,
        },
      });
      expect(receipt.runtimes.electronMain.payloadBytes).toBe(
        candidate.mainPayload.byteLength,
      );
      expect(receipt.runtimes.linuxRemote?.payloadBytes).toBe(
        candidate.remotePayload.byteLength,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a schema-18 Remote even when its payload hash is internally valid", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "vellum-command-package-mismatch-"),
    );
    try {
      const candidate = await createSyntheticLinuxRuntime({
        root,
        remoteFacts: {
          ...source,
          currentStateSchemaVersion: 18,
          migrationHead: {
            fromVersion: 17,
            toVersion: 18,
            name: "add-work-pad-read-cursors",
          },
          migrationIdentitySha256:
            "06411da7eb2843c89a7b170321ca0992e8c72b9da65e3fa702b2fce1197980e1",
        },
      });
      await expect(
        verifyPackagedRuntimeParity({
          repoRoot: root,
          target: "linux",
          runtimeRoot: candidate.runtimeRoot,
          expected: source,
        }),
      ).rejects.toThrow(/does not match package source/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects any Remote bundle leaked into Electron app.asar", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "vellum-command-package-asar-remote-"),
    );
    try {
      const candidate = await createSyntheticLinuxRuntime({
        root,
        includeAsarRemote: true,
      });
      await expect(
        verifyPackagedRuntimeParity({
          repoRoot: root,
          target: "linux",
          runtimeRoot: candidate.runtimeRoot,
          expected: source,
        }),
      ).rejects.toThrow(/must exclude the Remote runtime/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("stale Remote qualification probe", () => {
  it("pins public 0.1.14 schema 18 only as hash-checked history", async () => {
    const historical = await loadHistoricalPackageComparison(repoRoot);
    expect(historical.comparison).toMatchObject({
      classification: "historical-comparison-only",
      product: "Vellum Command",
      release: {
        appVersion: "0.1.14",
        currentStateSchemaVersion: 18,
        migrationHead: {
          fromVersion: 17,
          toVersion: 18,
          name: "add-work-pad-read-cursors",
        },
        migrationIdentitySha256:
          "06411da7eb2843c89a7b170321ca0992e8c72b9da65e3fa702b2fce1197980e1",
      },
    });
    expect(historical.fixtureSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(HISTORICAL_COMPARISON_RELATIVE).toContain("historical");
    expect(historical.comparison.constraint).toContain(
      "does not claim that the public macOS package carried a Linux Remote payload",
    );
  });

  it("plants a plausible ignored schema-18 bundle for replacement proof", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "vellum-command-package-stale-probe-"),
    );
    try {
      const historical = await loadHistoricalPackageComparison(repoRoot);
      const planted = await plantHistoricalStaleRemote({
        repoRoot: root,
        comparison: historical.comparison,
      });
      expect(planted).toMatchObject({
        appVersion: "0.1.14",
        currentStateSchemaVersion: 18,
      });
      expect(planted.payloadSha256).toMatch(/^[0-9a-f]{64}$/u);
      await expect(
        readFile(path.join(root, REMOTE_ENTRY_SOURCE_RELATIVE), "utf8"),
      ).resolves.toContain("CURRENT_STATE_SCHEMA_VERSION = 18");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wires every official package path through fresh provenance", async () => {
    const [
      pkgBody,
      buildApp,
      macPackage,
      linuxPackage,
      remoteBuilder,
      remoteCommand,
      qualifier,
    ] = await Promise.all([
      readFile(path.join(repoRoot, "package.json"), "utf8"),
      readFile(path.join(repoRoot, "scripts/build-app.sh"), "utf8"),
      readFile(path.join(repoRoot, "scripts/package-app-macos.sh"), "utf8"),
      readFile(path.join(repoRoot, "scripts/package-app-linux.sh"), "utf8"),
      readFile(
        path.join(repoRoot, "scripts/build-linux-remote-runtime.ts"),
        "utf8",
      ),
      readFile(path.join(repoRoot, "scripts/build-vellum-remote.ts"), "utf8"),
      readFile(
        path.join(repoRoot, "scripts/qualify-package-runtime-parity.ts"),
        "utf8",
      ),
    ]);
    const pkg = JSON.parse(pkgBody) as {
      readonly build: {
        readonly files: ReadonlyArray<string>;
        readonly linux: { readonly files: ReadonlyArray<string> };
      };
      readonly scripts: Record<string, string>;
    };
    expect(pkg.build.files).toContain("!out/remote{,/**/*}");
    expect(pkg.build.linux.files).toContain("!out/remote{,/**/*}");
    expect(pkg.scripts["package:qualify:runtime-parity"]).toContain(
      "qualify-package-runtime-parity.ts",
    );
    expect(buildApp).toContain("package-runtime-provenance.ts");
    expect(macPackage).toContain("prepare --target mac");
    expect(macPackage).toContain("verify-package --target mac");
    expect(linuxPackage).toContain("prepare --target linux");
    expect(linuxPackage.indexOf("prepare --target linux")).toBeLessThan(
      linuxPackage.indexOf("electron-builder --linux"),
    );
    expect(linuxPackage).toContain("--no-build-entry");
    expect(linuxPackage).toContain("verify-package");
    expect(remoteCommand).toContain("buildRemoteEntryBundle");
    expect(remoteBuilder).toContain('"--format"');
    expect(remoteBuilder).toContain('"cjs"');
    expect(remoteBuilder).toContain("__VELLUM_COMMAND_APP_VERSION__");
    expect(remoteBuilder).toContain("PRODUCTION_LICENSE_BUILD_PROFILE");
    expect(remoteBuilder).toContain("featureBunDefineArgs");
    expect(remoteBuilder).toContain("let buildIfMissing = false");
    expect(qualifier).toContain('"clone"');
    expect(qualifier).toContain('"app:build:linux"');
    expect(qualifier).toContain("plantHistoricalStaleRemote");
    expect(qualifier).toContain("never edits a published");
  });
});
