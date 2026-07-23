import {
  generateKeyPairSync,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINUX_RELEASE_CHECKSUMS,
  LINUX_RELEASE_KEYRING,
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_PROTOCOLS,
  LINUX_RELEASE_SIGNATURE,
  createLinuxReleaseManifest,
  decodeLinuxReleaseKeyring,
  releasePublicKeyFingerprint,
  signLinuxReleaseMetadata,
  verifyLinuxReleaseBundle,
  type LinuxReleaseHostFacts,
  type LinuxReleaseKeyring,
} from "../scripts/linux-release-bundle";
import {
  verifyProductionLinuxDeployBundle,
} from "../src/main/vellum/hosts/linux-release-admission";

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
  readonly downgradePolicy?: "forbid" | "explicit-rollback";
  readonly minimumDowngradeVersion?: string;
  readonly testGates?: ReadonlyArray<string>;
  readonly unknownLicenseCount?: number;
  readonly dependencyLicense?: string;
  readonly dependencyLicenseSource?:
    | "package-metadata"
    | "bundled-license-file"
    | "unresolved";
  readonly sbomLicense?: string;
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
    minimumPeerVersion: VERSION,
    keyId: KEY_ID,
    downgradePolicy: options.downgradePolicy ?? "forbid",
    minimumDowngradeVersion:
      options.minimumDowngradeVersion ?? VERSION,
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
    peerVersion: VERSION,
    stationBrowserProtocol: LINUX_RELEASE_PROTOCOLS.stationBrowser,
    workControlProtocol: LINUX_RELEASE_PROTOCOLS.workControl,
    trustedKeyring,
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
      filesVerified: 14,
      packageFile: PACKAGE,
      packageBytes: Buffer.byteLength(
        "synthetic-deb-for-contract-tests",
        "utf8",
      ),
      packageSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("exposes only verified package authority to the production deployer", async () => {
    const fixture = await createFixture();
    const trustedKey = fixture.keyring.keys[0];
    await expect(
      verifyProductionLinuxDeployBundle({
        bundleDirectory: fixture.directory,
        trustedKeyring: fixture.keyring,
        trustedKeyId: trustedKey.keyId,
        trustedKeyFingerprintSha256: trustedKey.fingerprintSha256,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      packagePath: path.join(fixture.directory, PACKAGE),
      bytes: Buffer.byteLength("synthetic-deb-for-contract-tests", "utf8"),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      version: VERSION,
      receipt: {
        ok: true,
        packageFile: PACKAGE,
      },
    });
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

  it("fails target, expiry, package, peer, and protocol checks before admission", async () => {
    const fixture = await createFixture();
    const cases: ReadonlyArray<
      Partial<Parameters<typeof verifyLinuxReleaseBundle>[0]>
    > = [
      { host: { ...host, distributionVersion: "22.04" } },
      { now: Date.parse("2026-08-02T00:00:00.000Z") },
      {
        packageIdentity: {
          packageName: "vellum",
          version: "9.9.9",
          architecture: "amd64",
        },
      },
      { peerVersion: "0.0.9" },
      { stationBrowserProtocol: 2 },
      { workControlProtocol: "vellum-work/v2" },
      { trustedKeyId: "vellum-linux-other" },
      { trustedKeyFingerprintSha256: "0".repeat(64) },
    ];
    for (const candidate of cases) {
      await expect(
        verifyFixture(fixture.directory, candidate),
      ).rejects.toThrow();
    }
  });

  it("requires an explicit signed rollback policy for downgrades", async () => {
    const forbidden = await createFixture();
    await expect(
      verifyFixture(forbidden.directory, {
        installedVersion: "0.2.0",
        allowExplicitRollback: true,
      }),
    ).rejects.toThrow(/downgrade/u);

    const explicit = await createFixture({
      downgradePolicy: "explicit-rollback",
      minimumDowngradeVersion: "0.1.0",
    });
    await expect(
      verifyFixture(explicit.directory, {
        installedVersion: "0.2.0",
      }),
    ).rejects.toThrow(/downgrade/u);
    await expect(
      verifyFixture(explicit.directory, {
        installedVersion: "0.2.0",
        allowExplicitRollback: true,
      }),
    ).resolves.toMatchObject({ ok: true, version: VERSION });
  });

  it("blocks manifest creation with the intentionally empty production keyring", async () => {
    expect(() =>
      decodeLinuxReleaseKeyring({
        schema: "vellum/linux-release-keyring/v1",
        revision: 1,
        keys: [],
      })
    ).toThrow(/no trusted keys/u);
    const empty = await readFile(
      new URL("../build/linux/release-keyring.json", import.meta.url),
      "utf8",
    );
    expect(JSON.parse(empty)).toEqual({
      schema: "vellum/linux-release-keyring/v1",
      revision: 1,
      keys: [],
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
  });

  it("refuses inconsistent dependency inventory and SBOM evidence", async () => {
    await expect(
      createFixture({ sbomLicense: "Apache-2.0" }),
    ).rejects.toThrow(/SBOM does not match/u);
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
