import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { observeLinuxHostCapabilityDoctor } from "../src/shared/linux-host-capability-doctor";
import {
  STATION_QUALIFICATION_EVIDENCE_FILE,
  STATION_QUALIFICATION_MANIFEST_FILE,
  STATION_QUALIFICATION_SCHEMA,
  StationQualificationPackageFile,
  StationQualificationSha256,
  StationQualificationSourceCommit,
  decodeStationQualification,
  pendingStationQualification,
} from "../src/shared/station-qualification";

const hash = (character: string) => character.repeat(64);
const invocationId = (character: string) => character.repeat(32);
const doctorObservation = () => {
  const stdout = [
    ["probe_version", "1"],
    ["platform", "linux"],
    ["architecture", "x86_64"],
    ["os_id", "ubuntu"],
    ["os_version", "24.04"],
    ["glibc_version", "2.39"],
    ["home", "safe-writable"],
    ["home_exec", "ready"],
    ["disk_free_mib", "16384"],
    ["core_userland", "ready"],
    ["missing_binaries", "xvfb,xauth,mcookie"],
    ["runtime_libraries", "ready"],
    ["missing_libraries", "none"],
    ["user_systemd", "ready"],
    ["remote_service", "active"],
    ["linger", "disabled"],
    ["ptmx", "ready"],
    ["devpts", "ready"],
    ["native_pty", "ready"],
    ["xvfb", "missing"],
    ["xauth", "missing"],
    ["mcookie", "missing"],
    ["apparmor", "unavailable"],
    ["apparmor_profile", "not-required"],
    ["userns", "unavailable"],
    ["sandbox", "unavailable"],
    ["secret_storage", "unavailable"],
  ]
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const observation = observeLinuxHostCapabilityDoctor(`${stdout}\n`);
  if (observation === null) {
    throw new Error("invalid Linux Doctor fixture");
  }
  return observation;
};
const nativePlatform = (
  virtualization: "orbstack" | "box" = "orbstack",
) => ({
  os: "linux" as const,
  distribution: "ubuntu" as const,
  version: "24.04" as const,
  architecture: "x64" as const,
  virtualization,
});
const commandCenterHealth = () => ({
  appProcess: "running" as const,
  station: "ready" as const,
});
const remoteHealth = () => ({
  package: "installed" as const,
  service: "running" as const,
  station: "ready" as const,
});
const commandCenterSecurity = () => ({
  rendererSandbox: "active" as const,
  rendererNoNewPrivileges: true as const,
  rendererSeccomp: "filtering" as const,
  userNamespaceIsolation: true as const,
  controlMaterialOwnerOnly: true as const,
  vellumTcpListeners: 0 as const,
});
const remoteSecurity = () => ({
  runtime: "displayless-node" as const,
  mainExecutable:
    `/home/operator/.vellum/runtime/releases/0.1.5-${hash("2")}/resources/bin/node`,
  electronProcesses: 0 as const,
  chromiumRendererProcesses: 0 as const,
  xvfbProcesses: 0 as const,
  displayEnvironment: "unset" as const,
  controlMaterialOwnerOnly: true as const,
  vellumTcpListeners: 0 as const,
  cdpListeners: 0 as const,
});

