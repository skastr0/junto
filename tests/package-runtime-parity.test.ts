import { createPackage } from "@electron/asar";
import { spawnSync } from "node:child_process";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_MIGRATIONS,
} from "../src/main/junto/state/migrations";
import {
  MAIN_PAYLOAD_SOURCE_RELATIVE,
  MAIN_PROVENANCE_SOURCE_RELATIVE,
  PACKAGE_RUNTIME_PROVENANCE_SCHEMA,
  RUNTIME_BUILD_IDENTITY_SCHEMA,
  assertExactCommittedCheckout,
  embedRuntimeBuildIdentity,
  assertPackageSourceFactsEqual,
  decodePackageRuntimeProvenance,
  extractRuntimeBuildIdentity,
  makePackageRuntimeProvenance,
  preparePackageRuntimes,
  readPackageSchemaFacts,
  readPackageSourceFacts,
  validateRawAsarArchive,
  validateRawAsarHeader,
  verifyPackagedRuntimeParity,
  verifyPreparedPackageRuntimes,
  type PackageRuntime,
  type PackageSourceFacts,
  type RuntimeBuildIdentity,
} from "../scripts/package-runtime-provenance";
import {
  LINUX_RUNTIME_AUDIT_SCHEMA,
  LINUX_RUNTIME_REQUIRED_FILES,
  collectLinuxRuntimeInventory,
  decodeLinuxRuntimeAuditReceipt,
} from "../scripts/audit-linux-package";
import {
  finalizeLinuxRuntimeArtifact,
  linuxRuntimeArchiveName,
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
): Promise<{ readonly main: Buffer }> => {
  const main = compiled("electron-main", "console.log('fresh schema-20 main');\n");
  await mkdir(path.join(root, "out/main"), { recursive: true });
  await writeFile(path.join(root, MAIN_PAYLOAD_SOURCE_RELATIVE), main);
  await writeProvenance({
    runtime: "electron-main",
    payload: main,
    file: path.join(root, MAIN_PROVENANCE_SOURCE_RELATIVE),
  });
  return { main };
};

const writeLinuxRuntimeFiles = async (runtimeRoot: string): Promise<void> => {
  for (const relative of LINUX_RUNTIME_REQUIRED_FILES) {
    if (relative === "resources/app.asar") continue;
    await mkdir(path.dirname(path.join(runtimeRoot, relative)), {
      recursive: true,
    });
    await writeFile(path.join(runtimeRoot, relative), `fixture ${relative}\n`);
  }
};

