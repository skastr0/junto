import {
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STATION_API_PROTOCOL } from "../src/shared/station-api";
import { STATION_CONTROL_PROTOCOL } from "../src/shared/station-api-envelope";
import { STATION_SESSION_PROTOCOL } from "../src/shared/station-session";
import {
  inspectManagedArtifact,
  inspectQualificationCandidateArtifact,
  managedBundleRelativeDestination,
  parseQualificationArgs,
  qualificationMachineNames,
  requireRunId,
  runQualification,
  stageManagedBundle,
  type CommandExecutor,
  type CommandRequest,
  type CommandResult,
  type QualificationRunState,
} from "../scripts/linux-orbstack-two-station-qualification";

const OBSERVATION_SCHEMA = "vellum/linux-orbstack-observation/v1";
const RUN_STATE_SCHEMA = "vellum/linux-orbstack-run-state/v2";
const NOW = "2026-07-31T12:00:00.000Z";

const machine = (side: "cc" | "remote") => ({
  id: side === "cc"
    ? "01QUALIFICATIONCOMMANDCENTER000"
    : "01QUALIFICATIONREMOTE0000000000",
  name: `vellum-q-release-015-${side}`,
  username: "operator",
});

const preparedState = (
  changes: Partial<QualificationRunState> = {},
): QualificationRunState => {
  const kind = changes.kind ?? "qualification-candidate";
  const managedArtifact = {
    version: "0.1.5",
    sourceCommit: "a".repeat(40),
    debFile: "Vellum Command-0.1.5-x64-linux.deb",
    debBytes: 123,
    debSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
    stationProtocol: 3 as const,
    bundleFiles: [
      "release-manifest.json",
      "release-manifest.sig",
      "SHA256SUMS",
      "Vellum Command-0.1.5-x64-linux.deb",
    ],
    verification: kind === "final-release"
      ? {
          schema: "vellum/linux-release-verification-receipt/v1" as const,
          keyId: "vellum-linux-2026a",
          keyringRevision: 1,
          signedAt: NOW,
          expiresAt: "2026-08-01T12:00:00.000Z",
          filesVerified: 1,
        }
      : {
          schema:
            "vellum/linux-qualification-candidate-verification-receipt/v1" as const,
          keyId: "vellum-linux-2026a",
          keyringRevision: 1,
          signedAt: NOW,
          expiresAt: "2026-08-01T12:00:00.000Z",
          filesVerified: 1,
          purpose: "station-qualification-candidate" as const,
          publishable: false as const,
          ciEvidenceSha256: "d".repeat(64),
        },
  };
  return {
    schema: RUN_STATE_SCHEMA,
    runId: "release-015",
    kind,
    commandCenterMode: "new-activation-checkpoint",
    golden: {
      id: "01QUALIFICATIONGOLDEN000000000",
      name: "vellum-ubuntu-x64-golden",
      username: "operator",
    },
    machines: {
      commandCenter: machine("cc"),
      remote: machine("remote"),
    },
    artifact: managedArtifact,
    prepared: true,
    managedRunAttempted: false,
    managedDeployReady: false,
    failed: false,
    cleaned: false,
    ...changes,
  };
};

const evidenceDirectory = (
  state: QualificationRunState = preparedState(),
): string => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "vellum-orbstack-qualification-"),
  );
  writeFileSync(
    path.join(directory, "station-qualification-observations.jsonl"),
    `${JSON.stringify({
      schema: OBSERVATION_SCHEMA,
      at: NOW,
      runId: state.runId,
      event: "prepared",
      status: "passed",
      detail: {},
      state,
    })}\n`,
    "utf8",
  );
  return directory;
};

const ok = (stdout = ""): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

const operatorEnvelope = (
  command: string,
  data: Record<string, unknown>,
): CommandResult =>
  ok(`${JSON.stringify({ ok: true, command, data })}\n`);

const remoteStationStatus = () => ({
  protocol: STATION_API_PROTOCOL,
  op: "status",
  installationId: "installation-remote",
  state: "ready",
  configuration: {
    role: "remote",
    hostId: "q-release-015-remote",
    agentHostId: "q-release-015-remote",
    commandCenterInstallationId: "installation-cc",
    supervisedPreferred: true,
  },
  receivedThrough: [],
  peerAcknowledgedThrough: [],
  readiness: {
    database: true,
    workControl: true,
    simulation: true,
    session: true,
  },
  observedAt: NOW,
});

