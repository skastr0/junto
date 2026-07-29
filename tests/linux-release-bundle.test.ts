import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINUX_RELEASE_CHECKSUMS,
  LINUX_RELEASE_KEYRING,
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_SIGNATURE,
  createLinuxReleaseManifest,
  decodeLinuxReleaseKeyring,
  decodeLinuxReleaseManifest,
  releaseKeyringSha256,
  releasePublicKeyFingerprint,
  signLinuxReleaseMetadata,
  verifyLinuxReleaseBundle,
  type LinuxReleaseHostFacts,
  type LinuxReleaseKeyring,
} from "../scripts/linux-release-bundle";
import {
  STATION_QUALIFICATION_EVIDENCE_FILE,
  STATION_QUALIFICATION_RECEIPT_FILE,
  STATION_QUALIFICATION_SCHEMA,
} from "../src/shared/station-qualification";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  type StationProtocolSupport,
} from "../src/shared/station-protocol";
import { verifyProductionLinuxDeployBundle } from "../src/main/vellum/hosts/linux-release-admission";

const roots: string[] = [];
const VERSION = "0.1.0";
const REVISION = "a".repeat(40);
const NOW = Date.parse("2026-07-23T12:00:00.000Z");
const CREATED_AT = "2026-07-23T11:55:00.000Z";
const EXPIRES_AT = "2026-08-01T12:00:00.000Z";
const KEY_ID = "vellum-linux-2026a";
const PACKAGE = `Vellum Command-${VERSION}-x64-linux.deb`;
const ciTarget = {
  runner: "ubuntu-24.04",
  os: "linux",
  architecture: "x64",
  machine: "x86_64",
  debArchitecture: "amd64",
  distribution: "ubuntu",
  distributionVersion: "24.04",
  libc: "glibc",
};
const ciGates = [
  "frozen-install",
  "target-inventory",
  "typecheck",
  "complete-unit-suite",
  "electron-and-cli-compile",
  "native-package",
  "package-audit",
  "deb-install",
  "packaged-pty-smoke",
  "packaged-runtime-smoke",
];

