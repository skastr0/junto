import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  assessStationDoctor,
  decodeStationStatusDocument,
  defaultStationStatus,
  deployRecordFromResult,
  kernelRecordFromSnapshot,
  redactStationDiagnostic,
  STATION_KERNEL_STALE_AFTER_MS,
  STATION_STATUS_VERSION,
  type StationRemoteObservation,
} from "../src/shared/station-status";
import {
  InstallationId,
  LogicalSequence,
  RouteCursor,
  StationHostId,
  StationSha256,
  STATION_API_PROTOCOL,
  StatusResponse,
  type RouteCursor as RouteCursorValue,
  type StationConfiguration,
  type StationProjectionReference,
} from "../src/shared/station-api";
import {
  agentKeysForWatcher,
  DEFAULT_STATION_HOST_ID,
  isNodeEligibleOnStation,
  resolveNodeHostId,
} from "../src/shared/station";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  StationAppVersion,
  StationProtocolSupport,
  StationStateSchemaVersion,
} from "../src/shared/station-protocol";

const installationId = Schema.decodeUnknownSync(InstallationId);
const hostId = Schema.decodeUnknownSync(StationHostId);
const logicalSequence = Schema.decodeUnknownSync(LogicalSequence);
const stationSha256 = Schema.decodeUnknownSync(StationSha256);

const commandCenterInstallationId = installationId("cc-installation");
const configuredAt = "2026-07-23T11:00:00.000Z";
const observedAt = "2026-07-23T11:59:30.000Z";
const localProtocol = {
  appVersion: StationAppVersion.make("1.2.0"),
  stateSchemaVersion: StationStateSchemaVersion.make(2),
  support: CURRENT_STATION_PROTOCOL_SUPPORT,
};
const futureProtocol = {
  appVersion: StationAppVersion.make("2.0.0"),
  stateSchemaVersion: StationStateSchemaVersion.make(3),
  support: StationProtocolSupport.make({
    preferred: 3,
    compatibleFrom: 3,
    warnBelow: 3,
  }),
};

const commandCenterConfiguration = (): StationConfiguration => ({
  role: "command-center",
  hostId: hostId("local"),
  supervisedPreferred: false,
});

const remoteConfiguration = (
  id: string,
  input: {
    readonly commandCenterInstallationId?: InstallationId;
    readonly hostId?: string;
  } = {},
): StationConfiguration => ({
  role: "remote",
  hostId: hostId(input.hostId ?? id),
  agentHostId: hostId(input.hostId ?? id),
  commandCenterInstallationId:
    input.commandCenterInstallationId ?? commandCenterInstallationId,
  supervisedPreferred: true,
});

const projection = (generation = "3"): StationProjectionReference => ({
  generation: logicalSequence(generation),
  contentSha256: stationSha256("a".repeat(64)),
  receivedAt: "2026-07-23T11:45:00.000Z",
});

const cursor = (
  eventHome: string,
  entityHome: string,
  through: string,
): RouteCursorValue =>
  Schema.decodeUnknownSync(RouteCursor)({
    eventHome: installationId(eventHome),
    entityHome: installationId(entityHome),
    through,
  });

const stationStatus = (
  id: string,
  input: {
    readonly installationId?: string;
    readonly state?:
      "unenrolled" | "paired" | "configured" | "ready" | "degraded";
    readonly configured?: boolean;
    readonly configuration?: StationConfiguration;
    readonly projection?: StationProjectionReference | false;
    readonly receivedThrough?: ReadonlyArray<RouteCursorValue>;
    readonly databaseReady?: boolean;
    readonly workControlReady?: boolean;
    readonly simulationReady?: boolean;
    readonly sessionReady?: boolean;
  } = {},
) =>
  StatusResponse.make({
    protocol: STATION_API_PROTOCOL,
    op: "status",
    installationId: installationId(input.installationId ?? `station-${id}`),
    state: input.state ?? "ready",
    ...(input.configured === false
      ? {}
      : {
          configuration: input.configuration ?? remoteConfiguration(id),
          configuredAt,
        }),
    ...(input.projection === false
      ? {}
      : { projection: input.projection ?? projection() }),
    receivedThrough: input.receivedThrough ??
      [cursor("cc-installation", `station-${id}`, "12")],
    peerAcknowledgedThrough: [],
    readiness: {
      database: input.databaseReady ?? true,
      workControl: input.workControlReady ?? true,
      simulation: input.simulationReady ?? true,
      session: input.sessionReady ?? true,
    },
    observedAt,
  });

