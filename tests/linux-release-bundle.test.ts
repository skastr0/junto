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
  createLinuxQualificationCandidateManifest,
  createLinuxReleaseManifest,
  decodeLinuxReleaseKeyring,
  decodeLinuxReleaseManifest,
  decodeLinuxQualificationCandidateManifest,
  linuxQualificationCandidatePayloadFileNames,
  releaseKeyringSha256,
  releasePublicKeyFingerprint,
  signLinuxQualificationCandidateMetadata,
  signLinuxReleaseMetadata,
  verifyLinuxQualificationCandidateBundle,
  verifyLinuxReleaseBundle,
  type LinuxReleaseHostFacts,
  type LinuxReleaseKeyring,
} from "../scripts/linux-release-bundle";
import {
  STATION_QUALIFICATION_EVIDENCE_FILE,
  STATION_QUALIFICATION_MANIFEST_FILE,
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
const QUALIFICATION_EXPIRES_AT = "2026-07-24T11:55:00.000Z";
const KEY_ID = "vellum-linux-2026a";
const PACKAGE = `vellum-runtime-${VERSION}-linux-x64.tar.gz`;
const ciTarget = {
  runner: "ubuntu-24.04",
  os: "linux",
  architecture: "x64",
  machine: "x86_64",
  distribution: "ubuntu",
  distributionVersion: "24.04",
  libc: "glibc",
};
const ciGates = [
  "frozen-install",
  "target-inventory",
  "typecheck",
  "electron-and-cli-compile",
  "native-package",
  "package-audit",
  "userland-runtime-archive",
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
  readonly stationQualificationPackageBytes?: number;
  readonly stationQualificationPackageSha256?: string;
  readonly stationQualificationSourceCommit?: string;
  readonly stationQualificationIncomplete?: boolean;
  readonly stationQualificationPending?: boolean;
  readonly stationQualificationCommandCenterPlatform?:
    | "linux"
    | "macos"
    | "unsupported";
  readonly stationQualificationWrongRemotePlatform?: boolean;
  readonly stationQualificationEvidenceSha256?: string;
  readonly omitStationQualification?: boolean;
  readonly qualificationCandidate?: boolean;
  readonly qualificationExpiresAt?: string;
  readonly chromeSandboxClaim?: "absent" | "present";
  readonly includeRetiredChromeSandboxMode?: boolean;
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
    [PACKAGE]: "synthetic-userland-runtime-archive-for-contract-tests",
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
      artifact: PACKAGE,
      nativeObjects: [],
      chromeSandbox: options.chromeSandboxClaim ?? "absent",
      ...(options.includeRetiredChromeSandboxMode
        ? { chromeSandboxMode: "0755" }
        : {}),
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
      sandboxCapability: "apparmor",
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
            { name: "vellum-command:source-revision", value: REVISION },
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
          { name: "vellum-command:direct", value: "true" },
          { name: "vellum-command:development", value: "false" },
          { name: "vellum-command:license-source", value: "package-metadata" },
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
    Object.entries(payloads)
      .filter(([name]) => name !== STATION_QUALIFICATION_EVIDENCE_FILE)
      .map(([name, body]) =>
      writeFile(path.join(directory, name), body, {
        encoding: "utf8",
        mode: name === "vellum-linux-verify-x64" ? 0o755 : 0o644,
      }),
    ),
  );
  const ciEvidenceManifest = canonical({
    schema: "vellum/linux-release-evidence/v1",
    target: ciTarget,
    source: { commit: REVISION, sourceDateEpoch: 1_784_772_800 },
    publishable: { format: "userland-runtime-archive", file: PACKAGE },
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
  if (options.qualificationCandidate === true) {
    if (status !== "active") {
      return { directory, keys, keyring };
    }
    await createLinuxQualificationCandidateManifest({
      bundleDirectory: directory,
      version: VERSION,
      sourceRevision: REVISION,
      createdAt: CREATED_AT,
      expiresAt:
        options.qualificationExpiresAt ?? QUALIFICATION_EXPIRES_AT,
      keyId: KEY_ID,
    });
    await signLinuxQualificationCandidateMetadata({
      bundleDirectory: directory,
      keyId: KEY_ID,
      privateKeyPem: keys.privateKey.export({
        format: "pem",
        type: "pkcs8",
      }).toString(),
      signedAt: "2026-07-23T11:58:00.000Z",
    });
    return { directory, keys, keyring };
  }
  const candidateDirectory = await mkdtemp(
    path.join(tmpdir(), "vellum-linux-qualification-candidate-"),
  );
  const qualificationDirectory = await mkdtemp(
    path.join(tmpdir(), "vellum-linux-qualification-result-"),
  );
  roots.push(candidateDirectory, qualificationDirectory);
  await writeKeyring(candidateDirectory, keyring);
  await Promise.all([
    ...Object.entries(payloads)
      .filter(([name]) => name !== STATION_QUALIFICATION_EVIDENCE_FILE)
      .map(([name, body]) =>
        writeFile(path.join(candidateDirectory, name), body, {
          encoding: "utf8",
          mode: name === "vellum-linux-verify-x64" ? 0o755 : 0o644,
        }),
      ),
    writeFile(
      path.join(candidateDirectory, "ci-evidence-manifest.json"),
      ciEvidenceManifest,
      { encoding: "utf8", mode: 0o644 },
    ),
    writeFile(
      path.join(
        qualificationDirectory,
        STATION_QUALIFICATION_EVIDENCE_FILE,
      ),
      payloads[STATION_QUALIFICATION_EVIDENCE_FILE],
      { encoding: "utf8", mode: 0o600 },
    ),
  ]);
  await createLinuxQualificationCandidateManifest({
    bundleDirectory: candidateDirectory,
    version: VERSION,
    sourceRevision: REVISION,
    createdAt: CREATED_AT,
    expiresAt: QUALIFICATION_EXPIRES_AT,
    keyId: KEY_ID,
  });
  await signLinuxQualificationCandidateMetadata({
    bundleDirectory: candidateDirectory,
    keyId: KEY_ID,
    privateKeyPem: keys.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }).toString(),
    signedAt: "2026-07-23T11:58:00.000Z",
  });
  const candidateManifestSha256 = sha256(
    await readFile(
      path.join(candidateDirectory, LINUX_RELEASE_MANIFEST),
      "utf8",
    ),
  );
  const qualificationPlatform = (valid: boolean) =>
    valid
      ? {
        os: "linux",
        distribution: "ubuntu",
        version: "24.04",
        architecture: "x64",
        virtualization: "orbstack",
      }
      : {
        os: "windows",
        distribution: "windows",
        version: "11",
        architecture: "x64",
        virtualization: "bare-metal",
      };
  const qualificationPhases: Record<string, string> = {
    managedDeploy: "passed",
    initialSync: "passed",
    workRoundTrip: "passed",
    commandCenterOffline: "passed",
    remoteRestart: "passed",
    idempotentRedeploy: "passed",
  };
  if (options.stationQualificationIncomplete === true) {
    delete qualificationPhases.workRoundTrip;
  }
  const commandCenterHealth = {
    appProcess: "running",
    station: "ready",
  };
  const remoteHealth = {
    package: "installed",
    service: "running",
    station: "ready",
  };
  const commandCenterQualificationSecurity = {
    rendererSandbox: "active",
    rendererNoNewPrivileges: true,
    rendererSeccomp: "filtering",
    userNamespaceIsolation: true,
    controlMaterialOwnerOnly: true,
    vellumTcpListeners: 0,
  };
  const remoteQualificationSecurity = {
    runtime: "displayless-node",
    electronProcesses: 0,
    chromiumRendererProcesses: 0,
    displayEnvironment: "unset",
    controlMaterialOwnerOnly: true,
    vellumTcpListeners: 0,
  };
  const manifestBinding = {
    file: STATION_QUALIFICATION_MANIFEST_FILE,
    sha256: candidateManifestSha256,
  };
  const stationQualification = options.stationQualificationPending === true
    ? {
      schema: STATION_QUALIFICATION_SCHEMA,
      ok: false,
      status: "pending",
      reason: "operator-run-required",
      sourceCommit: options.stationQualificationSourceCommit ?? REVISION,
      manifest: manifestBinding,
      package: {
        file: PACKAGE,
        bytes:
          options.stationQualificationPackageBytes ??
            Buffer.byteLength(payloads[PACKAGE], "utf8"),
        sha256:
          options.stationQualificationPackageSha256 ??
            sha256(payloads[PACKAGE]),
      },
      stationProtocol: CURRENT_STATION_PROTOCOL_SUPPORT.preferred,
    }
    : {
      schema: STATION_QUALIFICATION_SCHEMA,
      ok: true,
      sourceCommit: options.stationQualificationSourceCommit ?? REVISION,
      manifest: manifestBinding,
      package: {
        file: PACKAGE,
        bytes:
          options.stationQualificationPackageBytes ??
            Buffer.byteLength(payloads[PACKAGE], "utf8"),
        sha256:
          options.stationQualificationPackageSha256 ??
            sha256(payloads[PACKAGE]),
      },
      stationProtocol: CURRENT_STATION_PROTOCOL_SUPPORT.preferred,
      installations: {
        commandCenter: {
          installationId: "fixture-command-center",
          appVersion: VERSION,
          nativePlatform: qualificationPlatform(
            options.stationQualificationCommandCenterPlatform === undefined ||
              options.stationQualificationCommandCenterPlatform === "linux",
          ),
        },
        remote: {
          installationId: "fixture-remote",
          appVersion: VERSION,
          nativePlatform: qualificationPlatform(
            options.stationQualificationWrongRemotePlatform !== true,
          ),
        },
      },
      phases: qualificationPhases,
      health: {
        commandCenter: commandCenterHealth,
        remote: remoteHealth,
      },
      security: {
        commandCenter: commandCenterQualificationSecurity,
        remote: remoteQualificationSecurity,
      },
      evidence: {
        file: STATION_QUALIFICATION_EVIDENCE_FILE,
        sha256:
          options.stationQualificationEvidenceSha256 ??
            sha256(payloads[STATION_QUALIFICATION_EVIDENCE_FILE]),
      },
      completedAt: "2026-07-23T11:50:00.000Z",
    };
  const stationQualificationReceipt = canonical(stationQualification);
  if (options.omitStationQualification !== true) {
    await writeFile(
      path.join(
        qualificationDirectory,
        STATION_QUALIFICATION_RECEIPT_FILE,
      ),
      stationQualificationReceipt,
      { encoding: "utf8", mode: 0o644 },
    );
  }
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
      `https://releases.example.test/vellum-runtime-${VERSION}-linux-x64.tar.gz`,
    keyId: KEY_ID,
    qualification: {
      candidateBundleDirectory: candidateDirectory,
      resultDirectory: qualificationDirectory,
    },
  });
  await signLinuxReleaseMetadata({
    bundleDirectory: directory,
    keyId: KEY_ID,
    privateKeyPem: keys.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }).toString(),
    signedAt: "2026-07-23T11:58:00.000Z",
    qualification: {
      candidateBundleDirectory: candidateDirectory,
      resultDirectory: qualificationDirectory,
    },
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