const host: LinuxReleaseHostFacts = {
  platform: "linux",
  architecture: "x64",
  machine: "x86_64",
  distribution: "ubuntu",
  distributionVersion: "24.04",
  libcFamily: "glibc",
  libcVersion: "2.39",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const canonical = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const writeKeyring = async (
  directory: string,
  keyring: LinuxReleaseKeyring,
): Promise<void> => {
  await writeFile(
    path.join(directory, LINUX_RELEASE_KEYRING),
    canonical(keyring),
    { encoding: "utf8", mode: 0o644 },
  );
};

const createFixture = async (options: {
  readonly keyStatus?: "active" | "retired" | "revoked";
  readonly testGates?: ReadonlyArray<string>;
  readonly unknownLicenseCount?: number;
  readonly dependencyLicense?: string;
  readonly dependencyLicenseSource?:
    | "package-metadata"
    | "bundled-license-file"
    | "unresolved";
  readonly sbomLicense?: string;
  readonly ciEvidencePackageSha256?: string;
  readonly promotionPackageSha256?: string;
  readonly promotionStationQualificationSha256?: string;
  readonly stationQualificationPackageSha256?: string;
  readonly stationQualificationSourceCommit?: string;
  readonly stationQualificationIncomplete?: boolean;
  readonly stationQualificationPending?: boolean;
  readonly stationQualificationCommandCenterPlatform?:
    | "linux"
    | "macos"
    | "unsupported";
  readonly stationQualificationWrongRemotePlatform?: boolean;
  readonly stationQualificationWitnessFile?: string;
  readonly stationQualificationWitnessMismatchIndex?: number;
  readonly omitStationQualification?: boolean;
} = {}) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "vellum-linux-release-bundle-"),
  );
  roots.push(directory);
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({
    format: "pem",
    type: "spki",
  }).toString();
  const status = options.keyStatus ?? "active";
  const keyring: LinuxReleaseKeyring = {
    schema: "vellum/linux-release-keyring/v1",
    revision: 7,
    keys: [
      {
        keyId: KEY_ID,
        algorithm: "ed25519",
        publicKeyPem,
        fingerprintSha256: releasePublicKeyFingerprint(publicKeyPem),
        status,
        validFrom: "2026-07-01T00:00:00.000Z",
        ...(status === "retired"
          ? { signingEndsAt: "2026-07-30T00:00:00.000Z" }
          : {}),
        ...(status === "revoked"
          ? { revokedAt: "2026-07-22T00:00:00.000Z" }
          : {}),
      },
    ],
  };
  await writeKeyring(directory, keyring);
  const payloads: Readonly<Record<string, string>> = {
    [PACKAGE]: "synthetic-deb-for-contract-tests",
    "build-receipt.json": canonical({
      schema: "vellum/linux-ci-inventory/v1",
      target: ciTarget,
      source: { commit: REVISION, sourceDateEpoch: 1_784_772_800 },
    }),
    "test-receipt.json": canonical({
      schema: "vellum/linux-ci-test-receipt/v1",
      ok: true,
      target: ciTarget,
      gates: (options.testGates ?? ciGates).map((name) => ({
        name,
        status: "passed",
      })),
    }),
    "package-audit.json": canonical({
      ok: true,
      package: "vellum",
      version: VERSION,
      architecture: "amd64",
      chromeSandboxMode: "0755",
      appArmor: "userns",
    }),
    "packaged-pty-smoke.json": canonical({
      ok: true,
      backend: "pty",
      packagedPlacement: true,
      cleanShutdown: true,
      tempRootRemoved: true,
    }),
    "packaged-runtime-smoke.json": canonical({
      ok: true,
      display: "xvfb",
      workCli: "ok",
      browserCli: "ok",
      rendererSandbox: {
        renderers: 1,
        noNewPrivs: true,
        seccomp: true,
      },
      appArmor: "vellum",
      tcpListeners: 0,
      debugAuthority: false,
      secretBearingOutput: false,
      cleanShutdown: true,
      tempRootRemoved: true,
    }),
    [STATION_QUALIFICATION_EVIDENCE_FILE]:
      "Human/operator attestation for one real two-installation Station qualification.\n",
    "dependency-license-inventory.json": canonical({
      schema: "vellum/dependency-license-inventory/v1",
      sourceRevision: REVISION,
      packages: [{
        name: "effect",
        version: "3.0.0",
        direct: true,
        development: false,
        license: options.dependencyLicense ?? "MIT",
        licenseSource:
          options.dependencyLicenseSource ?? "package-metadata",
        purl: "pkg:npm/effect@3.0.0",
      }],
      unknownLicenseCount: options.unknownLicenseCount ?? 0,
    }),
    "sbom.cdx.json": canonical({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          version: VERSION,
          properties: [
            { name: "vellum:source-revision", value: REVISION },
          ],
        },
      },
      components: [{
        type: "library",
        name: "effect",
        version: "3.0.0",
        purl: "pkg:npm/effect@3.0.0",
        licenses: [{ expression: options.sbomLicense ?? "MIT" }],
        properties: [
          { name: "vellum:direct", value: "true" },
          { name: "vellum:development", value: "false" },
          { name: "vellum:license-source", value: "package-metadata" },
        ],
      }],
    }),
    "CHANGELOG.md": "# Vellum Command 0.1.0\n\nExact Linux release notes.\n",
    "source-revision.json": canonical({
      schema: "vellum/source-revision/v1",
      revision: REVISION,
    }),
    "OPERATIONS.md": "# Linux operations\n\nVerify before install.\n",
    "SUPPORT.md": "# Linux v1 support\n\nUbuntu 24.04 x86-64.\n",
    "vellum-linux-verify-x64": "compiled-verifier-placeholder",
  };
  await Promise.all(
    Object.entries(payloads).map(([name, body]) =>
      writeFile(path.join(directory, name), body, {
        encoding: "utf8",
        mode: name === "vellum-linux-verify-x64" ? 0o755 : 0o644,
      })
    ),
  );
  const ciEvidenceManifest = canonical({
    schema: "vellum/linux-release-evidence/v1",
    target: ciTarget,
    source: { commit: REVISION, sourceDateEpoch: 1_784_772_800 },
    publishable: { format: "deb", file: PACKAGE },
    diagnostic: {
      format: "tar.gz",
      file: "Vellum Command-0.1.0-x64-linux.tar.gz",
    },
    evidence: [
      {
        scope: "release",
        file: PACKAGE,
        bytes: Buffer.byteLength(payloads[PACKAGE], "utf8"),
        sha256:
          options.ciEvidencePackageSha256 ?? sha256(payloads[PACKAGE]),
      },
      ...[
        ["inventory.json", "build-receipt.json"],
        ["test-receipt.json", "test-receipt.json"],
        ["package-audit.json", "package-audit.json"],
        ["packaged-pty-smoke.json", "packaged-pty-smoke.json"],
        ["packaged-runtime-smoke.json", "packaged-runtime-smoke.json"],
      ].map(([evidenceFile, signedFile]) => ({
        scope: "evidence",
        file: evidenceFile,
        bytes: Buffer.byteLength(payloads[signedFile], "utf8"),
        sha256: sha256(payloads[signedFile]),
      })),
      {
        scope: "evidence",
        file: "Vellum Command-0.1.0-x64-linux.tar.gz",
        bytes: 32,
        sha256: "d".repeat(64),
      },
      {
        scope: "evidence",
        file: "logs/qualification.log",
        bytes: 16,
        sha256: "e".repeat(64),
      },
    ],
    unsupported: [
      "linux-arm64",
      "musl",
      "appimage",
      "snap",
      "flatpak",
      "rpm",
    ],
  });
  await writeFile(
    path.join(directory, "ci-evidence-manifest.json"),
    ciEvidenceManifest,
    { encoding: "utf8", mode: 0o644 },
  );
  const qualificationWitness = () => {
    const file =
      options.stationQualificationWitnessFile ??
        STATION_QUALIFICATION_EVIDENCE_FILE;
    return {
      file,
      evidenceSha256: sha256(
        payloads[file] ?? payloads[STATION_QUALIFICATION_EVIDENCE_FILE],
      ),
      observedAt: "2026-07-23T11:45:00.000Z",
    };
  };
  const qualificationCursor = (
    eventHome: string,
    entityHome: string,
    through: string,
  ) => ({ eventHome, entityHome, through });
  const qualificationConvergence = {
    commandCenterReceived:
      qualificationCursor("fixture-remote", "fixture-remote", "2"),
    remoteAcknowledgedByCommandCenter:
      qualificationCursor("fixture-remote", "fixture-remote", "2"),
    remoteReceived:
      qualificationCursor("fixture-command-center", "fixture-command-center", "3"),
    commandCenterAcknowledgedByRemote:
      qualificationCursor("fixture-command-center", "fixture-command-center", "3"),
  };
  const qualificationPlatform = (
    kind: "linux" | "macos" | "unsupported",
  ) => {
    if (kind === "linux") {
      return {
        os: "linux",
        distribution: "ubuntu",
        version: "24.04",
        architecture: "x64",
      };
    }
    if (kind === "macos") {
      return {
        os: "darwin",
        distribution: "macos",
        version: "15.5",
        architecture: "arm64",
      };
    }
    return {
      os: "windows",
      distribution: "windows",
      version: "11",
      architecture: "x64",
    };
  };
  const qualificationPhases = {
    pair: { witness: qualificationWitness() },
    configure: { witness: qualificationWitness() },
    project: { witness: qualificationWitness() },
    report: {
      witness: qualificationWitness(),
      convergence: qualificationConvergence,
    },
    status: { witness: qualificationWitness() },
    commandCenterOfflineClaimedTask: {
      witness: qualificationWitness(),
      taskId: "fixture-task",
      advancedState: "completed",
    },
    projectResponseRetry: {
      interruptionWitness: qualificationWitness(),
      retryWitness: qualificationWitness(),
      outcome: "idempotent",
    },
    reportResponseRetry: {
      interruptionWitness: qualificationWitness(),
      retryWitness: qualificationWitness(),
      convergence: qualificationConvergence,
    },
    doctor: {
      commandCenter: {
        status: "ok",
        witness: qualificationWitness(),
      },
      remote: {
        status: "ok",
        witness: qualificationWitness(),
      },
    },
    syntheticNoOverlap: {
      synthetic: true,
      witness: qualificationWitness(),
      commandCenterSupport: {
        preferred: 4,
        compatibleFrom: 3,
        warnBelow: 3,
      },
      remoteSupport: {
        preferred: 2,
        compatibleFrom: 1,
        warnBelow: 1,
      },
      outcome: "update-required",
    },
  };
  const qualificationWitnesses = [
    qualificationPhases.pair.witness,
    qualificationPhases.configure.witness,
    qualificationPhases.project.witness,
    qualificationPhases.report.witness,
    qualificationPhases.status.witness,
    qualificationPhases.commandCenterOfflineClaimedTask.witness,
    qualificationPhases.projectResponseRetry.interruptionWitness,
    qualificationPhases.projectResponseRetry.retryWitness,
    qualificationPhases.reportResponseRetry.interruptionWitness,
    qualificationPhases.reportResponseRetry.retryWitness,
    qualificationPhases.doctor.commandCenter.witness,
    qualificationPhases.doctor.remote.witness,
    qualificationPhases.syntheticNoOverlap.witness,
  ];
  if (options.stationQualificationWitnessMismatchIndex !== undefined) {
    const witness = qualificationWitnesses[
      options.stationQualificationWitnessMismatchIndex
    ];
    if (witness === undefined) {
      throw new Error("invalid Station qualification witness fixture index");
    }
    witness.evidenceSha256 = "f".repeat(64);
  }
  const { report: _report, ...incompleteQualificationPhases } =
    qualificationPhases;
  const stationQualification = options.stationQualificationPending === true
    ? {
      schema: STATION_QUALIFICATION_SCHEMA,
      ok: false,
      status: "pending",
      reason: "operator-run-required",
      sourceCommit: options.stationQualificationSourceCommit ?? REVISION,
      package: {
        file: PACKAGE,
        sha256:
          options.stationQualificationPackageSha256 ??
            sha256(payloads[PACKAGE]),
      },
      stationProtocol: 2,
    }
    : {
      schema: STATION_QUALIFICATION_SCHEMA,
      ok: true,
      sourceCommit: options.stationQualificationSourceCommit ?? REVISION,
      package: {
        file: PACKAGE,
        sha256:
          options.stationQualificationPackageSha256 ??
            sha256(payloads[PACKAGE]),
      },
      stationProtocol: 2,
      installations: {
        commandCenter: {
          installationId: "fixture-command-center",
          appVersion: VERSION,
          nativePlatform: qualificationPlatform(
            options.stationQualificationCommandCenterPlatform ?? "linux",
          ),
        },
        remote: {
          installationId: "fixture-remote",
          appVersion: VERSION,
          nativePlatform: qualificationPlatform(
            options.stationQualificationWrongRemotePlatform === true
              ? "unsupported"
              : "linux",
          ),
        },
      },
      phases: options.stationQualificationIncomplete === true
        ? incompleteQualificationPhases
        : qualificationPhases,
      completedAt: "2026-07-23T11:50:00.000Z",
    };
  const stationQualificationReceipt = canonical(stationQualification);
  if (options.omitStationQualification !== true) {
    await writeFile(
      path.join(directory, STATION_QUALIFICATION_RECEIPT_FILE),
      stationQualificationReceipt,
      { encoding: "utf8", mode: 0o644 },
    );
  }
  await writeFile(
    path.join(directory, "release-promotion-receipt.json"),
    canonical({
      schema: "vellum/release-promotion-gate/v2",
      ok: true,
      publishable: false,
      releaseAuthorization: "not-granted",
      sourceCommit: REVISION,
      qualifications: {
        macosVerification: "passed",
        ubuntu2404X64Package: "passed",
      },
      ciEvidence: {
        file: "ci-evidence-manifest.json",
        sha256: sha256(ciEvidenceManifest),
      },
      stationQualification: {
        file: STATION_QUALIFICATION_RECEIPT_FILE,
        sha256:
          options.promotionStationQualificationSha256 ??
            sha256(stationQualificationReceipt),
      },
      package: {
        file: PACKAGE,
        bytes: Buffer.byteLength(payloads[PACKAGE], "utf8"),
        sha256:
          options.promotionPackageSha256 ?? sha256(payloads[PACKAGE]),
      },
      workflowRun: {
        repository: "skastr0/vellum",
        runId: 123,
        runAttempt: 1,
      },
    }),
    { encoding: "utf8", mode: 0o644 },
  );
  if (status !== "active") {
    return { directory, keys, keyring };
  }
  await createLinuxReleaseManifest({
    bundleDirectory: directory,
    version: VERSION,
    sourceRevision: REVISION,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    downloadLocator:
      `https://releases.example.test/vellum-${VERSION}-ubuntu-24.04-x64-release.tar.gz`,
    keyId: KEY_ID,
  });
  await signLinuxReleaseMetadata({
    bundleDirectory: directory,
    keyId: KEY_ID,
    privateKeyPem: keys.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }).toString(),
    signedAt: "2026-07-23T11:58:00.000Z",
  });
  return { directory, keys, keyring };
};