const liveKernel = (
  input: {
    readonly observedAt?: string;
    readonly armedRegionCount?: number;
  } = {},
) => ({
  observedAt: input.observedAt ?? observedAt,
  armedRegionCount: input.armedRegionCount ?? 0,
  orphanedArmingCount: 0,
});

const localDoctorInput = () => ({
  installationId: commandCenterInstallationId,
  configuration: commandCenterConfiguration(),
  configuredAt,
  receivedThrough: [] as ReadonlyArray<RouteCursorValue>,
  version: "0.1.0",
  supervisedInstalled: "absent" as const,
  status: defaultStationStatus(),
  kernel: liveKernel(),
  readiness: {
    database: true,
    workControl: true,
    simulation: true,
    session: true,
  },
  now: Date.parse("2026-07-23T12:00:00.000Z"),
});

const statusWithDeployment = (
  deployment: ReturnType<typeof deployRecordFromResult>,
) => {
  const status = decodeStationStatusDocument({
    version: STATION_STATUS_VERSION,
    deployments: { [deployment.hostId]: deployment },
  });
  if (status === undefined) {
    throw new Error("test deployment must form a valid station status");
  }
  return status;
};

const observedRemote = (
  input: Partial<StationRemoteObservation> = {},
): StationRemoteObservation => ({
  hostId: "studio",
  endpoint: "studio-box",
  reachability: "reachable",
  station: stationStatus("studio"),
  ...input,
});