const verifyQualificationFixture = async (
  directory: string,
  overrides: Partial<
    Parameters<typeof verifyLinuxQualificationCandidateBundle>[0]
  > = {},
) => {
  const trustedKeyring = JSON.parse(
    await readFile(path.join(directory, LINUX_RELEASE_KEYRING), "utf8"),
  ) as LinuxReleaseKeyring;
  const trustedKey = trustedKeyring.keys[0];
  return verifyLinuxQualificationCandidateBundle({
    bundleDirectory: directory,
    host,
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

describe("signed Linux qualification candidate", () => {
  it("admits only the short-lived non-publishable pre-qualification inventory", async () => {
    const fixture = await createFixture({ qualificationCandidate: true });
    const manifest = decodeLinuxQualificationCandidateManifest(JSON.parse(
      await readFile(
        path.join(fixture.directory, LINUX_RELEASE_MANIFEST),
        "utf8",
      ),
    ));
    const receipt = await verifyQualificationFixture(fixture.directory);

    expect(manifest).toMatchObject({
      schema: "vellum/linux-qualification-candidate-manifest/v1",
      purpose: "station-qualification-candidate",
      publishable: false,
      source: {
        revision: REVISION,
        ciEvidence: {
          file: "ci-evidence-manifest.json",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      },
      package: {
        file: PACKAGE,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(manifest.files.map(({ file }) => file).sort()).toEqual(
      [...linuxQualificationCandidatePayloadFileNames(VERSION)].sort(),
    );
    expect(manifest.files).toHaveLength(15);
    expect(receipt).toMatchObject({
      schema:
        "vellum/linux-qualification-candidate-verification-receipt/v1",
      ok: true,
      purpose: "station-qualification-candidate",
      publishable: false,
      filesVerified: 15,
      packageSha256: manifest.package.sha256,
      ciEvidenceSha256: manifest.source.ciEvidence.sha256,
    });
    await expect(verifyFixture(fixture.directory)).rejects.toThrow(
      /Linux release manifest/u,
    );
  });

  it("keeps candidate signatures in a distinct purpose domain", async () => {
    const candidate = await createFixture({
      qualificationCandidate: true,
    });
    const stable = await createFixture();
    await writeFile(
      path.join(candidate.directory, LINUX_RELEASE_SIGNATURE),
      await readFile(
        path.join(stable.directory, LINUX_RELEASE_SIGNATURE),
        "utf8",
      ),
    );

    await expect(
      verifyQualificationFixture(candidate.directory),
    ).rejects.toThrow(/qualification candidate signature/u);
  });

  it("rejects post-qualification files and validity windows over 24 hours", async () => {
    const fixture = await createFixture({ qualificationCandidate: true });
    await writeFile(
      path.join(fixture.directory, STATION_QUALIFICATION_EVIDENCE_FILE),
      "not admitted before qualification\n",
    );
    await expect(
      verifyQualificationFixture(fixture.directory),
    ).rejects.toThrow(/missing or extra files/u);

    await expect(
      createFixture({
        qualificationCandidate: true,
        qualificationExpiresAt: "2026-07-24T11:55:00.001Z",
      }),
    ).rejects.toThrow(/validity window/u);
  });

  it("binds the same userland runtime archive hash that the final release admits", async () => {
    const candidate = await createFixture({
      qualificationCandidate: true,
    });
    const stable = await createFixture();
    const [candidateReceipt, stableReceipt] = await Promise.all([
      verifyQualificationFixture(candidate.directory),
      verifyFixture(stable.directory),
    ]);

    expect(candidateReceipt.packageSha256).toBe(stableReceipt.packageSha256);
    expect(candidateReceipt.packageBytes).toBe(stableReceipt.packageBytes);
  });
});

describe("signed Linux release bundle", () => {
  it("verifies both detached signatures, every payload, target, and protocol", async () => {
    const fixture = await createFixture();
    const manifest = decodeLinuxReleaseManifest(JSON.parse(
      await readFile(
        path.join(fixture.directory, LINUX_RELEASE_MANIFEST),
        "utf8",
      ),
    ));
    expect(manifest.schema).toBe("vellum/linux-release-manifest/v7");
    expect(manifest.files.map(({ file }) => file)).not.toEqual(
      expect.arrayContaining([
        STATION_QUALIFICATION_EVIDENCE_FILE,
        STATION_QUALIFICATION_RECEIPT_FILE,
        "release-promotion-receipt.json",
      ]),
    );
    expect(manifest.stationProtocol).toEqual({
      preferred: 5,
      compatibleFrom: 5,
      warnBelow: 5,
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
        libc: { family: "glibc", minimumVersion: "2.39" },
        packageKind: "userland-runtime-archive",
      },
      keyId: KEY_ID,
      keyringRevision: 7,
      signedAt: "2026-07-23T11:58:00.000Z",
      expiresAt: EXPIRES_AT,
      filesVerified: 15,
      bundleFiles: expect.arrayContaining([
        expect.objectContaining({
          file: PACKAGE,
          bytes: Buffer.byteLength(
            "synthetic-userland-runtime-archive-for-contract-tests",
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
        "synthetic-userland-runtime-archive-for-contract-tests",
        "utf8",
      ),
      packageSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("requires both qualification installations to be real Linux OrbStack guests", async () => {
    await expect(
      createFixture({
        stationQualificationCommandCenterPlatform: "macos",
      }),
    ).rejects.toThrow(/passed two-installation Station qualification/u);
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
        await writeFile(path.join(directory, PACKAGE), "different-runtime-archive");
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
          stationApi: "vellum-command/station-api/v3",
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
          preferred: 5,
          compatibleFrom: 4,
          warnBelow: 5,
        },
      }),
    ).resolves.toMatchObject({ ok: true, version: VERSION });
  });

  it("strictly rejects every pre-v7 manifest shape", async () => {
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
          stationApi: "vellum-command/station-api/v3",
          workControl: "vellum-command-work/v1",
          minimumPeerVersion: VERSION,
        },
      })
    ).toThrow(/unsupported|manifest/u);
    expect(() =>
      decodeLinuxReleaseManifest({
        ...manifest,
        schema: "vellum/linux-release-manifest/v5",
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

  it("requires CI evidence to bind the exact signed package", async () => {
    await expect(
      createFixture({ ciEvidencePackageSha256: "0".repeat(64) }),
    ).rejects.toThrow(/does not bind/u);
  });

  it("requires the package receipt to prove chrome-sandbox is absent", async () => {
    await expect(
      createFixture({ chromeSandboxClaim: "present" }),
    ).rejects.toThrow(/package audit receipt/u);
    await expect(
      createFixture({ includeRetiredChromeSandboxMode: true }),
    ).rejects.toThrow(/package audit receipt/u);
  });

  it("requires real two-installation evidence bound to source and package", async () => {
    await expect(
      createFixture({ omitStationQualification: true }),
    ).rejects.toThrow(/not a regular file/u);
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
        stationQualificationPackageBytes: 1,
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
    ).rejects.toThrow(/passed two-installation Station qualification/u);
    await expect(
      createFixture({ stationQualificationWrongRemotePlatform: true }),
    ).rejects.toThrow(/passed two-installation Station qualification/u);
  });

  it("binds one root Station evidence log into the signed final bundle", async () => {
    await expect(
      createFixture({
        stationQualificationEvidenceSha256: "f".repeat(64),
      }),
    ).rejects.toThrow(/does not bind the final release/u);
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
