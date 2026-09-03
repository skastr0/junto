import { createPackage } from "@electron/asar";
import { spawnSync } from "node:child_process";
import {
  chmod,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURRENT_STATE_SCHEMA_IDENTITY } from "../src/main/vellum/state/migrations";
import {
  MAIN_PAYLOAD_SOURCE_RELATIVE,
  MAIN_PROVENANCE_SOURCE_RELATIVE,
  PACKAGE_RUNTIME_PROVENANCE_SCHEMA,
  REMOTE_PROVENANCE_SOURCE_RELATIVE,
  RUNTIME_BUILD_IDENTITY_SCHEMA,
  assertExactCommittedCheckout,
  embedRuntimeBuildIdentity,
  assertPackageSourceFactsEqual,
  extractRuntimeBuildIdentity,
  makePackageRuntimeProvenance,
  preparePackageRuntimes,
  readPackageSourceFacts,
  resetOwnedRemoteOutput,
  validateRawAsarArchive,
  validateRawAsarHeader,
  verifyPackagedRuntimeParity,
  verifyPreparedPackageRuntimes,
  type PackageRuntime,
  type PackageSourceFacts,
  type RuntimeBuildIdentity,
} from "../scripts/package-runtime-provenance";
import {
  HISTORICAL_COMPARISON_RELATIVE,
  PACKAGE_RUNTIME_PARITY_ATTEMPT_SCHEMA,
  cloneExactCommit,
  decodePackageRuntimeParityReceipt,
  loadHistoricalPackageComparison,
  plantHistoricalStaleRemote,
  readLinuxX64ExecutionFacts,
  withQualificationReceiptAttempt,
} from "../scripts/qualify-package-runtime-parity";
import {
  LINUX_NODE_PTY_RUNTIME_FILES,
  REMOTE_ENTRY_SOURCE_RELATIVE,
  installLinuxRemoteRuntime,
} from "../scripts/build-linux-remote-runtime";
import {
  LINUX_REMOTE_APP_EXACT_FILES,
  LINUX_RUNTIME_AUDIT_SCHEMA,
  collectLinuxRuntimeInventory,
  decodeLinuxRuntimeAuditReceipt,
  linuxRemoteClosureRoot,
  requireExactLinuxRemoteClosure,
} from "../scripts/audit-linux-package";
import {
  finalizeLinuxRuntimeArtifact,
  linuxRuntimeArchiveName,
  linuxRuntimeArtifactName,
  publishPackageAttempt,
} from "../scripts/finalize-linux-package";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cohortNonce = "11111111-1111-4111-8111-111111111111";
let source: PackageSourceFacts;
let sourceRepositoryRoot: string | undefined;

const identity = (
  runtime: PackageRuntime,
  facts: PackageSourceFacts = source,
  nonce = cohortNonce,
): RuntimeBuildIdentity => ({
  schema: RUNTIME_BUILD_IDENTITY_SCHEMA,
  cohortNonce: nonce,
  sourceCommit: facts.sourceCommit,
  runtime,
});

const compiled = (
  runtime: PackageRuntime,
  body: string,
  facts: PackageSourceFacts = source,
  nonce = cohortNonce,
): Buffer =>
  embedRuntimeBuildIdentity({
    payload: Buffer.from(body, "utf8"),
    identity: identity(runtime, facts, nonce),
  });