describe("station status doctor", () => {
  const now = Date.parse("2026-07-23T12:00:00.000Z");

  it("accepts only the v1 operational-observation document", () => {
    const kernel = liveKernel();

    expect(defaultStationStatus()).toEqual({ version: STATION_STATUS_VERSION });
    expect(
      decodeStationStatusDocument({
        version: STATION_STATUS_VERSION,
        kernel,
      }),
    ).toEqual({ version: STATION_STATUS_VERSION, kernel });
    expect(
      decodeStationStatusDocument({
        version: STATION_STATUS_VERSION,
        lastPull: { status: "ok" },
      }),
    ).toBeUndefined();
    expect(decodeStationStatusDocument({ version: 2 })).toBeUndefined();
  });

  it("warns when canonical station configuration is absent", () => {
    const check = assessStationDoctor({
      installationId: commandCenterInstallationId,
      receivedThrough: [],
      supervisedInstalled: "absent",
      status: defaultStationStatus(),
      readiness: {
        database: true,
        workControl: true,
        simulation: true,
        session: true,
      },
    });

    expect(check.id).toBe("station");
    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(
      /configuration (?:absent|unset)|not configured/i,
    );
  });

  it("reports canonical Command Center identity and live API readiness", () => {
    const check = assessStationDoctor(localDoctorInput());

    expect(check.status).toBe("ok");
    expect(check.detail).toMatch(/Command Center/i);
    expect(check.detail).toContain("cc-installation");
    expect(check.detail).toMatch(/host local/i);
    expect(check.detail).toContain("database ready");
    expect(check.detail).toContain("work control ready");
    expect(check.detail).toContain("simulation ready");
    expect(check.detail).toContain("Station session ready");
    expect(check.metadata).toMatchObject({
      installationId: "cc-installation",
      role: "command-center",
      hostId: "local",
      databaseReady: "true",
      workControlReady: "true",
      simulationReady: "true",
      sessionReady: "true",
    });
  });

  it("requires a canonical projection for a configured Remote", () => {
    const check = assessStationDoctor({
      ...localDoctorInput(),
      configuration: remoteConfiguration("remote-a"),
      supervisedInstalled: "installed",
      kernel: liveKernel({ armedRegionCount: 1 }),
    });

    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(
      /projection (?:absent|missing)|no projection/i,
    );
  });

  it("reports a Remote's live projection and per-home logical cursors", () => {
    const check = assessStationDoctor({
      ...localDoctorInput(),
      configuration: remoteConfiguration("remote-a"),
      projection: projection("42"),
      receivedThrough: [
        cursor("cc-installation", "station-remote-a", "9"),
        cursor("station-remote-a", "station-remote-a", "17"),
      ],
      supervisedInstalled: "installed",
      kernel: liveKernel({ armedRegionCount: 1 }),
    });

    expect(check.status).toBe("ok");
    expect(check.detail).toContain("projection 42");
    expect(check.detail).toContain(
      "logical cursors cc-installation->station-remote-a:9,station-remote-a->station-remote-a:17",
    );
    expect(check.metadata).toMatchObject({
      projectionGeneration: "42",
      receivedCursorCount: "2",
      receivedThrough:
        "cc-installation->station-remote-a:9,station-remote-a->station-remote-a:17",
    });
  });

  it.each([
    {
      component: "database" as const,
      detail: /database unavailable/i,
      metadata: "databaseReady" as const,
      severity: "error" as const,
    },
    {
      component: "workControl" as const,
      detail: /work control not ready/i,
      metadata: "workControlReady" as const,
      severity: "warning" as const,
    },
    {
      component: "simulation" as const,
      detail: /simulation degraded/i,
      metadata: "simulationReady" as const,
      severity: "warning" as const,
    },
    {
      component: "session" as const,
      detail: /Station session disconnected/i,
      metadata: "sessionReady" as const,
      severity: "warning" as const,
    },
  ])(
    "reports canonical severity when $component readiness is false",
    ({ component, detail, metadata, severity }) => {
      const input = localDoctorInput();
      const check = assessStationDoctor({
        ...input,
        readiness: {
          ...input.readiness,
          [component]: false,
        },
      });

      expect(check.status).toBe(severity);
      expect(check.detail).toMatch(detail);
      expect(check.metadata).toMatchObject({
        databaseReady: component === "database" ? "false" : "true",
        workControlReady:
          component === "workControl" ? "false" : "true",
        simulationReady:
          component === "simulation" ? "false" : "true",
        sessionReady: component === "session" ? "false" : "true",
      });
      expect(check.metadata?.[metadata]).toBe("false");
    },
  );

  it("reports a managed Remote from its live Station API observation", () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.1.0",
      lastSeen: "2026-07-23T11:55:00.000Z",
      configurationOk: true,
      detail: "ready",
      at: "2026-07-23T11:55:00.000Z",
    });
    const check = assessStationDoctor({
      ...localDoctorInput(),
      status: statusWithDeployment(deployment),
      remoteObservations: [
        observedRemote({
          station: stationStatus("studio", {
            projection: projection("3"),
            receivedThrough: [
              cursor("cc-installation", "station-studio", "12"),
              cursor("station-studio", "station-studio", "7"),
            ],
          }),
        }),
      ],
    });

    expect(check.status).toBe("ok");
    expect(check.detail).toMatch(
      /Remote studio \(studio-box\): Station API ready - installation station-studio - projection 3 - received 2 - peer-acked 0 - errors none/u,
    );
    expect(check.metadata).toMatchObject({
      deploymentCount: "1",
      lastDeployHostId: "studio",
      lastDeployOutcome: "ready",
      remoteCount: "1",
      remoteFleetBlindCount: "0",
      "remote.studio.installationId": "station-studio",
      "remote.studio.role": "remote",
      "remote.studio.projectionGeneration": "3",
      "remote.studio.receivedCursorCount": "2",
      "remote.studio.receivedThrough":
        "cc-installation->station-studio:12,station-studio->station-studio:7",
      "remote.studio.databaseReady": "true",
      "remote.studio.workControlReady": "true",
      "remote.studio.simulationReady": "true",
      "remote.studio.sessionReady": "true",
      "remote.studio.reachability": "reachable",
    });
  });

  it("lists a live registered Remote without inventing a managed deployment", () => {
    const check = assessStationDoctor({
      ...localDoctorInput(),
      registeredRemoteEndpoints: { studio: "studio-box" },
      remoteObservations: [observedRemote()],
    });

    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(/no managed deployment receipt/u);
    expect(check.detail).toMatch(/Station API ready/u);
    expect(check.metadata).toMatchObject({
      remoteCount: "1",
      remoteFleetBlindCount: "0",
      "remote.studio.state": "warning",
    });
  });

  it("keeps protocol incompatibility reachable but fleet-blind and update-required", () => {
    const check = assessStationDoctor({
      ...localDoctorInput(),
      registeredRemoteEndpoints: { studio: "studio-box" },
      remoteObservations: [
        observedRemote({
          station: undefined,
          protocol: {
            compatibility: "update-required",
            local: localProtocol,
            peer: futureProtocol,
          },
          observationError:
            "Remote is running locally — Station protocol update required",
        }),
      ],
    });

    expect(check.status).toBe("warning");
    expect(check.detail).toContain("running locally — update required");
    expect(check.detail).toContain("protocol update-required");
    expect(check.metadata).toMatchObject({
      remoteFleetBlindCount: "1",
      "remote.studio.reachability": "reachable",
      "remote.studio.state": "fleet-blind",
      "remote.studio.protocolCompatibility": "update-required",
      "remote.studio.localAppVersion": "1.2.0",
      "remote.studio.localStateSchemaVersion": "2",
      "remote.studio.peerAppVersion": "2.0.0",
      "remote.studio.peerStateSchemaVersion": "3",
      "remote.studio.localProtocolPreferred": "1",
      "remote.studio.peerProtocolCompatibleFrom": "3",
    });
  });

  it("fails closed on live fleet configuration mismatch", () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.1.0",
      lastSeen: "2026-07-23T11:55:00.000Z",
      configurationOk: true,
      detail: "ready",
      at: "2026-07-23T11:55:00.000Z",
    });
    const check = assessStationDoctor({
      ...localDoctorInput(),
      status: statusWithDeployment(deployment),
      registeredRemoteEndpoints: { studio: "studio-box" },
      remoteObservations: [
        observedRemote({
          station: stationStatus("studio", {
            configuration: remoteConfiguration("studio", {
              hostId: "wrong-host",
            }),
          }),
        }),
      ],
    });

    expect(check.status).toBe("error");
    expect(check.detail).toMatch(
      /Station API configuration does not match registry/i,
    );
    expect(check.metadata).toMatchObject({
      "remote.studio.state": "error",
    });
  });

  it("fails closed on a Remote bound to another Command Center", () => {
    const check = assessStationDoctor({
      ...localDoctorInput(),
      registeredRemoteEndpoints: { studio: "studio-box" },
      remoteObservations: [
        observedRemote({
          station: stationStatus("studio", {
            configuration: remoteConfiguration("studio", {
              commandCenterInstallationId: installationId("other-cc"),
            }),
          }),
        }),
      ],
    });

    expect(check.status).toBe("error");
    expect(check.detail).toMatch(
      /Station API configuration names another Command Center/i,
    );
    expect(check.metadata).toMatchObject({
      "remote.studio.state": "error",
    });
  });

  it("does not treat a deployment receipt as live health when the Remote is unreachable", () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.1.0",
      lastSeen: "2026-07-23T11:55:00.000Z",
      configurationOk: true,
      detail: "ready",
      at: "2026-07-23T11:55:00.000Z",
    });
    const check = assessStationDoctor({
      ...localDoctorInput(),
      status: statusWithDeployment(deployment),
      remoteObservations: [
        observedRemote({
          reachability: "unreachable",
          reachabilityError: "Timeout — host unreachable",
          station: undefined,
        }),
      ],
    });

    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/fleet-blind: Timeout — host unreachable/u);
    expect(check.metadata).toMatchObject({
      deploymentCount: "1",
      "remote.studio.reachability": "unreachable",
      "remote.studio.apiState": "unavailable",
      "remote.studio.state": "error",
    });
  });

  it("projects bounded recovery facts for stale and mismatched Remotes", () => {
    const check = assessStationDoctor({
      ...localDoctorInput(),
      registeredRemoteEndpoints: { studio: "studio-box" },
      remoteObservations: [
        observedRemote({
          expectedInstallationId: "station-enrolled",
          observedAt: "2026-07-23T11:40:00.000Z",
          route: {
            phase: "backoff",
            sessionOpen: false,
            attempt: 3,
            updatedAt: "2026-07-23T11:40:00.000Z",
            nextRetryAt: "2026-07-23T12:01:00.000Z",
          },
          readiness: { terminal: false, browser: true },
        }),
      ],
    });

    expect(check.status).toBe("error");
    expect(check.detail).toContain("installation identity mismatch");
    expect(check.detail).toContain("route backoff");
    expect(check.metadata).toMatchObject({
      "remote.studio.expectedInstallationId": "station-enrolled",
      "remote.studio.observedInstallationId": "station-studio",
      "remote.studio.routePhase": "backoff",
      "remote.studio.routeSession": "closed",
      "remote.studio.routeAttempt": "3",
      "remote.studio.terminalReady": "false",
      "remote.studio.browserReady": "true",
      "remote.studio.recoveryKind": "identity-conflict",
    });
    expect(check.metadata?.["remote.studio.recoveryNextStep"]).toMatch(
      /re-enroll/u,
    );
  });

  it("keeps partial and stale observations explicit instead of inventing readiness", () => {
    const check = assessStationDoctor({
      ...localDoctorInput(),
      registeredRemoteEndpoints: { studio: "studio-box" },
      remoteObservations: [
        observedRemote({
          station: undefined,
          reachability: "unreachable",
          reachabilityError: "socket token=secret at /Users/operator/.junto/work/control.sock",
          observationError: "bearer=secret",
        }),
      ],
    });

    expect(check.status).toBe("error");
    expect(check.metadata).toMatchObject({
      "remote.studio.databaseReady": "unknown",
      "remote.studio.workControlReady": "unknown",
      "remote.studio.simulationReady": "unknown",
      "remote.studio.terminalReady": "unknown",
      "remote.studio.browserReady": "unknown",
      "remote.studio.recoveryKind": "retryable",
    });
    expect(check.detail).not.toContain("secret");
    expect(check.detail).not.toContain("/Users/operator");
  });

  it("marks an otherwise usable Remote observation stale without clearing its facts", () => {
    const check = assessStationDoctor({
      ...localDoctorInput(),
      registeredRemoteEndpoints: { studio: "studio-box" },
      remoteObservations: [
        observedRemote({ observedAt: "2026-07-23T11:40:00.000Z" }),
      ],
    });

    expect(check.detail).toContain("Station observation stale");
    expect(check.metadata).toMatchObject({
      "remote.studio.state": "stale",
      "remote.studio.recoveryKind": "retryable",
      "remote.studio.databaseReady": "true",
    });
  });

  it("redacts credentials, board references, and local paths at the diagnostic boundary", () => {
    const diagnostic = redactStationDiagnostic(
      "bearer=secret authorization:abc token=xyz license_key=license-secret dodo_activation_id=dodo-secret junto://canvas?node=agent-123 node-01KZ12345678 /Users/operator/.junto/state/junto.db",
    );
    expect(diagnostic).not.toContain("secret");
    expect(diagnostic).not.toContain("agent-123");
    expect(diagnostic).not.toContain("node-01KZ12345678");
    expect(diagnostic).not.toContain("/Users/operator");
    expect(diagnostic).toContain("[redacted]");
    expect(diagnostic).toContain("[path redacted]");
  });

  it("reports stale live kernel truth without any retired pull status", () => {
    const staleKernelAt = new Date(
      now - STATION_KERNEL_STALE_AFTER_MS - 1,
    ).toISOString();
    const check = assessStationDoctor({
      ...localDoctorInput(),
      configuration: remoteConfiguration("remote-a"),
      projection: projection(),
      supervisedInstalled: "installed",
      kernel: liveKernel({
        observedAt: staleKernelAt,
        armedRegionCount: 0,
      }),
    });

    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(/kernel observed - stale/u);
    expect(check.detail).not.toMatch(/pull/u);
    expect(check.metadata).toMatchObject({
      kernelObservedAt: staleKernelAt,
      kernelArmedCount: "0",
    });
  });

  it("projects only bounded kernel facts into the station mirror", () => {
    const record = kernelRecordFromSnapshot(
      {
        canvases: {
          alpha: {
            watchers: {},
            nextFire: {},
          },
          beta: {
            watchers: {},
            nextFire: {},
          },
        },
      },
      "2026-07-23T12:00:00.000Z",
    );

    // Pulse/arming product retired — doctor fields stay zeroed.
    expect(record).toEqual({
      observedAt: "2026-07-23T12:00:00.000Z",
      armedRegionCount: 0,
      orphanedArmingCount: 0,
    });
  });

  it("fails closed on an indeterminate deploy receipt", () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: false,
      outcome: "indeterminate",
      packageState: "unknown",
      role: "unknown",
      configurationOk: true,
      detail: "inspect host",
    });
    const check = assessStationDoctor({
      ...localDoctorInput(),
      status: statusWithDeployment(deployment),
    });

    expect(check.status).toBe("error");
    expect(check.metadata?.lastDeployOutcome).toBe("indeterminate");
    expect(check.detail).toMatch(/last seen never/u);
  });

  it("does not attribute a receipt to a removed or repointed host", () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "old-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.1.0",
      lastSeen: "2026-07-22T20:00:00.000Z",
      configurationOk: true,
      detail: "ready",
    });
    const check = assessStationDoctor({
      ...localDoctorInput(),
      status: statusWithDeployment(deployment),
      registeredRemoteEndpoints: { studio: "new-box" },
    });

    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(/stale deployment receipt/u);
    expect(check.detail).not.toMatch(/version 0\.1\.0/u);
    expect(check.metadata).toMatchObject({
      deploymentCount: "0",
      staleDeploymentCount: "1",
    });
  });
});