const createSyntheticLinuxRuntime = async (input: {
  readonly root: string;
  readonly packagedMain?: Buffer;
}): Promise<{
  readonly runtimeRoot: string;
  readonly appStage: string;
  readonly main: Buffer;
}> => {
  const { main } = await writeSourceCohort(input.root);
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
  await mkdir(path.join(runtimeRoot, "resources"), { recursive: true });
  await createPackage(appStage, path.join(runtimeRoot, "resources/app.asar"));
  await writeLinuxRuntimeFiles(runtimeRoot);
  return { runtimeRoot, appStage, main };
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
  const appVersion = options.appVersion ?? "0.2.0";
  const schemaVersion = options.schemaVersion ?? 20;
  const migrationName =
    options.migrationName ?? "synthetic-migration-head";
  const migrationIdentitySha256 =
    options.migrationIdentitySha256 ??
    "b545aa0771810a631eeeea9f7b642467e6cca327ba74392298457aab1cec1955";
  const root = await mkdtemp(path.join(tmpdir(), "junto-package-source-git-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "package-test@example.invalid"]);
  git(root, ["config", "user.name", "Package Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(root, "src/main/junto/state"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ version: appVersion })}\n`,
  );
  await writeFile(
    path.join(root, "src/main/junto/state/migrations.ts"),
    [
      `export const CURRENT_STATE_SCHEMA_VERSION = ${String(schemaVersion)};`,
      `export const STATE_SCHEMA_V${String(schemaVersion)}_IDENTITY = { actualSchemaSha256: ${JSON.stringify(migrationIdentitySha256)} };`,
      schemaVersion === 1
        ? "const migrations = [];"
        : `const migrations = [{ fromVersion: ${String(schemaVersion - 1)}, toVersion: ${String(schemaVersion)}, name: ${JSON.stringify(migrationName)} }];`,
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
      `${JSON.stringify({ version: "0.2.1" })}\n`,
    );
    return;
  }
  const migrationPath = path.join(
    root,
    "src/main/junto/state/migrations.ts",
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
        ? [["synthetic-migration-head", "different-head"]]
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
  it("removes stale main before the compiler and stamps its identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "junto-cohort-build-"));
    try {
      await mkdir(path.join(root, "out/main"), { recursive: true });
      const stale = compiled(
        "electron-main",
        "var CURRENT_STATE_SCHEMA_VERSION=1; var APP_VERSION='0.0.0-stale';\n",
      );
      await writeFile(path.join(root, MAIN_PAYLOAD_SOURCE_RELATIVE), stale);
      await writeProvenance({
        runtime: "electron-main",
        payload: stale,
        file: path.join(root, MAIN_PROVENANCE_SOURCE_RELATIVE),
      });
      await writeFile(path.join(root, "out/sibling"), "preserve\n");
      let mainWasAbsent = false;
      await preparePackageRuntimes({
        repoRoot: root,
        target: "linux",
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
      });
      expect(mainWasAbsent).toBe(true);
      await expect(readFile(path.join(root, "out/sibling"), "utf8")).resolves.toBe(
        "preserve\n",
      );
      const verified = await verifyPreparedPackageRuntimes({
        repoRoot: root,
        target: "linux",
        expected: source,
      });
      expect(verified.cohortNonce).toBe(cohortNonce);
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
    const root = await mkdtemp(path.join(tmpdir(), "junto-cohort-noop-"));
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
        }),
      ).rejects.toThrow(/fresh compiler output/u);
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

});

describe("package source facts", () => {
  it("packages the v1 baseline without inventing a migration", async () => {
    const fixture = await createSourceRepository({ schemaVersion: 1 });
    try {
      const facts = await readPackageSourceFacts({ repoRoot: fixture.root });
      expect(facts.currentStateSchemaVersion).toBe(1);
      expect(facts.migrationHead).toBeNull();
      expect(facts.migrationIdentitySha256).toBe(
        "b545aa0771810a631eeeea9f7b642467e6cca327ba74392298457aab1cec1955",
      );
      assertPackageSourceFactsEqual(facts, { ...facts });
      const provenance = makePackageRuntimeProvenance({
        runtime: "electron-main",
        source: facts,
        payload: compiled("electron-main", "console.log('baseline');", facts),
      });
      expect(decodePackageRuntimeProvenance(JSON.parse(JSON.stringify(provenance))))
        .toEqual(provenance);
      for (const currentStateSchemaVersion of [0, 2]) {
        expect(() => decodePackageRuntimeProvenance({
          ...provenance,
          state: { ...provenance.state, currentStateSchemaVersion },
        })).toThrow(/migration head/u);
      }
      const inventedHead = { fromVersion: 0, toVersion: 1, name: "invented" };
      expect(() => decodePackageRuntimeProvenance({
        ...provenance,
        state: { ...provenance.state, migrationHead: inventedHead },
      })).toThrow(/migration head/u);
      expect(() => assertPackageSourceFactsEqual(facts, {
        ...facts, migrationHead: inventedHead,
      })).toThrow(/migrationHead/u);
      const { migrationHead: _head, ...missingHead } = provenance.state;
      expect(() => decodePackageRuntimeProvenance({
        ...provenance, state: missingHead,
      })).toThrow(/migration head/u);

      const migrationPath = path.join(fixture.root, "src/main/junto/state/migrations.ts");
      const baseline = await readFile(migrationPath, "utf8");
      await writeFile(migrationPath, baseline.replace("const migrations = [];",
        'const migrations = [{ fromVersion: 0, toVersion: 1, name: "invented" }];'));
      await expect(readPackageSchemaFacts(fixture.root)).rejects.toThrow(/baseline must have no migrations/u);
      await writeFile(migrationPath, baseline.replaceAll("VERSION = 1", "VERSION = 2")
        .replaceAll("V1_IDENTITY", "V2_IDENTITY"));
      await expect(readPackageSchemaFacts(fixture.root)).rejects.toThrow(/exactly one migration head/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("admits the repository's actual schema facts", async () => {
    // The source-text reader must agree with the runtime module it parses, so
    // every new state migration moves both sides together.
    const facts = await readPackageSchemaFacts(repoRoot);
    const head = STATE_SCHEMA_MIGRATIONS[STATE_SCHEMA_MIGRATIONS.length - 1]!;
    expect(facts.currentStateSchemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(facts.migrationHead).toEqual({
      fromVersion: head.fromVersion,
      toVersion: head.toVersion,
      name: head.name,
    });
  });

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
    "9.9.9-01",
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
    if (facts.migrationHead === null) throw new Error("fixture requires a migration head");
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
    expect(facts.appVersion).toBe("0.2.0");
    expect(facts.migrationHead.name).toBe(
      "synthetic-migration-head",
    );
  });
});

describe("packaged runtime exact parity", () => {
  it("accepts exact packaged outputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "junto-package-parity-"));
    try {
      const candidate = await createSyntheticLinuxRuntime({ root });
      const receipt = await verifyPackagedRuntimeParity({
        repoRoot: root,
        target: "linux",
        runtimeRoot: candidate.runtimeRoot,
        expected: source,
      });
      expect(receipt.cohortNonce).toBe(cohortNonce);
      expect(receipt.runtimes.electronMain.payloadSha256).toBe(
        receipt.compiledRuntimes.electronMain.payloadSha256,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects internally self-consistent stale main bytes that differ from fresh output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "junto-package-stale-main-"));
    try {
      const staleMain = compiled(
        "electron-main",
        "var CURRENT_STATE_SCHEMA_VERSION=1; var APP_VERSION='0.0.0-stale';\n",
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

  it("the audit receipt decodes and the inventory root follows every runtime file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "junto-runtime-inventory-"));
    try {
      const candidate = await createSyntheticLinuxRuntime({ root });
      const initial = await collectLinuxRuntimeInventory(candidate.runtimeRoot);
      expect(
        decodeLinuxRuntimeAuditReceipt({
          schema: LINUX_RUNTIME_AUDIT_SCHEMA,
          ok: true,
          artifact: "fixture",
          inventory: initial,
          nativeObjects: [],
          chromeSandbox: "absent",
        }),
      ).toMatchObject({ schema: LINUX_RUNTIME_AUDIT_SCHEMA, ok: true });
      for (const relative of [
        "junto",
        "resources/bin/junto",
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
    const root = await mkdtemp(path.join(tmpdir(), "junto-raw-asar-"));
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
    const release = await mkdtemp(path.join(tmpdir(), "junto-dangling-final-"));
    try {
      const version = "1.2.3";
      await mkdir(path.join(release, "linux-unpacked"));
      await writeFile(path.join(release, "linux-unpacked/junto"), "runtime\n");
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
    const release = await mkdtemp(path.join(tmpdir(), "junto-audit-failure-"));
    const attempt = path.join(release, ".junto-package-attempt-forced-failure");
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
    const release = await mkdtemp(path.join(tmpdir(), "junto-publish-link-"));
    const attempt = path.join(release, ".junto-package-attempt-link");
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

describe("official wiring", () => {
  it("builds once and verifies package drafts before publication", async () => {
    const [buildApp, macPackage, linuxPackage] = await Promise.all([
      readFile(path.join(repoRoot, "scripts/build-app.sh"), "utf8"),
      readFile(path.join(repoRoot, "scripts/package-app-macos.sh"), "utf8"),
      readFile(path.join(repoRoot, "scripts/package-app-linux.sh"), "utf8"),
    ]);
    expect(buildApp).toContain('prepare --target "$TARGET"');
    expect(buildApp).not.toContain("--runtime-cohort-only");
    expect(buildApp).not.toContain("preflight --target");
    for (const script of [macPackage, linuxPackage]) {
      expect(script).not.toContain("build-app.sh");
      expect(script).not.toContain("verify-source");
      expect(script).toContain("$ATTEMPT_DIR");
      expect(script.indexOf("verify-package")).toBeLessThan(
        script.indexOf("publish-attempt"),
      );
    }
    expect(PACKAGE_RUNTIME_PROVENANCE_SCHEMA).toContain("v2");
  });
});
