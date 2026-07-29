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
  LINUX_CI_REQUIRED_GATES,
  createLinuxCiReleaseManifest,
  createLinuxCiTestReceipt,
  findSecretBearingOutput,
  linuxCiChecksumLines,
  parseUbuntuRelease,
  redactLinuxCiLog,
  validateLinuxCiHost,
  validateLinuxReleaseArtifactNames,
  verifyLinuxCiReleaseManifest,
} from "../scripts/linux-ci-evidence";

const roots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "vellum-linux-ci-evidence-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Linux clean-CI target", () => {
  it("accepts only native Ubuntu 24.04 x64 glibc", () => {
    const osRelease = 'ID=ubuntu\nVERSION_ID="24.04"\n';
    expect(parseUbuntuRelease(osRelease)).toBe("24.04");
    expect(validateLinuxCiHost({
      platform: "linux",
      architecture: "x64",
      machine: "x86_64",
      glibc: "glibc 2.39",
      osRelease,
    })).toEqual({
      machine: "x86_64",
      glibc: "glibc 2.39",
      ubuntu: "24.04",
    });
  });

  it.each([
    ["darwin", "x64", "x86_64", "glibc 2.39", 'ID=ubuntu\nVERSION_ID="24.04"\n'],
    ["linux", "arm64", "aarch64", "glibc 2.39", 'ID=ubuntu\nVERSION_ID="24.04"\n'],
    ["linux", "x64", "x86_64", "musl 1.2", 'ID=ubuntu\nVERSION_ID="24.04"\n'],
    ["linux", "x64", "x86_64", "glibc 2.39", 'ID=ubuntu\nVERSION_ID="22.04"\n'],
  ])(
    "rejects unsupported host %s/%s/%s/%s",
    (platform, architecture, machine, glibc, osRelease) => {
      expect(() => validateLinuxCiHost({
        platform,
        architecture,
        machine,
        glibc,
        osRelease,
      })).toThrow();
    },
  );
});

describe("Linux CI gate receipt", () => {
  it("requires every exact gate once and records only passes", () => {
    expect(createLinuxCiTestReceipt([...LINUX_CI_REQUIRED_GATES])).toEqual({
      schema: "vellum/linux-ci-test-receipt/v1",
      ok: true,
      target: {
        runner: "ubuntu-24.04",
        os: "linux",
        architecture: "x64",
        machine: "x86_64",
        debArchitecture: "amd64",
        distribution: "ubuntu",
        distributionVersion: "24.04",
        libc: "glibc",
      },
      gates: LINUX_CI_REQUIRED_GATES.map((name) => ({
        name,
        status: "passed",
      })),
    });
  });

  it("fails closed on a missing, duplicate, or unknown gate", () => {
    expect(() =>
      createLinuxCiTestReceipt(LINUX_CI_REQUIRED_GATES.slice(1)),
    ).toThrow(/missing required/u);
    expect(() =>
      createLinuxCiTestReceipt([
        ...LINUX_CI_REQUIRED_GATES,
        LINUX_CI_REQUIRED_GATES[0],
      ]),
    ).toThrow(/duplicate/u);
    expect(() =>
      createLinuxCiTestReceipt([...LINUX_CI_REQUIRED_GATES, "optional"]),
    ).toThrow(/unknown/u);
  });
});

describe("Linux CI log safety", () => {
  it("redacts workspace, runner, home, and secret material", () => {
    const input = [
      "/home/runner/work/vellum/vellum/src/main.ts",
      "/opt/actions/temp/build.log",
      "/Users/operator/.vellum/work/token",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    ].join("\n");
    const result = redactLinuxCiLog(input, {
      workspace: "/home/runner/work/vellum/vellum",
      runnerTemp: "/opt/actions/temp",
      home: "/Users/operator",
    });
    expect(result.secretDetected).toBe(true);
    expect(result.output).toContain("<workspace>/src/main.ts");
    expect(result.output).toContain("<runner-temp>/build.log");
    expect(result.output).toContain("<home>/.vellum/work/token");
    expect(result.output).toContain("<redacted-secret>");
    expect(result.output).not.toContain("operator");
    expect(findSecretBearingOutput(result.output)).toBe(false);
  });

  it("does not classify ordinary package output as a secret", () => {
    const result = redactLinuxCiLog(
      "electron 43.1.1\nnode-pty 1.1.0\nall tests passed\n",
    );
    expect(result.secretDetected).toBe(false);
    expect(result.output).toContain("all tests passed");
  });
});