const commandCenterStationStatus = () => ({
  protocol: STATION_API_PROTOCOL,
  op: "status",
  installationId: "installation-cc",
  state: "ready",
  configuration: {
    role: "command-center",
    hostId: "local",
    supervisedPreferred: true,
  },
  receivedThrough: [],
  peerAcknowledgedThrough: [],
  readiness: {
    database: true,
    workControl: true,
    simulation: true,
    session: true,
  },
  observedAt: NOW,
});

const offlineRemoteStationStatus = () => ({
  ...remoteStationStatus(),
  state: "degraded",
  readiness: {
    database: true,
    workControl: true,
    simulation: true,
    session: false,
  },
});

const fleetSyncData = () => ({
  results: [
    {
      ok: true,
      hostId: "q-release-015-remote",
      stationInstallationId: "installation-remote",
      receipt: { remoteStatus: remoteStationStatus() },
    },
  ],
});

const fleetStatusData = () => ({
  peers: [
    {
      hostId: "q-release-015-remote",
      stationInstallationId: "installation-remote",
      phase: "ready",
      sessionOpen: true,
    },
  ],
});

const fixedStationStatus = (request: CommandRequest): CommandResult => {
  const requestFrame = JSON.parse(request.input ?? "{}") as {
    readonly requestId?: string;
  };
  return ok(
    `${JSON.stringify({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "response",
      requestId: requestFrame.requestId,
      envelope: {
        protocol: STATION_CONTROL_PROTOCOL,
        ok: true,
        response: request.args.some((arg) => arg.includes("-cc@orb"))
          ? commandCenterStationStatus()
          : remoteStationStatus(),
      },
    })}\n`,
  );
};

const orbInfo = (
  name: string,
  id: string,
  state = "running",
): CommandResult =>
  ok(
    `${JSON.stringify({
      record: {
        id,
        name,
        state,
        image: {
          distro: "ubuntu",
          version: "noble",
          arch: "amd64",
        },
        config: { default_username: "operator" },
      },
    })}\n`,
  );

const operatorCommandFrom = (
  request: CommandRequest,
): string | undefined => {
  const index = request.args.indexOf("/usr/bin/vellum");
  if (index < 0) return undefined;
  const args = request.args.slice(index + 1);
  if (args[0] === "station") {
    return `station.${args[1]}`;
  }
  if (args[0] === "fleet") {
    return `fleet.${args[1]}`;
  }
  if (args[0] === "qualification" && args[1] === "work") {
    return `qualification.work.${args[2]}`;
  }
  return undefined;
};

const qualificationIdentity = (receivedThrough: string) => ({
  runId: "release-015",
  canvasName: "Station qualification release-015",
  hostId: "q-release-015-remote",
  stationInstallationId: "installation-remote",
  taskId: "qualification-task-release-015",
  actor: {
    seatId: "qualification-seat-release-015",
    canvasName: "Station qualification release-015",
    nodeId: "qualification-actor-release-015",
  },
  receivedThrough,
});

const stagingArtifact = {
  canonicalBundleDirectory: "/tmp/signed-candidate",
  bundleFiles: [
    "release-manifest.json",
    "release-manifest.sig",
    "SHA256SUMS",
    "Vellum Command-0.1.5-x64-linux.deb",
  ],
  debFile: "Vellum Command-0.1.5-x64-linux.deb",
  debSha256: "b".repeat(64),
  manifestSha256: "c".repeat(64),
};