const writeProvenance = async (input: {
  readonly runtime: PackageRuntime;
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

const writeSourceCohort = async (
  root: string,
): Promise<{ readonly main: Buffer; readonly remote: Buffer }> => {
  const main = compiled("electron-main", "console.log('fresh schema-20 main');\n");
  const remote = compiled(
    "linux-remote",
    "console.log('fresh schema-20 remote');\n",
  );
  await mkdir(path.join(root, "out/main"), { recursive: true });
  await mkdir(path.join(root, "out/remote"), { recursive: true });
  await writeFile(path.join(root, MAIN_PAYLOAD_SOURCE_RELATIVE), main);
  await writeFile(path.join(root, REMOTE_ENTRY_SOURCE_RELATIVE), remote);
  await writeProvenance({
    runtime: "electron-main",
    payload: main,
    file: path.join(root, MAIN_PROVENANCE_SOURCE_RELATIVE),
  });
  await writeProvenance({
    runtime: "linux-remote",
    payload: remote,
    file: path.join(root, REMOTE_PROVENANCE_SOURCE_RELATIVE),
  });
  return { main, remote };
};

const writeExactRemoteClosure = async (
  runtimeRoot: string,
  remote: Buffer,
): Promise<void> => {
  const ordinaryFiles = [
    "vellum-command",
    "resources/bin/vellum-command",
    "resources/bin/unix-peer-pid.py",
    "resources/bin/node",
    "resources/bin/vellum-command-remote",
    "resources/systemd/vellum-command-remote-launch",
  ];
  for (const relative of ordinaryFiles) {
    await mkdir(path.dirname(path.join(runtimeRoot, relative)), {
      recursive: true,
    });
    await writeFile(path.join(runtimeRoot, relative), `fixture ${relative}\n`);
  }
  await writeFile(
    path.join(
      runtimeRoot,
      "resources/systemd/vellum-command-remote.service.template",
    ),
    "ExecStart=@VELLUM_COMMAND_RUNTIME_ROOT@/resources/systemd/vellum-command-remote-launch\n",
  );
  await mkdir(path.join(runtimeRoot, "resources/app-remote"), {
    recursive: true,
  });
  await writeFile(
    path.join(runtimeRoot, "resources/app-remote/vellum-command-remote.js"),
    remote,
  );
  await writeFile(
    path.join(runtimeRoot, "resources/app-remote/package.json"),
    `${JSON.stringify({ name: "vellum-app-remote", private: true, main: "vellum-command-remote.js" })}\n`,
  );
  await writeProvenance({
    runtime: "linux-remote",
    payload: remote,
    file: path.join(
      runtimeRoot,
      "resources/app-remote/package-runtime-provenance.json",
    ),
  });
  for (const relative of LINUX_NODE_PTY_RUNTIME_FILES) {
    const destination = path.join(
      runtimeRoot,
      "resources/app-remote/node_modules/node-pty",
      relative,
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(
      destination,
      relative === "package.json"
        ? `${JSON.stringify({ name: "node-pty", version: "1.1.0" })}\n`
        : `stock node-pty ${relative}\n`,
    );
  }
};

const createSyntheticLinuxRuntime = async (input: {
  readonly root: string;
  readonly packagedMain?: Buffer;
  readonly includeAsarRemote?: boolean;
}): Promise<{
  readonly runtimeRoot: string;
  readonly appStage: string;
  readonly main: Buffer;
  readonly remote: Buffer;
}> => {
  const { main, remote } = await writeSourceCohort(input.root);
  const appStage = path.join(input.root, "app-stage");
  const runtimeRoot = path.join(input.root, "runtime");
  const packagedMain = input.packagedMain ?? main;
  await mkdir(path.join(appStage, "out/main"), { recursive: true });
  await writeFile(path.join(appStage, "out/main/index.js"), packagedMain);
  await writeFile(
    path.join(appStage, "package.json"),
    `${JSON.stringify({ name: "fixture", version: source.appVersion })}\n`,
  );
  await writeProvenance({
    runtime: "electron-main",
    payload: packagedMain,
    file: path.join(appStage, MAIN_PROVENANCE_SOURCE_RELATIVE),
  });
  if (input.includeAsarRemote === true) {
    await mkdir(path.join(appStage, "out/remote"), { recursive: true });
    await writeFile(
      path.join(appStage, "out/remote/vellum-command-remote.js"),
      "forbidden Remote\n",
    );
  }
  await mkdir(path.join(runtimeRoot, "resources"), { recursive: true });
  await createPackage(appStage, path.join(runtimeRoot, "resources/app.asar"));
  await writeExactRemoteClosure(runtimeRoot, remote);
  return { runtimeRoot, appStage, main, remote };
};

const createSyntheticMacBundle = async (
  root: string,
): Promise<{ readonly app: string }> => {
  const { main } = await writeSourceCohort(root);
  const stage = path.join(root, "mac-stage");
  const app = path.join(root, "Vellum Command.app");
  await mkdir(path.join(stage, "out/main"), { recursive: true });
  await writeFile(path.join(stage, "out/main/index.js"), main);
  await writeFile(
    path.join(stage, "package.json"),
    `${JSON.stringify({ version: source.appVersion })}\n`,
  );
  await writeProvenance({
    runtime: "electron-main",
    payload: main,
    file: path.join(stage, MAIN_PROVENANCE_SOURCE_RELATIVE),
  });
  await mkdir(path.join(app, "Contents/Resources"), { recursive: true });
  await createPackage(stage, path.join(app, "Contents/Resources/app.asar"));
  return { app };
};

const git = (cwd: string, args: ReadonlyArray<string>): string => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
};

type SourceRepositoryOptions = {
  readonly appVersion?: string;
  readonly schemaVersion?: number;
  readonly migrationName?: string;
  readonly migrationIdentitySha256?: string;
};

const createSourceRepository = async (
  options: SourceRepositoryOptions = {},
): Promise<{
  readonly root: string;
  readonly commit: string;
}> => {
  const appVersion = options.appVersion ?? "0.1.14";
  const schemaVersion = options.schemaVersion ?? 20;
  const migrationName =
    options.migrationName ?? "witness-every-projected-work-table";
  const migrationIdentitySha256 =
    options.migrationIdentitySha256 ??
    "b545aa0771810a631eeeea9f7b642467e6cca327ba74392298457aab1cec1955";
  const root = await mkdtemp(path.join(tmpdir(), "vellum-package-source-git-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "package-test@example.invalid"]);
  git(root, ["config", "user.name", "Package Test"]);
  await mkdir(path.join(root, "src/main/vellum/state"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ version: appVersion })}\n`,
  );
  await writeFile(
    path.join(root, "src/main/vellum/state/migrations.ts"),
    [
      `export const CURRENT_STATE_SCHEMA_VERSION = ${String(schemaVersion)};`,
      `export const STATE_SCHEMA_V${String(schemaVersion)}_IDENTITY = { actualSchemaSha256: ${JSON.stringify(migrationIdentitySha256)} };`,
      `const migrations = [{ fromVersion: ${String(schemaVersion - 1)}, toVersion: ${String(schemaVersion)}, name: ${JSON.stringify(migrationName)} }];`,
      "",
    ].join("\n"),
  );
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]) };
};

const mutatePackageSourceFacts = async (
  root: string,
  field: "appVersion" | "schema" | "migrationHead" | "schemaIdentity",
): Promise<void> => {
  if (field === "appVersion") {
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ version: "0.1.15" })}\n`,
    );
    return;
  }
  const migrationPath = path.join(
    root,
    "src/main/vellum/state/migrations.ts",
  );
  const body = await readFile(migrationPath, "utf8");
  const substitutions: ReadonlyArray<readonly [string, string]> =
    field === "schema"
      ? [
          [
            "CURRENT_STATE_SCHEMA_VERSION = 20",
            "CURRENT_STATE_SCHEMA_VERSION = 21",
          ],
          ["STATE_SCHEMA_V20_IDENTITY", "STATE_SCHEMA_V21_IDENTITY"],
          ["fromVersion: 19, toVersion: 20", "fromVersion: 20, toVersion: 21"],
        ]
      : field === "migrationHead"
        ? [["witness-every-projected-work-table", "different-head"]]
        : [
            [
              "b545aa0771810a631eeeea9f7b642467e6cca327ba74392298457aab1cec1955",
              "c".repeat(64),
            ],
          ];
  let mutated = body;
  for (const [from, to] of substitutions) {
    if (!mutated.includes(from)) {
      throw new Error(`fixture source is missing ${from}`);
    }
    mutated = mutated.replace(from, to);
  }
  await writeFile(migrationPath, mutated);
};

beforeAll(async () => {
  const fixture = await createSourceRepository();
  sourceRepositoryRoot = fixture.root;
  source = await readPackageSourceFacts({
    repoRoot: fixture.root,
    requireClean: true,
  });
});

afterAll(async () => {
  if (sourceRepositoryRoot !== undefined) {
    await rm(sourceRepositoryRoot, { recursive: true, force: true });
  }
});

describe("fresh compiler cohort provenance", () => {
  it("reads the current schema head without changing migrations", async () => {
    const facts = await readPackageSourceFacts({
      repoRoot,
      requireClean: false,
    });
    const packageVersion = (
      JSON.parse(
        await readFile(path.join(repoRoot, "package.json"), "utf8"),
      ) as { readonly version: string }
    ).version;
    expect(facts).toMatchObject({
      appVersion: packageVersion,
      currentStateSchemaVersion: 21,
      migrationHead: {
        fromVersion: 20,
        toVersion: 21,
        name: "canvas-relational-authority-cutover",
      },
      migrationIdentitySha256:
        CURRENT_STATE_SCHEMA_IDENTITY.actualSchemaSha256,
    });
  });

  it("removes stale main and Remote before both compilers and stamps one identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-cohort-build-"));
    try {
      await mkdir(path.join(root, "out/main"), { recursive: true });
      await mkdir(path.join(root, "out/remote"), { recursive: true });
      const stale = compiled(
        "electron-main",
        "var CURRENT_STATE_SCHEMA_VERSION=18; var APP_VERSION='0.1.13';\n",
      );
      await writeFile(path.join(root, MAIN_PAYLOAD_SOURCE_RELATIVE), stale);
      await writeProvenance({
        runtime: "electron-main",
        payload: stale,
        file: path.join(root, MAIN_PROVENANCE_SOURCE_RELATIVE),
      });
      await writeFile(path.join(root, "out/remote/stale"), "schema 18\n");
      await writeFile(path.join(root, "out/sibling"), "preserve\n");
      let mainWasAbsent = false;
      let remoteWasAbsent = false;
      await preparePackageRuntimes({
        repoRoot: root,
        target: "mac",
        source,
        cohortNonce,
        buildMain: async (candidate) => {
          mainWasAbsent =
            (await lstat(path.join(candidate, MAIN_PAYLOAD_SOURCE_RELATIVE)).catch(
              () => undefined,
            )) === undefined;
          await writeFile(
            path.join(candidate, MAIN_PAYLOAD_SOURCE_RELATIVE),
            "fresh main compiler bytes\n",
          );
        },
        buildRemote: async (candidate) => {
          remoteWasAbsent =
            (await lstat(path.join(candidate, "out/remote/stale")).catch(
              () => undefined,
            )) === undefined;
          await writeFile(
            path.join(candidate, REMOTE_ENTRY_SOURCE_RELATIVE),
            "fresh remote compiler bytes\n",
          );
        },
      });
      expect(mainWasAbsent).toBe(true);
      expect(remoteWasAbsent).toBe(true);
      await expect(readFile(path.join(root, "out/sibling"), "utf8")).resolves.toBe(
        "preserve\n",
      );
      const verified = await verifyPreparedPackageRuntimes({
        repoRoot: root,
        target: "mac",
        expected: source,
      });
      expect(verified.cohortNonce).toBe(cohortNonce);
      expect(verified.compiledRuntimes.linuxRemote).toBeDefined();
      expect(
        extractRuntimeBuildIdentity(
          await readFile(path.join(root, MAIN_PAYLOAD_SOURCE_RELATIVE)),
        ).cohortNonce,
      ).toBe(cohortNonce);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cannot bless an ignored stale main when the main compiler emits nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-cohort-noop-"));
    try {
      await mkdir(path.join(root, "out/main"), { recursive: true });
      await writeFile(path.join(root, MAIN_PAYLOAD_SOURCE_RELATIVE), "stale\n");
      await expect(
        preparePackageRuntimes({
          repoRoot: root,
          target: "linux",
          source,
          cohortNonce,
          buildMain: async () => {},
          buildRemote: async () => {},
        }),
      ).rejects.toThrow(/fresh compiler output/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only the owned Remote output and refuses its symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-owned-output-"));
    try {
      await mkdir(path.join(root, "out/remote"), { recursive: true });
      await writeFile(path.join(root, "out/remote/stale"), "old\n");
      await writeFile(path.join(root, "out/sibling"), "keep\n");
      await resetOwnedRemoteOutput(root);
      await expect(readFile(path.join(root, "out/sibling"), "utf8")).resolves.toBe(
        "keep\n",
      );
      await rm(path.join(root, "out/remote"), { recursive: true });
      await writeFile(path.join(root, "outside"), "safe\n");
      await symlink(path.join(root, "outside"), path.join(root, "out/remote"));
      await expect(resetOwnedRemoteOutput(root)).rejects.toThrow(/symlink/u);
      await expect(readFile(path.join(root, "outside"), "utf8")).resolves.toBe(
        "safe\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("exact committed source admission", () => {
  it("rejects tracked bytes hidden by assume-unchanged", async () => {
    const fixture = await createSourceRepository();
    try {
      git(fixture.root, ["update-index", "--assume-unchanged", "package.json"]);
      await writeFile(
        path.join(fixture.root, "package.json"),
        `${JSON.stringify({ version: "0.1.13" })}\n`,
      );
      await expect(
        readPackageSourceFacts({ repoRoot: fixture.root, requireClean: true }),
      ).rejects.toThrow(/assume-unchanged|index flag/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects tracked bytes hidden by skip-worktree", async () => {
    const fixture = await createSourceRepository();
    try {
      git(fixture.root, ["update-index", "--skip-worktree", "package.json"]);
      await writeFile(
        path.join(fixture.root, "package.json"),
        `${JSON.stringify({ version: "0.1.13" })}\n`,
      );
      await expect(assertExactCommittedCheckout(fixture.root)).rejects.toThrow(
        /skip-worktree|index flag/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("clones exact commit bytes without local alternates", async () => {
    const fixture = await createSourceRepository();
    const work = await mkdtemp(path.join(tmpdir(), "vellum-exact-clone-"));
    const clone = path.join(work, "clone");
    try {
      const result = await cloneExactCommit({
        sourceRoot: fixture.root,
        cloneRoot: clone,
        commit: fixture.commit,
      });
      expect(result.commit).toBe(fixture.commit);
      expect(
        await lstat(path.join(clone, ".git/objects/info/alternates")).catch(
          () => undefined,
        ),
      ).toBeUndefined();
      expect(git(clone, ["count-objects", "-v"])).not.toMatch(/^alternate:/mu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("package source facts", () => {
  it("accepts two independently read facts with the same source values", async () => {
    const root = sourceRepositoryRoot as string;
    const rootFacts = await readPackageSourceFacts({
      repoRoot: root,
      requireClean: true,
    });
    const cloneFacts = await readPackageSourceFacts({
      repoRoot: root,
      requireClean: true,
    });
    const comparison = assertPackageSourceFactsEqual(rootFacts, cloneFacts);
    expect(comparison.root).toBe(rootFacts);
    expect(comparison.clone).toBe(cloneFacts);
  });

  it.each([
    ["app", "appVersion", "appVersion"],
    ["schema", "schema", "currentStateSchemaVersion"],
    ["migration head", "migrationHead", "migrationHead.name"],
    ["schema identity", "schemaIdentity", "currentStateSchemaIdentity"],
  ] as const)(
    "rejects a same-HEAD working-tree %s mismatch in %s",
    async (_label, field, expectedField) => {
      const fixture = await createSourceRepository();
      try {
        const rootFacts = await readPackageSourceFacts({
          repoRoot: fixture.root,
          requireClean: false,
        });
        await mutatePackageSourceFacts(fixture.root, field);
        const variantFacts = await readPackageSourceFacts({
          repoRoot: fixture.root,
          requireClean: false,
        });
        expect(variantFacts.sourceCommit).toBe(rootFacts.sourceCommit);
        expect(() =>
          assertPackageSourceFactsEqual(rootFacts, variantFacts),
        ).toThrow(
          new RegExp(`PackageSourceFacts mismatch for ${expectedField}`),
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "1.2.3-rc.0+build.01",
    "2.0.0-alpha-beta+build.001",
  ] as const)("retains valid SemVer 2 prerelease/build admission (%s)", async (appVersion) => {
    const fixture = await createSourceRepository({ appVersion });
    try {
      await expect(
        readPackageSourceFacts({ repoRoot: fixture.root, requireClean: true }),
      ).resolves.toMatchObject({ appVersion });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "0.1.14-01",
    "1.2.3-rc.01",
  ] as const)("rejects SemVer 2 numeric prerelease leading zeroes (%s)", async (appVersion) => {
    const fixture = await createSourceRepository({ appVersion });
    try {
      await expect(
        readPackageSourceFacts({ repoRoot: fixture.root, requireClean: true }),
      ).rejects.toThrow(/invalid package\.json version/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns deeply frozen ordinary own-data facts", async () => {
    const facts = await readPackageSourceFacts({
      repoRoot: sourceRepositoryRoot as string,
      requireClean: true,
    });
    expect(Object.getPrototypeOf(facts)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(facts.migrationHead)).toBe(Object.prototype);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.migrationHead)).toBe(true);
    for (const value of Object.values(
      Object.getOwnPropertyDescriptors(facts),
    )) {
      expect(value.get).toBeUndefined();
      expect(value.set).toBeUndefined();
      expect(value.configurable).toBe(false);
      expect(value.enumerable).toBe(true);
      expect(value.writable).toBe(false);
    }
    for (const value of Object.values(
      Object.getOwnPropertyDescriptors(facts.migrationHead),
    )) {
      expect(value.get).toBeUndefined();
      expect(value.set).toBeUndefined();
      expect(value.configurable).toBe(false);
      expect(value.enumerable).toBe(true);
      expect(value.writable).toBe(false);
    }
    expect(
      Reflect.set(
        facts as unknown as Record<string, unknown>,
        "appVersion",
        "9.9.9",
      ),
    ).toBe(false);
    expect(
      Reflect.set(
        facts.migrationHead as unknown as Record<string, unknown>,
        "name",
        "mutated",
      ),
    ).toBe(false);
    expect(facts.appVersion).toBe("0.1.14");
    expect(facts.migrationHead.name).toBe(
      "witness-every-projected-work-table",
    );
  });
});

describe("packaged runtime exact parity and closure", () => {
  it("accepts exact packaged outputs and binds the full Linux closure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-package-parity-"));
    try {
      const candidate = await createSyntheticLinuxRuntime({ root });
      const receipt = await verifyPackagedRuntimeParity({
        repoRoot: root,
        target: "linux",
        runtimeRoot: candidate.runtimeRoot,
        expected: source,
      });
      expect(receipt.cohortNonce).toBe(cohortNonce);
      expect(receipt.runtimes.linuxRemote?.payloadSha256).toBe(
        receipt.compiledRuntimes.linuxRemote.payloadSha256,
      );
      expect(receipt.linuxRuntimeClosure?.remoteEntries.map((entry) => entry.path)).toEqual(
        [...LINUX_REMOTE_APP_EXACT_FILES, "resources/bin/node", "resources/bin/vellum-command-remote", "resources/systemd/vellum-command-remote-launch", "resources/systemd/vellum-command-remote.service.template"].sort(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects internally self-consistent stale main bytes that differ from fresh output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-package-stale-main-"));
    try {
      const staleMain = compiled(
        "electron-main",
        "var CURRENT_STATE_SCHEMA_VERSION=18; var APP_VERSION='0.1.13';\n",
      );
      const candidate = await createSyntheticLinuxRuntime({
        root,
        packagedMain: staleMain,
      });
      await expect(
        verifyPackagedRuntimeParity({
          repoRoot: root,
          target: "linux",
          runtimeRoot: candidate.runtimeRoot,
          expected: source,
        }),
      ).rejects.toThrow(/exact fresh compiler output/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects alternate or excess Remote copies anywhere in Linux runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-package-duplicate-"));
    try {
      const candidate = await createSyntheticLinuxRuntime({ root });
      await mkdir(path.join(candidate.runtimeRoot, "resources/alternate"), {
        recursive: true,
      });
      await writeFile(
        path.join(
          candidate.runtimeRoot,
          "resources/alternate/vellum-command-remote.js",
        ),
        "duplicate\n",
      );
      await expect(
        verifyPackagedRuntimeParity({
          repoRoot: root,
          target: "linux",
          runtimeRoot: candidate.runtimeRoot,
          expected: source,
        }),
      ).rejects.toThrow(/alternate Linux Remote copy/u);
      await rm(path.join(candidate.runtimeRoot, "resources/alternate"), {
        recursive: true,
      });
      await mkdir(
        path.join(
          candidate.runtimeRoot,
          "resources/app.asar.unpacked/out/remote",
        ),
        { recursive: true },
      );
      await writeFile(
        path.join(
          candidate.runtimeRoot,
          "resources/app.asar.unpacked/out/remote/stale.js",
        ),
        "duplicate\n",
      );
      await expect(
        verifyPackagedRuntimeParity({
          repoRoot: root,
          target: "linux",
          runtimeRoot: candidate.runtimeRoot,
          expected: source,
        }),
      ).rejects.toThrow(/alternate Linux Remote copy/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forbids Remote-only resources in mac app.asar.unpacked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-package-mac-remote-"));
    try {
      const candidate = await createSyntheticMacBundle(root);
      await mkdir(
        path.join(
          candidate.app,
          "Contents/Resources/app.asar.unpacked/out/remote",
        ),
        { recursive: true },
      );
      await writeFile(
        path.join(
          candidate.app,
          "Contents/Resources/app.asar.unpacked/out/remote/stale.js",
        ),
        "stale\n",
      );
      await expect(
        verifyPackagedRuntimeParity({
          repoRoot: root,
          target: "mac",
          appBundle: candidate.app,
          expected: source,
        }),
      ).rejects.toThrow(/Remote-only resource/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("whole-directory Remote staging removes stale files and preserves siblings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-remote-replace-"));
    const runtime = path.join(root, "runtime");
    try {
      await mkdir(path.join(root, "out/remote"), { recursive: true });
      await writeFile(
        path.join(root, REMOTE_ENTRY_SOURCE_RELATIVE),
        "fresh remote entry\n",
      );
      await mkdir(path.join(runtime, "resources/app-remote"), { recursive: true });
      await writeFile(
        path.join(runtime, "resources/app-remote/stale-extra.js"),
        "stale\n",
      );
      await writeFile(path.join(runtime, "preserve"), "keep\n");
      await installLinuxRemoteRuntime({
        repoRoot: root,
        runtimeRoot: runtime,
        skipNativeRebuild: true,
      });
      const inventory = await collectLinuxRuntimeInventory(runtime);
      expect(
        inventory.entries
          .map((entry) => entry.path)
          .filter((entry) => entry.startsWith("resources/app-remote/")),
      ).toEqual([
        "resources/app-remote/package.json",
        "resources/app-remote/vellum-command-remote.js",
      ]);
      await expect(readFile(path.join(runtime, "preserve"), "utf8")).resolves.toBe(
        "keep\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runtime inventory changes for Node, wrapper, launcher, and node-pty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-runtime-inventory-"));
    try {
      const candidate = await createSyntheticLinuxRuntime({ root });
      const initial = await collectLinuxRuntimeInventory(candidate.runtimeRoot);
      const remoteClosure = requireExactLinuxRemoteClosure(initial);
      const byPath = new Map(initial.entries.map((entry) => [entry.path, entry]));
      expect(
        decodeLinuxRuntimeAuditReceipt({
          schema: LINUX_RUNTIME_AUDIT_SCHEMA,
          ok: true,
          artifact: "fixture",
          inventory: initial,
          remoteClosure: {
            exact: true,
            entries: remoteClosure,
            rootSha256: linuxRemoteClosureRoot(remoteClosure),
          },
          nativeObjects: [],
          chromeSandbox: "absent",
          stockNode: {
            source: "pinned-official-nodejs-linux-x64-archive",
            version: "24.18.0",
            moduleAbi: "137",
            officialArchiveSha256:
              "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
            binarySha256: byPath.get("resources/bin/node")?.sha256,
          },
          nodePty: {
            version: "1.1.0",
            execution: "functional",
            nativeModuleSha256: byPath.get(
              "resources/app-remote/node_modules/node-pty/build/Release/pty.node",
            )?.sha256,
          },
        }),
      ).toMatchObject({ schema: LINUX_RUNTIME_AUDIT_SCHEMA, ok: true });
      for (const relative of [
        "resources/bin/node",
        "resources/bin/vellum-command-remote",
        "resources/systemd/vellum-command-remote-launch",
        "resources/app-remote/node_modules/node-pty/lib/index.js",
      ]) {
        await writeFile(path.join(candidate.runtimeRoot, relative), `mutated ${relative}\n`);
        const changed = await collectLinuxRuntimeInventory(candidate.runtimeRoot);
        expect(changed.rootSha256).not.toBe(initial.rootSha256);
        await writeFile(path.join(candidate.runtimeRoot, relative), `fixture ${relative}\n`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("raw ASAR admission", () => {
  it("rejects a raw dotdot key before normalized ASAR APIs can hide it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-raw-asar-"));
    try {
      const candidate = await createSyntheticLinuxRuntime({ root });
      await mkdir(path.join(candidate.appStage, "aa"), { recursive: true });
      await writeFile(path.join(candidate.appStage, "aa/hidden"), "hidden\n");
      const asar = path.join(root, "adversarial.asar");
      await createPackage(candidate.appStage, asar);
      const body = await readFile(asar);
      const needle = Buffer.from('"aa"', "utf8");
      const index = body.indexOf(needle);
      expect(index).toBeGreaterThan(0);
      Buffer.from('".."', "utf8").copy(body, index);
      await writeFile(asar, body);
      await expect(validateRawAsarArchive(asar)).rejects.toThrow(/raw ASAR key/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal links, critical links/unpacked nodes, and normalized collisions", () => {
    expect(() =>
      validateRawAsarHeader({
        header: { files: { bad: { link: "../outside" } } },
      }),
    ).toThrow(/unsafe ASAR link/u);
    expect(() =>
      validateRawAsarHeader({
        header: {
          files: {
            out: {
              files: {
                main: {
                  files: {
                    "index.js": { link: "out/main/payload.js" },
                    "payload.js": { size: 1, offset: "0" },
                  },
                },
              },
            },
          },
        },
        criticalPaths: ["out/main/index.js"],
      }),
    ).toThrow(/direct packed regular file/u);
    expect(() =>
      validateRawAsarHeader({
        header: {
          files: {
            "é": { size: 1, offset: "0" },
            "é": { size: 1, offset: "1" },
          },
        },
      }),
    ).toThrow(/normalized ASAR path collision/u);
    expect(() =>
      validateRawAsarHeader({
        header: {
          files: { critical: { size: 1, unpacked: true } },
        },
        criticalPaths: ["critical"],
      }),
    ).toThrow(/direct packed regular file/u);
  });
});

describe("attempt-owned publication", () => {
  it("rejects a dangling final archive symlink without touching its target", async () => {
    const release = await mkdtemp(path.join(tmpdir(), "vellum-dangling-final-"));
    try {
      const version = "1.2.3";
      await mkdir(path.join(release, "linux-unpacked"));
      await writeFile(path.join(release, "linux-unpacked/vellum-command"), "runtime\n");
      const outside = path.join(release, "outside-created.tar.gz");
      await symlink(
        outside,
        path.join(release, linuxRuntimeArchiveName({ version, arch: "x64" })),
      );
      await expect(
        finalizeLinuxRuntimeArtifact({
          releaseDirectory: release,
          version,
          arch: "x64",
        }),
      ).rejects.toThrow(/destination already exists/u);
      expect(await lstat(outside).catch(() => undefined)).toBeUndefined();
      expect((await lstat(path.join(release, "linux-unpacked"))).isDirectory()).toBe(
        true,
      );
    } finally {
      await rm(release, { recursive: true, force: true });
    }
  });

  it("forced audit failure leaves no finals and preserves unrelated outputs", async () => {
    const release = await mkdtemp(path.join(tmpdir(), "vellum-audit-failure-"));
    const attempt = path.join(release, ".vellum-package-attempt-forced-failure");
    try {
      await mkdir(attempt);
      await writeFile(path.join(attempt, "candidate.zip"), "draft\n");
      await writeFile(path.join(release, "unrelated"), "keep\n");
      await expect(
        (async () => {
          throw new Error("forced audit failure");
          // Production scripts call this only after parity/audit.
          await publishPackageAttempt({
            attemptDirectory: attempt,
            releaseDirectory: release,
          });
        })(),
      ).rejects.toThrow(/forced audit failure/u);
      await rm(attempt, { recursive: true, force: true });
      expect(await lstat(path.join(release, "candidate.zip")).catch(() => undefined)).toBeUndefined();
      await expect(readFile(path.join(release, "unrelated"), "utf8")).resolves.toBe(
        "keep\n",
      );
      const [linuxScript, macScript] = await Promise.all([
        readFile(path.join(repoRoot, "scripts/package-app-linux.sh"), "utf8"),
        readFile(path.join(repoRoot, "scripts/package-app-macos.sh"), "utf8"),
      ]);
      for (const script of [linuxScript, macScript]) {
        expect(script).toContain("--config.directories.output=\"$ATTEMPT_DIR\"");
        expect(script.indexOf("verify-package")).toBeLessThan(
          script.indexOf("publish-attempt"),
        );
        expect(script.indexOf("audit-")).toBeLessThan(
          script.indexOf("publish-attempt"),
        );
      }
    } finally {
      await rm(release, { recursive: true, force: true });
    }
  });

  it("publisher rejects a dangling destination and keeps unrelated files", async () => {
    const release = await mkdtemp(path.join(tmpdir(), "vellum-publish-link-"));
    const attempt = path.join(release, ".vellum-package-attempt-link");
    try {
      await mkdir(attempt);
      await writeFile(path.join(attempt, "candidate.zip"), "draft\n");
      const outside = path.join(release, "outside");
      await symlink(outside, path.join(release, "candidate.zip"));
      await writeFile(path.join(release, "unrelated"), "keep\n");
      await expect(
        publishPackageAttempt({
          attemptDirectory: attempt,
          releaseDirectory: release,
        }),
      ).rejects.toThrow(/destination already exists/u);
      expect(await lstat(outside).catch(() => undefined)).toBeUndefined();
      await expect(readFile(path.join(release, "unrelated"), "utf8")).resolves.toBe(
        "keep\n",
      );
    } finally {
      await rm(release, { recursive: true, force: true });
    }
  });
});

describe("qualification receipt lifecycle", () => {
  it("a failed attempt supersedes an older success receipt immediately", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-stale-receipt-"));
    const receiptPath = path.join(root, "receipt.json");
    try {
      await writeFile(receiptPath, '{"old-success":true,"commit":"deadbeef"}\n');
      await expect(
        withQualificationReceiptAttempt({
          receiptPath,
          body: async () => {
            throw new Error("forced attempt failure");
          },
        }),
      ).rejects.toThrow(/forced attempt failure/u);
      const marker = JSON.parse(await readFile(receiptPath, "utf8")) as {
        schema: string;
        status: string;
        nonce: string;
      };
      expect(marker.schema).toBe(PACKAGE_RUNTIME_PARITY_ATTEMPT_SCHEMA);
      expect(marker.status).toBe("failed");
      expect(marker.nonce).toMatch(/^[0-9a-f-]{36}$/u);
      expect(await readFile(receiptPath, "utf8")).not.toContain("old-success");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strict receipt decode rejects a plausible two-payload receipt with no runtime audit", () => {
    const verified = (runtime: PackageRuntime) => ({
      runtime,
      manifestSha256: "b".repeat(64),
      payloadSha256: "c".repeat(64),
      payloadBytes: 42,
      packagedPath:
        runtime === "electron-main"
          ? "out/main/index.js"
          : "resources/app-remote/vellum-command-remote.js",
      buildIdentity: identity(runtime),
    });
    expect(() =>
      decodePackageRuntimeParityReceipt({
        schema: "vellum-command/package-runtime-parity-receipt/v2",
        product: "Vellum Command",
        qualification: "fresh-isolated-linux-x64-execution",
        externalCandidatePublished: false,
        qualifiedAt: new Date().toISOString(),
        attempt: {
          nonce: cohortNonce,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sourceCommit: source.sourceCommit,
        },
        execution: {
          architectureClaim: "linux-x64-process",
        },
        source: { commit: source.sourceCommit },
        candidateArchive: { sha256: "d".repeat(64) },
        compilerCohort: {
          nonce: cohortNonce,
          runtimes: {
            electronMain: verified("electron-main"),
            linuxRemote: verified("linux-remote"),
          },
        },
        packagedRuntimes: {
          electronMain: verified("electron-main"),
          linuxRemote: verified("linux-remote"),
        },
      }),
    ).toThrow(/runtime audit/i);
  });

  it("records Linux x64 execution without claiming physical amd64", () => {
    const facts = readLinuxX64ExecutionFacts({
      platform: "linux",
      arch: "x64",
      kernelSystem: "Linux",
      kernelMachine: "aarch64",
      kernelRelease: "fixture",
      env: {},
      bunVersion: "1.3.14",
      nodeVersion: "v24.18.0",
      executable: "/runner/bun",
    });
    expect(facts.architectureClaim).toBe("linux-x64-process");
    expect(facts.emulation.status).toBe("observed");
    expect(JSON.stringify(facts)).not.toMatch(/physical amd64/iu);
  });
});

describe("historical probe and official wiring", () => {
  it("pins public 0.1.14 schema 18 only as hash-checked history", async () => {
    const historical = await loadHistoricalPackageComparison(repoRoot);
    expect(historical.comparison).toMatchObject({
      classification: "historical-comparison-only",
      product: "Vellum Command",
      release: {
        appVersion: "0.1.14",
        currentStateSchemaVersion: 18,
        migrationHead: { fromVersion: 17, toVersion: 18 },
      },
    });
    expect(HISTORICAL_COMPARISON_RELATIVE).toContain("historical");
  });

  it("plants a plausible schema-18 bundle that a cohort must replace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-stale-probe-"));
    try {
      const historical = await loadHistoricalPackageComparison(repoRoot);
      const planted = await plantHistoricalStaleRemote({
        repoRoot: root,
        comparison: historical.comparison,
      });
      expect(planted.currentStateSchemaVersion).toBe(18);
      expect(planted.payloadSha256).toMatch(/^[0-9a-f]{64}$/u);
      await expect(
        readFile(path.join(root, REMOTE_ENTRY_SOURCE_RELATIVE), "utf8"),
      ).resolves.toContain("CURRENT_STATE_SCHEMA_VERSION = 18");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wires direct macOS and Linux package commands through the fresh coordinator", async () => {
    const [buildApp, macPackage, linuxPackage, qualifier] = await Promise.all([
      readFile(path.join(repoRoot, "scripts/build-app.sh"), "utf8"),
      readFile(path.join(repoRoot, "scripts/package-app-macos.sh"), "utf8"),
      readFile(path.join(repoRoot, "scripts/package-app-linux.sh"), "utf8"),
      readFile(
        path.join(repoRoot, "scripts/qualify-package-runtime-parity.ts"),
        "utf8",
      ),
    ]);
    expect(buildApp).toContain("--runtime-cohort-only");
    for (const script of [macPackage, linuxPackage]) {
      expect(script).toContain("--runtime-cohort-only");
      expect(script).toContain("verify-source");
      expect(script).toContain("$ATTEMPT_DIR");
      expect(script.indexOf("verify-package")).toBeLessThan(
        script.indexOf("publish-attempt"),
      );
    }
    expect(qualifier).toContain('"--no-local"');
    expect(qualifier).toContain('"--dissociate"');
    expect(qualifier).not.toContain("native Linux x64");
    expect(PACKAGE_RUNTIME_PROVENANCE_SCHEMA).toContain("v2");
  });
});