describe("Linux release artifact identity", () => {
  it("admits one target-specific deb and diagnostic archive", () => {
    expect(() => validateLinuxReleaseArtifactNames({
      names: [
        "Vellum Command-0.1.0-x64-linux.deb",
        "Vellum Command-0.1.0-x64-linux.unpacked.tar.gz",
      ],
      expectedDeb: "Vellum Command-0.1.0-x64-linux.deb",
      expectedDiagnostic:
        "Vellum Command-0.1.0-x64-linux.unpacked.tar.gz",
    })).not.toThrow();
  });

  it.each([
    "Vellum Command-0.1.0-arm64-linux.deb",
    "Vellum Command-0.1.0-x64-linux.AppImage",
    "vellum-linux-generic.deb",
    "vellum-0.1.0.rpm",
    "vellum-0.1.0.flatpak",
  ])("rejects unsupported artifact %s", (unsupported) => {
    expect(() => validateLinuxReleaseArtifactNames({
      names: [
        "Vellum Command-0.1.0-x64-linux.deb",
        "Vellum Command-0.1.0-x64-linux.unpacked.tar.gz",
        unsupported,
      ],
      expectedDeb: "Vellum Command-0.1.0-x64-linux.deb",
      expectedDiagnostic:
        "Vellum Command-0.1.0-x64-linux.unpacked.tar.gz",
    })).toThrow(/unsupported|one exact/u);
  });

  it("hashes required evidence without embedding absolute paths", async () => {
    const root = await temporaryRoot();
    const release = path.join(root, "release");
    const evidence = path.join(root, "evidence");
    const logs = path.join(evidence, "logs");
    await Promise.all([
      mkdir(release, { recursive: true }),
      mkdir(logs, { recursive: true }),
    ]);
    const packageVersion = JSON.parse(
      await readFile(
        new URL("../package.json", import.meta.url),
        "utf8",
      ),
    ).version as string;
    const deb = `Vellum Command-${packageVersion}-x64-linux.deb`;
    const diagnostic =
      `Vellum Command-${packageVersion}-x64-linux.unpacked.tar.gz`;
    const evidenceNames = [
      diagnostic,
    ];
    await writeFile(path.join(release, deb), "deb");
    await Promise.all(
      evidenceNames.map((name) => writeFile(path.join(evidence, name), name)),
    );
    await writeFile(
      path.join(evidence, "inventory.json"),
      JSON.stringify({
        schema: "vellum/linux-ci-inventory/v1",
        target: {
          runner: "ubuntu-24.04",
          os: "linux",
          architecture: "x64",
          machine: "x86_64",
          debArchitecture: "amd64",
          distribution: "ubuntu",
          distributionVersion: "24.04",
          libc: "glibc",
        },
        source: {
          commit: "a".repeat(40),
          sourceDateEpoch: 1780000000,
        },
      }),
    );
    await writeFile(
      path.join(evidence, "package-audit.json"),
      JSON.stringify({ ok: true, architecture: "amd64" }),
    );
    await writeFile(
      path.join(evidence, "packaged-pty-smoke.json"),
      JSON.stringify({
        ok: true,
        backend: "pty",
        packagedPlacement: true,
        cleanShutdown: true,
        tempRootRemoved: true,
      }),
    );
    await writeFile(
      path.join(evidence, "packaged-runtime-smoke.json"),
      JSON.stringify({
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
    );
    await writeFile(
      path.join(evidence, "test-receipt.json"),
      JSON.stringify(createLinuxCiTestReceipt([...LINUX_CI_REQUIRED_GATES])),
    );
    await writeFile(path.join(logs, "unit.log"), "passed\n");

    const manifest = await createLinuxCiReleaseManifest({
      releaseDirectory: release,
      evidenceDirectory: evidence,
      commit: "a".repeat(40),
      sourceDateEpoch: "1780000000",
    });

    expect(manifest.publishable).toEqual({ format: "deb", file: deb });
    expect(manifest.diagnostic).toEqual({
      format: "tar.gz",
      file: diagnostic,
    });
    expect(manifest.evidence).toHaveLength(8);
    expect(manifest.evidence.every((entry) =>
      (entry.scope === "release" || entry.scope === "evidence") &&
      !entry.file.startsWith("/") &&
      /^[0-9a-f]{64}$/u.test(entry.sha256) &&
      entry.bytes > 0
    )).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(root);
    expect(await readFile(path.join(logs, "unit.log"), "utf8")).toBe("passed\n");
    expect(linuxCiChecksumLines(manifest)).toContain(
      `release/Vellum Command-${packageVersion}-x64-linux.deb`,
    );
    await expect(verifyLinuxCiReleaseManifest({
      manifest,
      releaseDirectory: release,
      evidenceDirectory: evidence,
    })).resolves.toEqual(manifest);

    await writeFile(path.join(evidence, "inventory.json"), "tampered");
    await expect(verifyLinuxCiReleaseManifest({
      manifest,
      releaseDirectory: release,
      evidenceDirectory: evidence,
    })).rejects.toThrow(/hash mismatch/u);
  });
});