const qualified = (
  virtualization: "orbstack" | "box" = "orbstack",
) => ({
  schema: STATION_QUALIFICATION_SCHEMA,
  ok: true as const,
  sourceCommit: "a".repeat(40),
  manifest: {
    file: STATION_QUALIFICATION_MANIFEST_FILE,
    sha256: hash("1"),
  },
  package: {
    file: "vellum-runtime-0.1.5-linux-x64.tar.gz",
    bytes: 252_000_000,
    sha256: hash("2"),
  },
  stationProtocol: 3,
  installations: {
    commandCenter: {
      installationId: "cc-01",
      appVersion: "0.1.5",
      nativePlatform: nativePlatform(virtualization),
    },
    remote: {
      installationId: "remote-01",
      appVersion: "0.1.5",
      nativePlatform: nativePlatform(virtualization),
    },
  },
  phases: {
    managedDeploy: "passed" as const,
    initialSync: "passed" as const,
    workRoundTrip: "passed" as const,
    commandCenterOffline: "passed" as const,
    remoteRestart: "passed" as const,
    idempotentRedeploy: "passed" as const,
  },
  health: {
    commandCenter: commandCenterHealth(),
    remote: remoteHealth(),
  },
  doctor: {
    observation: doctorObservation(),
    browserPolicy: "intentionally-unavailable-linux-beta" as const,
  },
  stationVerbs: {
    pair: "request-response-observed" as const,
    configure: "request-response-observed" as const,
    project: "request-response-observed" as const,
    report: "request-response-observed" as const,
    status: "request-response-observed" as const,
  },
  pty: {
    echo: "live-packaged-runtime-observed" as const,
    utf8: "live-packaged-runtime-observed" as const,
    resize: "live-packaged-runtime-observed" as const,
    exit: "live-packaged-runtime-observed" as const,
    shutdown: "live-packaged-runtime-observed" as const,
  },
  deployment: {
    activation: {
      generation: `0.1.5-${hash("2")}`,
      unitExecStart:
        `/home/operator/.vellum/runtime/releases/0.1.5-${hash("2")}/resources/systemd/vellum-remote-launch`,
      conditionExecutable:
        `/home/operator/.vellum/runtime/releases/0.1.5-${hash("2")}/resources/bin/vellum-remote`,
    },
    corruptCandidate: {
      candidateSha256: hash("4"),
      outcome: "rejected-before-activation" as const,
      before: {
        generation: `0.1.5-${hash("2")}`,
        installationId: "remote-01",
        invocationId: invocationId("5"),
      },
      after: {
        generation: `0.1.5-${hash("2")}`,
        installationId: "remote-01",
        invocationId: invocationId("5"),
      },
    },
    restart: {
      before: {
        generation: `0.1.5-${hash("2")}`,
        installationId: "remote-01",
        invocationId: invocationId("5"),
      },
      after: {
        generation: `0.1.5-${hash("2")}`,
        installationId: "remote-01",
        invocationId: invocationId("6"),
      },
    },
    idempotentRedeploy: {
      outcome: "already-active" as const,
      before: {
        generation: `0.1.5-${hash("2")}`,
        installationId: "remote-01",
        invocationId: invocationId("6"),
      },
      after: {
        generation: `0.1.5-${hash("2")}`,
        installationId: "remote-01",
        invocationId: invocationId("6"),
      },
    },
    hostMutation: {
      sudoInvocations: 0 as const,
      privilegedInstallInvocations: 0 as const,
      systemPathMutations: 0 as const,
    },
  },
  security: {
    commandCenter: commandCenterSecurity(),
    remote: remoteSecurity(),
  },
  evidence: {
    file: STATION_QUALIFICATION_EVIDENCE_FILE,
    sha256: hash("3"),
  },
  completedAt: "2026-07-31T12:05:00.000Z",
});