const cacheRotationExecutor = (
  initialManifestSha256: string,
): {
  readonly executor: CommandExecutor;
  readonly calls: CommandRequest[];
} => {
  const calls: CommandRequest[] = [];
  const current =
    "/home/operator/.vellum/releases/linux-x64-glibc/qualification/current/";
  const staging =
    `/home/operator/.vellum/releases/linux-x64-glibc/qualification/staging/${stagingArtifact.manifestSha256}`;
  const archive =
    `/home/operator/.vellum/releases/linux-x64-glibc/qualification/archive/${initialManifestSha256}`;
  let currentPresent = true;
  let stagingPresent = false;
  let archivePresent = false;
  let currentManifestSha256 = initialManifestSha256;
  const exists = (candidate: string): boolean => {
    if (candidate === current || candidate === current.slice(0, -1)) {
      return currentPresent;
    }
    if (candidate === staging) return stagingPresent;
    if (candidate === archive) return archivePresent;
    return true;
  };
  return {
    calls,
    executor: {
      run: async (request) => {
        calls.push(request);
        if (request.args[0] === "push") return ok();
        const executable = request.args[3];
        const args = request.args.slice(4);
        if (executable === "/usr/bin/test" && args[0] === "-e") {
          return exists(args[1] ?? "")
            ? ok()
            : { exitCode: 1, stdout: "", stderr: "" };
        }
        if (executable === "/usr/bin/test") return ok();
        if (executable === "/usr/bin/install") {
          if (args.includes(staging)) stagingPresent = true;
          return ok();
        }
        if (executable === "/usr/bin/find") {
          return ok(`${stagingArtifact.bundleFiles.join("\n")}\n`);
        }
        if (executable === "/usr/bin/stat") {
          return ok(
            `${args
              .slice(1)
              .map((file) => `${file}\toperator\tregular file`)
              .join("\n")}\n`,
          );
        }
        if (executable === "/usr/bin/sha256sum") {
          const candidate = args[0] ?? "";
          if (candidate.endsWith("/release-manifest.json")) {
            return ok(
              `${candidate.includes("/staging/")
                ? stagingArtifact.manifestSha256
                : currentManifestSha256}  ${candidate}\n`,
            );
          }
          return ok(`${stagingArtifact.debSha256}  ${candidate}\n`);
        }
        if (executable === "/usr/bin/mv") {
          const source = args.at(-2);
          const destination = args.at(-1);
          if (
            (source === current || source === current.slice(0, -1)) &&
            destination === archive
          ) {
            currentPresent = false;
            archivePresent = true;
            return ok();
          }
          if (source === staging && destination === current) {
            stagingPresent = false;
            currentPresent = true;
            currentManifestSha256 = stagingArtifact.manifestSha256;
            return ok();
          }
        }
        throw new Error(
          `unexpected cache command: ${JSON.stringify(request.args)}`,
        );
      },
    },
  };
};