const verifyFixture = async (
  directory: string,
  overrides: Partial<Parameters<typeof verifyLinuxReleaseBundle>[0]> = {},
) => {
  const trustedKeyring = JSON.parse(
    await readFile(path.join(directory, LINUX_RELEASE_KEYRING), "utf8"),
  ) as LinuxReleaseKeyring;
  const trustedKey = trustedKeyring.keys[0];
  return verifyLinuxReleaseBundle({
    bundleDirectory: directory,
    host,
    packageIdentity: {
      packageName: "vellum",
      version: VERSION,
      architecture: "amd64",
    },
    peerStationProtocol: CURRENT_STATION_PROTOCOL_SUPPORT,
    trustedKeyring,
    trustedKeyringRevision: trustedKeyring.revision,
    trustedKeyringSha256: releaseKeyringSha256(trustedKeyring),
    trustedKeyId: trustedKey?.keyId ?? KEY_ID,
    trustedKeyFingerprintSha256:
      trustedKey?.fingerprintSha256 ?? "0".repeat(64),
    now: NOW,
    ...overrides,
  });
};

describe("signed Linux release bundle", () => {
  it("verifies both detached signatures, every payload, target, and protocol", async () => {
    const fixture = await createFixture();
    const manifest = decodeLinuxReleaseManifest(JSON.parse(
      await readFile(
        path.join(fixture.directory, LINUX_RELEASE_MANIFEST),
        "utf8",
      ),
    ));
    expect(manifest.schema).toBe("vellum/linux-release-manifest/v5");
    expect(manifest.stationProtocol).toEqual({
      preferred: 2,
      compatibleFrom: 2,
      warnBelow: 2,
    });
    await expect(verifyFixture(fixture.directory)).resolves.toEqual({
      schema: "vellum/linux-release-verification-receipt/v1",
      ok: true,
      version: VERSION,
      sourceRevision: REVISION,
      target: {
        os: "linux",
        distribution: "ubuntu",
        distributionVersion: "24.04",
        architecture: "x64",
        machine: "x86_64",
        debArchitecture: "amd64",
        libc: { family: "glibc", minimumVersion: "2.39" },
        packageKind: "deb",
      },
      keyId: KEY_ID,
      keyringRevision: 7,
      signedAt: "2026-07-23T11:58:00.000Z",
      expiresAt: EXPIRES_AT,
      filesVerified: 18,
      bundleFiles: expect.arrayContaining([
        expect.objectContaining({
          file: PACKAGE,
          bytes: Buffer.byteLength(
            "synthetic-deb-for-contract-tests",
            "utf8",
          ),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
        expect.objectContaining({
          file: LINUX_RELEASE_MANIFEST,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
        expect.objectContaining({
          file: LINUX_RELEASE_SIGNATURE,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
        expect.objectContaining({
          file: LINUX_RELEASE_CHECKSUMS,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      ]),
      packageFile: PACKAGE,
      packageBytes: Buffer.byteLength(
        "synthetic-deb-for-contract-tests",
        "utf8",
      ),
      packageSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("accepts a supported macOS Command Center qualifying the Linux Remote", async () => {
    const fixture = await createFixture({
      stationQualificationCommandCenterPlatform: "macos",
    });
    await expect(verifyFixture(fixture.directory)).resolves.toMatchObject({
      ok: true,
      packageFile: PACKAGE,
    });
  });

  it("fails production deploy when the bundle is not signed by the configured key", async () => {
    // Fixture mints its own ed25519 key; production admission uses the
    // checked-in keyring pin. A foreign signature must never admit.
    const fixture = await createFixture();
    await expect(
      verifyProductionLinuxDeployBundle({
        bundleDirectory: fixture.directory,
        now: Date.parse("2026-07-29T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/signature|trusted|key|fingerprint|mismatch|keyring/iu);
  });

  it("rejects tampered metadata, payloads, checksums, and undeclared extras", async () => {
    const cases = [
      async (directory: string) => {
        await writeFile(
          path.join(directory, LINUX_RELEASE_MANIFEST),
          `${await readFile(path.join(directory, LINUX_RELEASE_MANIFEST), "utf8")} `,
        );
      },
      async (directory: string) => {
        await writeFile(path.join(directory, PACKAGE), "different-deb");
      },
      async (directory: string) => {
        await writeFile(
          path.join(directory, LINUX_RELEASE_CHECKSUMS),
          "0".repeat(64) + `  ${PACKAGE}\n`,
        );
      },
      async (directory: string) => {
        const signature = JSON.parse(
          await readFile(
            path.join(directory, LINUX_RELEASE_SIGNATURE),
            "utf8",
          ),
        ) as { signedAt: string };
        signature.signedAt = "2026-07-23T11:59:00.000Z";
        await writeFile(
          path.join(directory, LINUX_RELEASE_SIGNATURE),
          canonical(signature),
        );
      },
      async (directory: string) => {
        await writeFile(path.join(directory, "unexpected.txt"), "extra");
      },
      async (directory: string) => {
        await rm(path.join(directory, PACKAGE));
        await symlink(LINUX_RELEASE_MANIFEST, path.join(directory, PACKAGE));
      },
    ];
    for (const mutate of cases) {
      const fixture = await createFixture();
      await mutate(fixture.directory);
      await expect(verifyFixture(fixture.directory)).rejects.toThrow();
    }
  });

  it("rejects revoked and substituted trust roots", async () => {
    const revoked = await createFixture();
    await writeKeyring(revoked.directory, {
      ...revoked.keyring,
      revision: 8,
      keys: revoked.keyring.keys.map((key) => ({
        ...key,
        status: "revoked" as const,
        revokedAt: "2026-07-23T10:00:00.000Z",
      })),
    });
    await expect(verifyFixture(revoked.directory)).rejects.toThrow(/revoked/u);

    const substituted = await createFixture();
    const attacker = generateKeyPairSync("ed25519").publicKey.export({
      format: "pem",
      type: "spki",
    }).toString();
    await writeKeyring(substituted.directory, {
      ...substituted.keyring,
      revision: 8,
      keys: substituted.keyring.keys.map((key) => ({
        ...key,
        publicKeyPem: attacker,
        fingerprintSha256: releasePublicKeyFingerprint(attacker),
      })),
    });
    await expect(verifyFixture(substituted.directory)).rejects.toThrow(
      /signature/u,
    );
  });

  it("fails target, expiry, package, peer range, and trust checks before admission", async () => {
    const fixture = await createFixture();
    const cases: ReadonlyArray<
      Partial<Parameters<typeof verifyLinuxReleaseBundle>[0]>
    > = [
      { host: { ...host, distributionVersion: "22.04" } },
      { now: Date.parse("2026-08-02T00:00:00.000Z") },
      { now: Number.NaN },
      {
        packageIdentity: {
          packageName: "vellum",
          version: "9.9.9",
          architecture: "amd64",
        },
      },
      {
        peerStationProtocol: {
          preferred: 1,
          compatibleFrom: 1,
          warnBelow: 1,
        },
      },
      {
        peerStationProtocol: {
          preferred: 2,
          compatibleFrom: 3,
          warnBelow: 2,
        } as StationProtocolSupport,
      },
      {
        peerStationProtocol: {
          preferred: 2,
          compatibleFrom: 2,
          warnBelow: 2,
          stationApi: "vellum/station-api/v2",
        } as unknown as StationProtocolSupport,
      },
      { trustedKeyId: "vellum-linux-other" },
      { trustedKeyringRevision: 8 },
      { trustedKeyringSha256: "0".repeat(64) },
      { trustedKeyFingerprintSha256: "0".repeat(64) },
    ];
    for (const candidate of cases) {
      await expect(
        verifyFixture(fixture.directory, candidate),
      ).rejects.toThrow();
    }
  });

  it("accepts a deprecated but exact overlapping Station codec", async () => {
    const fixture = await createFixture();
    await expect(
      verifyFixture(fixture.directory, {
        peerStationProtocol: {
          preferred: 3,
          compatibleFrom: 2,
          warnBelow: 3,
        },
      }),
    ).resolves.toMatchObject({ ok: true, version: VERSION });
  });

  it("strictly rejects the retired multi-axis v3 manifest shape", async () => {
    const fixture = await createFixture();
    const manifest = JSON.parse(
      await readFile(
        path.join(fixture.directory, LINUX_RELEASE_MANIFEST),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const { stationProtocol: _, ...withoutStationProtocol } = manifest;
    expect(() =>
      decodeLinuxReleaseManifest({
        ...withoutStationProtocol,
        schema: "vellum/linux-release-manifest/v3",
        protocols: {
          stationApi: "vellum/station-api/v2",
          workControl: "vellum-work/v1",
          minimumPeerVersion: VERSION,
        },
      })
    ).toThrow(/unsupported|manifest/u);
  });

  it("rejects every downgrade after cutover", async () => {
    const fixture = await createFixture();
    await expect(
      verifyFixture(fixture.directory, { installedVersion: "0.2.0" }),
    ).rejects.toThrow(/downgrade/u);
  });

  it("rejects empty keyrings and pins the checked-in active release key", async () => {
    expect(() =>
      decodeLinuxReleaseKeyring({
        schema: "vellum/linux-release-keyring/v1",
        revision: 1,
        keys: [],
      })
    ).toThrow(/no trusted keys/u);
    const checkedIn = JSON.parse(
      await readFile(
        new URL("../build/linux/release-keyring.json", import.meta.url),
        "utf8",
      ),
    ) as {
      readonly schema: string;
      readonly revision: number;
      readonly keys: ReadonlyArray<{ readonly keyId: string; readonly status: string }>;
    };
    expect(checkedIn).toMatchObject({
      schema: "vellum/linux-release-keyring/v1",
      revision: 1,
    });
    expect(checkedIn.keys).toHaveLength(1);
    expect(checkedIn.keys[0]).toMatchObject({
      keyId: "vellum-linux-2026a",
      status: "active",
    });
  });

  it("refuses to sign a bundle whose receipts do not prove every gate", async () => {
    await expect(
      createFixture({ testGates: ciGates.slice(1) }),
    ).rejects.toThrow(/every release gate/u);
  });

  it("refuses to create signed metadata with unresolved dependency rights", async () => {
    await expect(
      createFixture({ unknownLicenseCount: 1 }),
    ).rejects.toThrow(/unresolved rights/u);
    await expect(
      createFixture({
        dependencyLicense: "UNKNOWN",
        dependencyLicenseSource: "unresolved",
      }),
    ).rejects.toThrow(/unresolved rights/u);
    await expect(
      createFixture({
        dependencyLicense: "Definitely-Not-A-License",
        sbomLicense: "Definitely-Not-A-License",
      }),
    ).rejects.toThrow(/unresolved rights/u);
  });

  it("refuses inconsistent dependency inventory and SBOM evidence", async () => {
    await expect(
      createFixture({ sbomLicense: "Apache-2.0" }),
    ).rejects.toThrow(/SBOM does not match/u);
  });

  it("requires CI and promotion receipts to bind the exact signed package", async () => {
    await expect(
      createFixture({ ciEvidencePackageSha256: "0".repeat(64) }),
    ).rejects.toThrow(/does not bind/u);
    await expect(
      createFixture({ promotionPackageSha256: "0".repeat(64) }),
    ).rejects.toThrow(/promotion receipt/u);
  });

  it("requires real two-installation evidence bound to source and package", async () => {
    await expect(
      createFixture({ omitStationQualification: true }),
    ).rejects.toThrow(/missing or extra files/u);
    await expect(
      createFixture({
        stationQualificationSourceCommit: "b".repeat(40),
      }),
    ).rejects.toThrow(/two-installation Station qualification/u);
    await expect(
      createFixture({
        stationQualificationPackageSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/two-installation Station qualification/u);
    await expect(
      createFixture({
        stationQualificationIncomplete: true,
      }),
    ).rejects.toThrow(/passed two-installation Station qualification/u);
    await expect(
      createFixture({ stationQualificationPending: true }),
    ).rejects.toThrow(/passed two-installation Station qualification/u);
    await expect(
      createFixture({
        stationQualificationCommandCenterPlatform: "unsupported",
      }),
    ).rejects.toThrow(/does not bind the signed release/u);
    await expect(
      createFixture({ stationQualificationWrongRemotePlatform: true }),
    ).rejects.toThrow(/does not bind the signed release/u);
    await expect(
      createFixture({
        promotionStationQualificationSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/promotion receipt/u);
  });

  it("binds every nested Station witness to signed operator evidence", async () => {
    for (let index = 0; index < 13; index += 1) {
      await expect(
        createFixture({
          stationQualificationWitnessMismatchIndex: index,
        }),
      ).rejects.toThrow(/bind signed operator evidence/u);
    }
    await expect(
      createFixture({
        stationQualificationWitnessFile: "test-receipt.json",
      }),
    ).rejects.toThrow(/bind signed operator evidence/u);
  });

  it("never emits private key material into signed metadata", async () => {
    const fixture = await createFixture();
    const privateKey = fixture.keys.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }).toString();
    const publicFiles = await Promise.all(
      [
        LINUX_RELEASE_MANIFEST,
        LINUX_RELEASE_SIGNATURE,
        LINUX_RELEASE_CHECKSUMS,
        LINUX_RELEASE_KEYRING,
      ].map((name) => readFile(path.join(fixture.directory, name), "utf8")),
    );
    expect(publicFiles.join("\n")).not.toContain(privateKey);
    expect(publicFiles.join("\n")).not.toContain("PRIVATE KEY");
    expect(publicFiles.join("\n")).not.toContain(fixture.directory);
  });
});
