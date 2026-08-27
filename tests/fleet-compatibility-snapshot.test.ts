import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  deriveFleetCompatibilitySnapshot,
  type FleetPeerCompatibilitySnapshot,
  FLEET_EVIDENCE_STALE_AFTER_MS,
} from "../src/shared/fleet-compatibility-snapshot";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "../src/shared/station-protocol";
import {
  InstallationId,
  LogicalSequence as StationLogicalSequence,
  StationSha256,
  type StatusResponse,
} from "../src/shared/station-api";
import { LogicalSequence as WorkLogicalSequence } from "../src/shared/work-protocol";
import type {
  StationProtocolObservation,
  StationRemoteObservation,
} from "../src/shared/station-status";

const makeInstallationId = Schema.decodeUnknownSync(InstallationId);
const makeStationLogicalSequence = Schema.decodeUnknownSync(StationLogicalSequence);
const makeWorkLogicalSequence = Schema.decodeUnknownSync(WorkLogicalSequence);
const makeStationSha256 = Schema.decodeUnknownSync(StationSha256);

describe("Fleet Compatibility Snapshot derivation", () => {
  const baseLocalSupport = CURRENT_STATION_PROTOCOL_SUPPORT;
  const now = 1700000000000;
  const freshObservedAt = new Date(now - 10_000).toISOString();
  const staleObservedAt = new Date(now - FLEET_EVIDENCE_STALE_AFTER_MS - 20_000).toISOString();

  it("derives 'exact' for a fully synchronized peer", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "host-1",
      reachabilityStatus: "reachable",
      nowMs: now,
      protocolObservation: {
        compatibility: "compatible",
        negotiatedProtocol: 1,
        local: { appVersion: "0.1.14", stateSchemaVersion: 21, support: baseLocalSupport },
        peer: { appVersion: "0.1.14", stateSchemaVersion: 21, support: baseLocalSupport },
      },
      remoteObservation: {
        hostId: "host-1",
        endpoint: "ssh://host-1",
        reachability: "reachable",
        observedAt: freshObservedAt,
        source: "live",
        station: {
          protocol: "vellum-command/station-api/v1",
          op: "status",
          observedAt: freshObservedAt,
          installationId: makeInstallationId("remote-1"),
          state: "ready",
          receivedThrough: [{ eventHome: makeInstallationId("cc-1"), entityHome: makeInstallationId("remote-1"), through: makeWorkLogicalSequence("10") }],
          peerAcknowledgedThrough: [{ eventHome: makeInstallationId("remote-1"), entityHome: makeInstallationId("cc-1"), through: makeWorkLogicalSequence("10") }],
          readiness: { database: true, workControl: true, simulation: true, session: true },
          projection: {
            generation: makeStationLogicalSequence("10"),
            contentSha256: makeStationSha256("a".repeat(64)),
            receivedAt: freshObservedAt,
          },
        },
      },
      workBacklog: { pendingCount: 0 },
    });

    expect(snapshot.status).toBe("exact");
    expect(snapshot.reachability).toBe("reachable");
    expect(snapshot.protocol.negotiated).toBe(1);
    expect(snapshot.protocol.isDeprecated).toBe(false);
    expect(snapshot.semantic.status).toBe("exact");
    expect(snapshot.projection.freshness).toBe("fresh");
    expect(snapshot.projection.isLastValidRetained).toBe(false);
  });

  it("derives 'warning-exact' when negotiated version is below warning threshold", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "host-1",
      reachabilityStatus: "reachable",
      nowMs: now,
      protocolObservation: {
        compatibility: "deprecated",
        negotiatedProtocol: 1,
        local: { appVersion: "0.1.14", stateSchemaVersion: 21, support: { preferred: 2, compatibleFrom: 1, warnBelow: 2 } },
        peer: { appVersion: "0.1.14", stateSchemaVersion: 21, support: { preferred: 1, compatibleFrom: 1, warnBelow: 1 } },
      },
      remoteObservation: {
        hostId: "host-1",
        endpoint: "ssh://host-1",
        reachability: "reachable",
        observedAt: freshObservedAt,
        source: "live",
        station: {
          protocol: "vellum-command/station-api/v1",
          op: "status",
          observedAt: freshObservedAt,
          installationId: makeInstallationId("remote-1"),
          state: "ready",
          receivedThrough: [{ eventHome: makeInstallationId("cc-1"), entityHome: makeInstallationId("remote-1"), through: makeWorkLogicalSequence("5") }],
          peerAcknowledgedThrough: [{ eventHome: makeInstallationId("remote-1"), entityHome: makeInstallationId("cc-1"), through: makeWorkLogicalSequence("5") }],
          readiness: { database: true, workControl: true, simulation: true, session: true },
          projection: { generation: makeStationLogicalSequence("5"), contentSha256: makeStationSha256("b".repeat(64)), receivedAt: freshObservedAt },
        },
      },
    });

    expect(snapshot.status).toBe("warning-exact");
    expect(snapshot.protocol.isDeprecated).toBe(true);
    expect(snapshot.headline).toContain("Compatible");
  });

  it("derives 'restricted-hold' when work is held at an unrepresentable route head", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "host-1",
      reachabilityStatus: "reachable",
      nowMs: now,
      protocolObservation: {
        compatibility: "compatible",
        negotiatedProtocol: 1,
        local: { appVersion: "0.1.14", stateSchemaVersion: 21, support: baseLocalSupport },
        peer: { appVersion: "0.1.14", stateSchemaVersion: 21, support: baseLocalSupport },
      },
      remoteObservation: {
        hostId: "host-1",
        endpoint: "ssh://host-1",
        reachability: "reachable",
        observedAt: freshObservedAt,
        source: "live",
      },
      workBacklog: {
        pendingCount: 4,
        heldRouteHead: {
          eventHome: "cc-1",
          entityHome: "remote-1",
          seq: "42",
          reason: "Record uses newer unrepresentable action payload",
        },
      },
    });

    expect(snapshot.status).toBe("restricted-hold");
    expect(snapshot.semantic.status).toBe("restricted");
    expect(snapshot.semantic.withheldSemantics.length).toBeGreaterThan(0);
    expect(snapshot.workBacklog.pendingCount).toBe(4);
    expect(snapshot.workBacklog.heldRouteHead?.seq).toBe("42");
  });

  it("derives 'no-common' and preserves last valid projection on protocol incompatibility", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "host-1",
      reachabilityStatus: "reachable",
      nowMs: now,
      protocolObservation: {
        compatibility: "update-required",
        local: { appVersion: "0.1.14", stateSchemaVersion: 21, support: { preferred: 3, compatibleFrom: 2, warnBelow: 2 } },
        peer: { appVersion: "0.1.0", stateSchemaVersion: 18, support: { preferred: 1, compatibleFrom: 1, warnBelow: 1 } },
      },
      remoteObservation: {
        hostId: "host-1",
        endpoint: "ssh://host-1",
        reachability: "reachable",
        observedAt: freshObservedAt,
        source: "live",
        station: {
          protocol: "vellum-command/station-api/v1",
          op: "status",
          observedAt: freshObservedAt,
          installationId: makeInstallationId("remote-1"),
          state: "ready",
          receivedThrough: [{ eventHome: makeInstallationId("cc-1"), entityHome: makeInstallationId("remote-1"), through: makeWorkLogicalSequence("8") }],
          peerAcknowledgedThrough: [{ eventHome: makeInstallationId("remote-1"), entityHome: makeInstallationId("cc-1"), through: makeWorkLogicalSequence("8") }],
          readiness: { database: true, workControl: true, simulation: true, session: true },
          projection: {
            generation: makeStationLogicalSequence("8"),
            contentSha256: makeStationSha256("c".repeat(64)),
            receivedAt: freshObservedAt,
          },
        },
      },
    });

    expect(snapshot.status).toBe("no-common");
    expect(snapshot.projection.isLastValidRetained).toBe(true);
    expect(snapshot.projection.generation).toBe("8");
    expect(snapshot.semantic.status).toBe("unsupported");
  });

  it("derives 'stale-evidence' when observation age exceeds threshold", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "host-1",
      reachabilityStatus: "reachable",
      nowMs: now,
      protocolObservation: {
        compatibility: "compatible",
        negotiatedProtocol: 1,
        local: { appVersion: "0.1.14", stateSchemaVersion: 21, support: baseLocalSupport },
        peer: { appVersion: "0.1.14", stateSchemaVersion: 21, support: baseLocalSupport },
      },
      remoteObservation: {
        hostId: "host-1",
        endpoint: "ssh://host-1",
        reachability: "reachable",
        observedAt: staleObservedAt,
        source: "live",
        station: {
          protocol: "vellum-command/station-api/v1",
          op: "status",
          observedAt: freshObservedAt,
          installationId: makeInstallationId("remote-1"),
          state: "ready",
          receivedThrough: [{ eventHome: makeInstallationId("cc-1"), entityHome: makeInstallationId("remote-1"), through: makeWorkLogicalSequence("1") }],
          peerAcknowledgedThrough: [{ eventHome: makeInstallationId("remote-1"), entityHome: makeInstallationId("cc-1"), through: makeWorkLogicalSequence("1") }],
          readiness: { database: true, workControl: true, simulation: true, session: true },
          projection: { generation: makeStationLogicalSequence("1"), contentSha256: makeStationSha256("d".repeat(64)), receivedAt: freshObservedAt },
        },
      },
    });

    expect(snapshot.status).toBe("stale-evidence");
    expect(snapshot.projection.freshness).toBe("stale");
  });

  it("derives 'unreachable' on transport disconnect and keeps last valid projection", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "host-1",
      reachabilityStatus: "unreachable",
      nowMs: now,
      remoteObservation: {
        hostId: "host-1",
        endpoint: "ssh://host-1",
        reachability: "unreachable",
        observedAt: freshObservedAt,
        source: "last-acknowledged",
        station: {
          protocol: "vellum-command/station-api/v1",
          op: "status",
          observedAt: freshObservedAt,
          installationId: makeInstallationId("remote-1"),
          state: "ready",
          receivedThrough: [{ eventHome: makeInstallationId("cc-1"), entityHome: makeInstallationId("remote-1"), through: makeWorkLogicalSequence("12") }],
          peerAcknowledgedThrough: [{ eventHome: makeInstallationId("remote-1"), entityHome: makeInstallationId("cc-1"), through: makeWorkLogicalSequence("12") }],
          readiness: { database: true, workControl: true, simulation: true, session: true },
          projection: { generation: makeStationLogicalSequence("12"), contentSha256: makeStationSha256("e".repeat(64)), receivedAt: freshObservedAt },
        },
      },
    });

    expect(snapshot.status).toBe("unreachable");
    expect(snapshot.reachability).toBe("unreachable");
    expect(snapshot.projection.isLastValidRetained).toBe(true);
    expect(snapshot.projection.generation).toBe("12");
  });

  it("derives 'checking' when host is probing", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "host-1",
      reachabilityStatus: "probing",
      nowMs: now,
    });

    expect(snapshot.status).toBe("checking");
    expect(snapshot.reachability).toBe("probing");
  });

  it("surfaces update execution states accurately", () => {
    const updateAvailable = deriveFleetCompatibilitySnapshot({
      hostId: "host-1",
      reachabilityStatus: "reachable",
      updateState: { state: "update-available", targetVersion: "0.1.15" },
    });
    expect(updateAvailable.update.state).toBe("update-available");
    expect(updateAvailable.update.targetVersion).toBe("0.1.15");

    const updateRunning = deriveFleetCompatibilitySnapshot({
      hostId: "host-1",
      reachabilityStatus: "reachable",
      updateState: { state: "update-running", targetVersion: "0.1.15" },
    });
    expect(updateRunning.update.state).toBe("update-running");

    const updateFailed = deriveFleetCompatibilitySnapshot({
      hostId: "host-1",
      reachabilityStatus: "reachable",
      updateState: { state: "update-failed", errorMessage: "SSH connection broken during tar unpack" },
    });
    expect(updateFailed.update.state).toBe("update-failed");
    expect(updateFailed.detail).toContain("SSH connection broken");
  });
});