describe("Linux OrbStack two-station qualification", () => {
  it("derives only bounded disposable machine names from the run id", () => {
    expect(qualificationMachineNames("release-015")).toEqual({
      commandCenter: "vellum-q-release-015-cc",
      remote: "vellum-q-release-015-remote",
    });
    for (const invalid of [
      "",
      "-release",
      "Release",
      "a",
      "release/015",
      "release;rm",
      "x".repeat(33),
    ]) {
      expect(() => requireRunId(invalid)).toThrow(/run id/u);
    }
  });

  it("keeps qualification candidates out of the production cache", () => {
    expect(
      managedBundleRelativeDestination("qualification-candidate"),
    ).toBe(
      ".vellum/releases/linux-x64-glibc/qualification/current/",
    );
    expect(managedBundleRelativeDestination("final-release")).toBe(
      ".vellum/releases/linux-x64-glibc/current/",
    );
  });

  it("reuses an identical verified fixed cache without mutation", async () => {
    const fixture = cacheRotationExecutor(stagingArtifact.manifestSha256);
    await expect(
      stageManagedBundle(
        fixture.executor,
        "orbctl",
        machine("cc"),
        stagingArtifact,
        "qualification-candidate",
      ),
    ).resolves.toBe(
      "/home/operator/.vellum/releases/linux-x64-glibc/qualification/current/Vellum Command-0.1.5-x64-linux.deb",
    );
    expect(
      fixture.calls.some((call) =>
        call.args[0] === "push" ||
        call.args.includes("/usr/bin/mv")
      ),
    ).toBe(false);
  });

  it("stages before recoverably archiving a superseded fixed cache", async () => {
    const fixture = cacheRotationExecutor("a".repeat(64));
    await stageManagedBundle(
      fixture.executor,
      "orbctl",
      machine("cc"),
      stagingArtifact,
      "qualification-candidate",
    );
    const push = fixture.calls.findIndex((call) => call.args[0] === "push");
    const moves = fixture.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.args.includes("/usr/bin/mv"));
    expect(push).toBeGreaterThan(-1);
    expect(moves).toHaveLength(2);
    expect(push).toBeLessThan(moves[0]?.index ?? -1);
    expect(moves[0]?.call.args.slice(-2)).toEqual([
      "/home/operator/.vellum/releases/linux-x64-glibc/qualification/current/",
      `/home/operator/.vellum/releases/linux-x64-glibc/qualification/archive/${"a".repeat(64)}`,
    ]);
    expect(moves[1]?.call.args.slice(-2)).toEqual([
      `/home/operator/.vellum/releases/linux-x64-glibc/qualification/staging/${stagingArtifact.manifestSha256}`,
      "/home/operator/.vellum/releases/linux-x64-glibc/qualification/current/",
    ]);
    expect(JSON.stringify(fixture.calls)).not.toContain("/usr/bin/rm");
  });

  it("requires an absolute evidence directory and closed CLI options", () => {
    expect(
      parseQualificationArgs([
        "run",
        "--run-id",
        "release-015",
        "--evidence-dir",
        "/tmp/vellum-q",
      ]),
    ).toMatchObject({
      mode: "run",
      runId: "release-015",
      evidenceDirectory: "/tmp/vellum-q",
    });
    expect(() =>
      parseQualificationArgs([
        "run",
        "--evidence-dir",
        "relative",
      ])
    ).toThrow(/absolute/u);
    expect(() =>
      parseQualificationArgs([
        "run",
        "--evidence-dir",
        "/tmp/vellum-q",
        "--command",
        "anything",
      ])
    ).toThrow(/unknown option/u);
    expect(
      parseQualificationArgs([
        "prepare",
        "--run-id",
        "release-015",
        "--evidence-dir",
        "/tmp/vellum-q",
        "--command-center-vm",
        "vellum-retained-cc",
        "--command-center-id",
        "01RETAINEDCOMMANDCENTER00000000",
      ]),
    ).toMatchObject({
      commandCenterName: "vellum-retained-cc",
      commandCenterId: "01RETAINEDCOMMANDCENTER00000000",
    });
  });

  it("rejects the stale protocol-2 bundle before any VM action", async () => {
    const bundle = path.resolve("release/linux-staging/bundle-0.1.2");
    await expect(
      inspectManagedArtifact({
        debPath: path.join(
          bundle,
          "Vellum Command-0.1.2-x64-linux.deb",
        ),
        bundleDirectory: bundle,
        sourceCommit: "47e138e4930995ab0ea1869dc25bce3175757f6b",
      }),
    ).rejects.toThrow();
  });

  it("does not admit a production manifest into the qualification cache", async () => {
    const bundle = path.resolve("release/linux-staging/bundle-0.1.2");
    await expect(
      inspectQualificationCandidateArtifact({
        debPath: path.join(
          bundle,
          "Vellum Command-0.1.2-x64-linux.deb",
        ),
        bundleDirectory: bundle,
        sourceCommit: "47e138e4930995ab0ea1869dc25bce3175757f6b",
      }),
    ).rejects.toThrow(/qualification candidate manifest/u);
  });

  it("uses the packaged operator CLI for the full managed deployment path", async () => {
    const directory = evidenceDirectory();
    const calls: CommandRequest[] = [];
    let invocationReads = 0;
    const executor: CommandExecutor = {
      run: async (request) => {
        calls.push(request);
        const command = operatorCommandFrom(request);
        if (command !== undefined) {
          switch (command) {
            case "station.configure-command-center":
              return operatorEnvelope("station configure-command-center", {
                role: "command-center",
              });
            case "station.status":
              return operatorEnvelope(
                "station status",
                request.args[2]?.endsWith("-remote")
                  ? offlineRemoteStationStatus()
                  : commandCenterStationStatus(),
              );
            case "fleet.list":
              return operatorEnvelope("fleet list", { hosts: [] });
            case "fleet.add":
              return operatorEnvelope("fleet add", { hosts: [] });
            case "fleet.test":
              return operatorEnvelope("fleet test", {
                hostId: "q-release-015-remote",
                ok: true,
                detail: "reachable",
              });
            case "fleet.enable-managed-installs":
              return operatorEnvelope("fleet enable-managed-installs", {
                remoteManagedInstalls: true,
              });
            case "fleet.qualify":
              return operatorEnvelope("fleet qualify", {
                status: "ready",
                ok: true,
                version: "0.1.5",
                stages: [],
              });
            case "fleet.sync":
              return operatorEnvelope("fleet sync", fleetSyncData());
            case "fleet.status":
              return operatorEnvelope("fleet status", fleetStatusData());
            case "qualification.work.prepare":
              return operatorEnvelope("qualification work prepare", {
                ...qualificationIdentity("1"),
                state: "working",
                disposition: "prepared",
              });
            case "qualification.work.progress-offline":
              return operatorEnvelope(
                "qualification work progress-offline",
                {
                  ...qualificationIdentity("2"),
                  before: "working",
                  after: "completed",
                  disposition: "applied",
                },
              );
            case "qualification.work.verify":
              return operatorEnvelope("qualification work verify", {
                ...qualificationIdentity("2"),
                state: "completed",
              });
          }
        }
        if (request.executable === "/usr/bin/ssh") {
          return fixedStationStatus(request);
        }
        if (request.args.includes("/usr/bin/dpkg-query")) {
          const format = request.args.find((arg) =>
            arg.startsWith("--showformat=")
          );
          if (format === "--showformat=${Status}") {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "no packages found",
            };
          }
          return ok("vellum\t0.1.5\tamd64\n");
        }
        if (
          request.args.includes("/usr/bin/systemctl") &&
          request.args.includes("--value")
        ) {
          invocationReads += 1;
          return ok(
            `${invocationReads === 1 ? "1" : "2".repeat(32)}${invocationReads === 1 ? "1".repeat(31) : ""}\n`,
          );
        }
        if (
          request.args.includes("/usr/bin/systemctl") &&
          request.args.includes("--property=ActiveState")
        ) {
          return ok("ActiveState=inactive\nSubState=dead\nMainPID=0\n");
        }
        if (request.args.includes("/usr/bin/systemctl")) return ok();
        if (request.args.includes("/usr/bin/systemd-run")) return ok();
        throw new Error(`unexpected command: ${JSON.stringify(request.args)}`);
      },
    };

    const result = await runQualification(
      {
        mode: "run",
        runId: "release-015",
        evidenceDirectory: directory,
      },
      { executor, now: () => new Date(NOW) },
    );

    expect(result).toMatchObject({
      managedRunAttempted: true,
      managedDeployReady: true,
    });
    const operatorArgv = calls
      .filter((request) => request.args.includes("/usr/bin/vellum"))
      .map((request) =>
        request.args.slice(request.args.indexOf("/usr/bin/vellum") + 1)
      );
    expect(operatorArgv).toEqual([
      ["station", "configure-command-center"],
      ["station", "status"],
      ["fleet", "list"],
      [
        "fleet",
        "add",
        "--id",
        "q-release-015-remote",
        "--label",
        "Qualification release-015 Remote",
        "--ssh-endpoint",
        "operator@vellum-q-release-015-remote@orb",
        "--capability",
        "terminal",
        "--capability",
        "browser",
      ],
      ["fleet", "enable-managed-installs"],
      [
        "fleet",
        "qualify",
        "q-release-015-remote",
      ],
      ["fleet", "test", "q-release-015-remote"],
      ["fleet", "sync", "--id", "q-release-015-remote"],
      ["fleet", "status", "--id", "q-release-015-remote"],
      [
        "qualification",
        "work",
        "prepare",
        "--run-id",
        "release-015",
        "--host-id",
        "q-release-015-remote",
      ],
      ["station", "status"],
      [
        "qualification",
        "work",
        "progress-offline",
        "--run-id",
        "release-015",
      ],
      ["station", "status"],
      [
        "qualification",
        "work",
        "verify",
        "--run-id",
        "release-015",
        "--host-id",
        "q-release-015-remote",
      ],
      ["fleet", "sync", "--id", "q-release-015-remote"],
      [
        "fleet",
        "qualify",
        "q-release-015-remote",
      ],
      ["fleet", "sync", "--id", "q-release-015-remote"],
      ["fleet", "status", "--id", "q-release-015-remote"],
    ]);
    expect(JSON.stringify(calls)).not.toContain("admin-password");
    expect(calls.every((request) => Array.isArray(request.args))).toBe(true);
  });

  it("uses ordinary cached deploy only for a separate final-release run", async () => {
    const directory = evidenceDirectory(
      preparedState({
        kind: "final-release",
        commandCenterMode: "retained-licensed",
      }),
    );
    const calls: CommandRequest[] = [];
    let invocationReads = 0;
    const executor: CommandExecutor = {
      run: async (request) => {
        calls.push(request);
        const command = operatorCommandFrom(request);
        if (command === "station.status") {
          return operatorEnvelope(
            "station status",
            request.args[2]?.endsWith("-remote")
              ? offlineRemoteStationStatus()
              : commandCenterStationStatus(),
          );
        }
        if (command === "fleet.list") {
          return operatorEnvelope("fleet list", { hosts: [] });
        }
        if (command === "fleet.test") {
          return operatorEnvelope("fleet test", { ok: true });
        }
        if (command === "fleet.deploy") {
          return operatorEnvelope("fleet deploy", {
            status: "ready",
            ok: true,
          });
        }
        if (command === "fleet.enable-managed-installs") {
          return operatorEnvelope("fleet enable-managed-installs", {
            remoteManagedInstalls: true,
          });
        }
        if (command === "fleet.sync") {
          return operatorEnvelope("fleet sync", fleetSyncData());
        }
        if (command === "fleet.status") {
          return operatorEnvelope("fleet status", fleetStatusData());
        }
        if (command === "qualification.work.prepare") {
          return operatorEnvelope("qualification work prepare", {
            ...qualificationIdentity("1"),
            state: "working",
            disposition: "prepared",
          });
        }
        if (command === "qualification.work.progress-offline") {
          return operatorEnvelope("qualification work progress-offline", {
            ...qualificationIdentity("2"),
            before: "working",
            after: "completed",
            disposition: "applied",
          });
        }
        if (command === "qualification.work.verify") {
          return operatorEnvelope("qualification work verify", {
            ...qualificationIdentity("2"),
            state: "completed",
          });
        }
        if (command !== undefined) {
          return operatorEnvelope(command.replace(".", " "), {});
        }
        if (request.executable === "/usr/bin/ssh") {
          return fixedStationStatus(request);
        }
        if (
          request.args.includes("/usr/bin/systemctl") &&
          request.args.includes("--value")
        ) {
          invocationReads += 1;
          return ok(`${String(invocationReads).repeat(32)}\n`);
        }
        if (
          request.args.includes("/usr/bin/systemctl") &&
          request.args.includes("--property=ActiveState")
        ) {
          return ok("ActiveState=inactive\nSubState=dead\nMainPID=0\n");
        }
        if (request.args.includes("/usr/bin/systemctl")) return ok();
        if (request.args.includes("/usr/bin/systemd-run")) return ok();
        if (request.args.includes("/usr/bin/dpkg-query")) {
          const status = request.args.includes("--showformat=${Status}");
          return status
            ? { exitCode: 1, stdout: "", stderr: "" }
            : ok("vellum\t0.1.5\tamd64\n");
        }
        throw new Error(`unexpected command ${JSON.stringify(request.args)}`);
      },
    };

    await runQualification(
      {
        mode: "run",
        runId: "release-015",
        evidenceDirectory: directory,
      },
      { executor, now: () => new Date(NOW) },
    );

    const deployed = calls.find((request) =>
      request.args.includes("deploy")
    );
    expect(deployed?.args.slice(-4)).toEqual([
      "deploy",
      "q-release-015-remote",
      "--source",
      "cached",
    ]);
    expect(calls.some((request) => request.args.includes("qualify"))).toBe(
      false,
    );
    expect(
      calls.filter((request) =>
        operatorCommandFrom(request) === "station.status"
      ),
    ).toHaveLength(3);
    expect(
      calls.filter((request) =>
        operatorCommandFrom(request) === "fleet.list"
      ),
    ).toHaveLength(1);
  });

  it("preserves the VMs and records a non-passing failure when deploy needs auth", async () => {
    const directory = evidenceDirectory();
    const executor: CommandExecutor = {
      run: async (request) => {
        const command = operatorCommandFrom(request);
        if (command === "fleet.test") {
          return operatorEnvelope("fleet test", { ok: true });
        }
        if (command === "fleet.qualify") {
          return operatorEnvelope("fleet qualify", {
            status: "authorization-required",
          });
        }
        if (command === "fleet.list") {
          return operatorEnvelope("fleet list", { hosts: [] });
        }
        if (command === "fleet.enable-managed-installs") {
          return operatorEnvelope("fleet enable-managed-installs", {
            remoteManagedInstalls: true,
          });
        }
        if (command === "station.status") {
          return operatorEnvelope(
            "station status",
            commandCenterStationStatus(),
          );
        }
        if (command !== undefined) {
          return operatorEnvelope(command.replace(".", " "), {});
        }
        if (request.args.includes("/usr/bin/systemctl")) return ok();
        if (request.args.includes("/usr/bin/dpkg-query")) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        throw new Error("unexpected command");
      },
    };
    await expect(
      runQualification(
        {
          mode: "run",
          runId: "release-015",
          evidenceDirectory: directory,
        },
        { executor, now: () => new Date(NOW) },
      ),
    ).rejects.toThrow(/passwordless sudo/u);
    const evidence = readFileSync(
      path.join(directory, "station-qualification-observations.jsonl"),
      "utf8",
    );
    expect(evidence).toContain('"event":"managed-run-failed"');
    expect(evidence).toContain('"failed":true');
    expect(evidence).not.toContain('"event":"cleaned"');
  });

  it("refuses cleanup before mutation when either fresh VM identity differs", async () => {
    const directory = evidenceDirectory();
    const calls: CommandRequest[] = [];
    const executor: CommandExecutor = {
      run: async (request) => {
        calls.push(request);
        const name = request.args[1];
        if (request.args[0] === "info" && typeof name === "string") {
          const expected =
            name.endsWith("-cc")
              ? machine("cc")
              : machine("remote");
          return orbInfo(
            name,
            name.endsWith("-remote") ? `${expected.id}-changed` : expected.id,
          );
        }
        throw new Error("delete must not be attempted");
      },
    };

    await expect(
      runQualification(
        {
          mode: "cleanup",
          evidenceDirectory: directory,
          confirmRunId: "release-015",
        },
        { executor, now: () => new Date(NOW) },
      ),
    ).rejects.toThrow(/identity mismatch/u);
    expect(calls.some((call) => call.args.includes("delete"))).toBe(false);
  });

  it("deletes only the Remote and stops the retained CC after exact confirmation", async () => {
    const directory = evidenceDirectory();
    const calls: CommandRequest[] = [];
    const executor: CommandExecutor = {
      run: async (request) => {
        calls.push(request);
        const name = request.args[1];
        if (request.args[0] === "info" && typeof name === "string") {
          const expected =
            name.endsWith("-cc")
              ? machine("cc")
              : machine("remote");
          return orbInfo(name, expected.id);
        }
        if (request.args[0] === "delete" || request.args[0] === "stop") {
          return ok();
        }
        throw new Error(`unexpected command ${request.args.join(" ")}`);
      },
    };
    await runQualification(
      {
        mode: "cleanup",
        evidenceDirectory: directory,
        confirmRunId: "release-015",
      },
      { executor, now: () => new Date(NOW) },
    );
    expect(
      calls
        .filter((call) => call.args[0] === "delete")
        .map((call) => call.args),
    ).toEqual([
      ["delete", "--force", "vellum-q-release-015-remote"],
    ]);
    expect(
      calls
        .filter((call) => call.args[0] === "stop")
        .map((call) => call.args),
    ).toEqual([
      ["stop", "vellum-q-release-015-cc"],
    ]);
    expect(JSON.stringify(calls)).not.toContain("vellum-ubuntu-x64-golden");
    expect(JSON.stringify(calls)).not.toContain('"--all"');
  });

  it("does not follow a symlinked evidence file", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "vellum-orbstack-qualification-"),
    );
    const target = path.join(directory, "target.jsonl");
    writeFileSync(target, "{}\n");
    const link = path.join(
      directory,
      "station-qualification-observations.jsonl",
    );
    symlinkSync(target, link);

    await expect(
      runQualification({
        mode: "cleanup",
        evidenceDirectory: directory,
        confirmRunId: "release-015",
      }),
    ).rejects.toThrow(/not a regular file/u);
  });
});