describe("two-installation Station qualification contract", () => {
  it("accepts the strict v3 receipt for the exact exercised release", () => {
    expect(Either.isRight(decodeStationQualification(qualified()))).toBe(true);
  });

  it("mints only a non-passing artifact binding before the real run", () => {
    const pending = pendingStationQualification({
      sourceCommit: Schema.decodeUnknownSync(StationQualificationSourceCommit)(
        "a".repeat(40),
      ),
      manifest: {
        file: STATION_QUALIFICATION_MANIFEST_FILE,
        sha256: Schema.decodeUnknownSync(StationQualificationSha256)(hash("1")),
      },
      package: {
        file: Schema.decodeUnknownSync(StationQualificationPackageFile)(
          "vellum-runtime-0.1.5-linux-x64.tar.gz",
        ),
        bytes: 252_000_000,
        sha256: Schema.decodeUnknownSync(StationQualificationSha256)(hash("2")),
      },
    });

    expect(pending).toMatchObject({
      schema: STATION_QUALIFICATION_SCHEMA,
      ok: false,
      status: "pending",
      reason: "operator-run-required",
    });
    expect(Either.isRight(decodeStationQualification(pending))).toBe(true);
  });

  it.each([
    "managedDeploy",
    "initialSync",
    "workRoundTrip",
    "commandCenterOffline",
    "remoteRestart",
    "idempotentRedeploy",
  ] as const)("requires the %s phase", (phase) => {
    const receipt = qualified();
    const phases = { ...receipt.phases } as Record<string, unknown>;
    delete phases[phase];
    expect(
      Either.isLeft(decodeStationQualification({ ...receipt, phases })),
    ).toBe(true);
  });

  it("requires the full Doctor observation with core and terminal ready and browser unavailable by beta policy", () => {
    const absent = qualified();
    const { doctor: _doctor, ...withoutDoctor } = absent;
    expect(Either.isLeft(decodeStationQualification(withoutDoctor))).toBe(true);

    const coreNotReady = qualified();
    (
      coreNotReady.doctor.observation as { status: string }
    ).status = "unavailable";
    expect(Either.isLeft(decodeStationQualification(coreNotReady))).toBe(true);

    const browserReady = qualified();
    (
      browserReady.doctor.observation.browser as { status: string }
    ).status = "ready";
    expect(Either.isLeft(decodeStationQualification(browserReady))).toBe(true);

    const unintentional = qualified();
    (
      unintentional.doctor as { browserPolicy: string }
    ).browserPolicy = "host-missing-display";
    expect(Either.isLeft(decodeStationQualification(unintentional))).toBe(true);
  });

  it.each([
    "pair",
    "configure",
    "project",
    "report",
    "status",
  ] as const)("requires a real %s Station request/response", (verb) => {
    const receipt = qualified();
    const stationVerbs = {
      ...receipt.stationVerbs,
    } as Record<string, unknown>;
    delete stationVerbs[verb];
    expect(
      Either.isLeft(
        decodeStationQualification({ ...receipt, stationVerbs }),
      ),
    ).toBe(true);
  });

  it.each(["echo", "utf8", "resize", "exit", "shutdown"] as const)(
    "requires live packaged PTY %s proof",
    (operation) => {
      const receipt = qualified();
      const pty = { ...receipt.pty } as Record<string, unknown>;
      delete pty[operation];
      expect(
        Either.isLeft(decodeStationQualification({ ...receipt, pty })),
      ).toBe(true);
    },
  );

  it("binds activation, rejection, restart, and idempotence to the exact active generation", () => {
    const wrongGeneration = qualified();
    wrongGeneration.deployment.activation.generation =
      `0.1.5-${hash("9")}`;
    expect(Either.isLeft(decodeStationQualification(wrongGeneration))).toBe(
      true,
    );

    const corruptMutated = qualified();
    corruptMutated.deployment.corruptCandidate.after.invocationId =
      invocationId("7");
    expect(Either.isLeft(decodeStationQualification(corruptMutated))).toBe(
      true,
    );

    const restartReused = qualified();
    restartReused.deployment.restart.after.invocationId =
      restartReused.deployment.restart.before.invocationId;
    expect(Either.isLeft(decodeStationQualification(restartReused))).toBe(
      true,
    );

    const identityChanged = qualified();
    identityChanged.deployment.restart.after.installationId = "remote-02";
    expect(Either.isLeft(decodeStationQualification(identityChanged))).toBe(
      true,
    );

    const redeployRestarted = qualified();
    redeployRestarted.deployment.idempotentRedeploy.after.invocationId =
      invocationId("8");
    expect(Either.isLeft(decodeStationQualification(redeployRestarted))).toBe(
      true,
    );
  });

  it("requires no privileged or system-path mutation", () => {
    for (const field of [
      "sudoInvocations",
      "privilegedInstallInvocations",
      "systemPathMutations",
    ] as const) {
      const receipt = qualified();
      receipt.deployment.hostMutation[field] = 1 as never;
      expect(Either.isLeft(decodeStationQualification(receipt))).toBe(true);
    }
  });

  it("requires exact health and runtime-security results for both installations", () => {
    const unhealthy = qualified();
    (
      unhealthy.health.remote as {
        service: string;
      }
    ).service = "failed";
    expect(Either.isLeft(decodeStationQualification(unhealthy))).toBe(true);

    const commandCenterService = qualified();
    (
      commandCenterService.health.commandCenter as Record<string, unknown>
    ).service = "running";
    expect(
      Either.isLeft(decodeStationQualification(commandCenterService)),
    ).toBe(true);

    const unsandboxed = qualified();
    (
      unsandboxed.security.commandCenter as {
        rendererSandbox: string;
      }
    ).rendererSandbox = "disabled";
    expect(Either.isLeft(decodeStationQualification(unsandboxed))).toBe(true);

    const electronRemote = qualified();
    (
      electronRemote.security.remote as {
        electronProcesses: number;
      }
    ).electronProcesses = 1;
    expect(Either.isLeft(decodeStationQualification(electronRemote))).toBe(
      true,
    );

    const xvfbRemote = qualified();
    (
      xvfbRemote.security.remote as {
        xvfbProcesses: number;
      }
    ).xvfbProcesses = 1;
    expect(Either.isLeft(decodeStationQualification(xvfbRemote))).toBe(true);

    const displayRemote = qualified();
    (
      displayRemote.security.remote as {
        displayEnvironment: string;
      }
    ).displayEnvironment = "set";
    expect(Either.isLeft(decodeStationQualification(displayRemote))).toBe(true);

    const exposedControlMaterial = qualified();
    (
      exposedControlMaterial.security.commandCenter as {
        controlMaterialOwnerOnly: boolean;
      }
    ).controlMaterialOwnerOnly = false;
    expect(
      Either.isLeft(decodeStationQualification(exposedControlMaterial)),
    ).toBe(true);

    const listening = qualified();
    (
      listening.security.remote as {
        vellumTcpListeners: number;
      }
    ).vellumTcpListeners = 1;
    expect(Either.isLeft(decodeStationQualification(listening))).toBe(true);

    const cdpListening = qualified();
    (
      cdpListening.security.remote as {
        cdpListeners: number;
      }
    ).cdpListeners = 1;
    expect(Either.isLeft(decodeStationQualification(cdpListening))).toBe(true);
  });

  it("binds the exact positive safe-integer package size", () => {
    for (const bytes of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const receipt = qualified();
      receipt.package.bytes = bytes;
      expect(Either.isLeft(decodeStationQualification(receipt))).toBe(true);
    }
  });

  it("requires two distinct installations running the same app version", () => {
    const sameInstallation = qualified();
    sameInstallation.installations.remote.installationId = "cc-01";
    expect(Either.isLeft(decodeStationQualification(sameInstallation))).toBe(
      true,
    );

    const versionSkew = qualified();
    versionSkew.installations.remote.appVersion = "0.1.4";
    expect(Either.isLeft(decodeStationQualification(versionSkew))).toBe(true);
  });

  it("accepts Ubuntu 24.04 x64 guests from either qualified VM provider", () => {
    const boxReceipt = qualified("box");
    expect(Either.isRight(decodeStationQualification(boxReceipt))).toBe(true);

    for (const [field, value] of [
      ["os", "darwin"],
      ["distribution", "debian"],
      ["version", "22.04"],
      ["architecture", "arm64"],
      ["virtualization", "bare-metal"],
    ] as const) {
      const receipt = qualified();
      const platform = receipt.installations.commandCenter.nativePlatform as
        Record<string, string>;
      platform[field] = value;
      expect(Either.isLeft(decodeStationQualification(receipt))).toBe(true);
    }
  });

  it("binds one signed manifest, one userland runtime archive, and one root evidence log", () => {
    const wrongManifest = qualified();
    (wrongManifest.manifest as { file: string }).file = "other.json";
    expect(Either.isLeft(decodeStationQualification(wrongManifest))).toBe(true);

    const wrongEvidence = qualified();
    (wrongEvidence.evidence as { file: string }).file = "attestation.txt";
    expect(Either.isLeft(decodeStationQualification(wrongEvidence))).toBe(true);

    for (const file of [
      ".",
      "..",
      "-option.tar.gz",
      "../vellum-runtime-0.1.5-linux-x64.tar.gz",
      "nested/vellum-runtime-0.1.5-linux-x64.tar.gz",
      "vellum",
      "vellum-runtime-0.1.5-linux-x64.tar.gz\0",
    ]) {
      const receipt = qualified();
      receipt.package.file = file;
      expect(Either.isLeft(decodeStationQualification(receipt))).toBe(true);
    }
  });

  it("rejects earlier schemas, removed theater fields, and all excess properties", () => {
    expect(
      Either.isLeft(
        decodeStationQualification({
          ...qualified(),
          schema: "vellum/station-two-installation-qualification/v1",
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeStationQualification({
          ...qualified(),
          schema: "vellum/station-two-installation-qualification/v2",
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeStationQualification({
          ...qualified(),
          phases: {
            ...qualified().phases,
            syntheticNoOverlap: { outcome: "update-required" },
          },
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeStationQualification({ ...qualified(), extra: true }),
      ),
    ).toBe(true);
  });
});