describe("foundation smoke — host scope + edges still compose", () => {
  it("local-only Command Center path: local watcher→agent edge", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "w",
          type: "text",
          text: "w",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "watcher" },
            host: DEFAULT_STATION_HOST_ID,
            watch: { kind: "stat_threshold", source: "hermes" },
          },
        },
        {
          id: "a",
          type: "text",
          text: "a",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:codex" },
            host: DEFAULT_STATION_HOST_ID,
          },
        },
      ],
      edges: [{ id: "e", fromNode: "w", toNode: "a" }],
    };
    const watcher = doc.nodes[0] as CanvasNode;
    expect(isNodeEligibleOnStation(watcher, "local")).toBe(true);
    expect(resolveNodeHostId(doc.nodes[1]!)).toBe("local");
    expect(agentKeysForWatcher(doc, "w", "command-center", "local")).toEqual([
      "local:codex",
    ]);
  });

  it("Remote does not deliver cross-host agents", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "w",
          type: "text",
          text: "w",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "watcher" },
            host: "remote-a",
            watch: { kind: "stat_threshold", source: "hermes" },
          },
        },
        {
          id: "a",
          type: "text",
          text: "a",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:codex" },
            host: "local",
          },
        },
      ],
      edges: [{ id: "e", fromNode: "w", toNode: "a" }],
    };
    expect(agentKeysForWatcher(doc, "w", "remote", "remote-a")).toEqual([]);
  });
});
