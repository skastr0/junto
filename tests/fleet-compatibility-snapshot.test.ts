import { describe, expect, it } from "vitest";
import {
  deriveFleetCompatibilitySnapshot,
  FLEET_EVIDENCE_STALE_AFTER_MS,
} from "../src/shared/fleet-compatibility-snapshot";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "../src/shared/station-protocol";
import type { StationRemoteObservation } from "../src/shared/station-status";

const now = Date.parse("2026-08-18T12:00:00.000Z");
const observedAt = new Date(now - 1_000).toISOString();

const protocol = (
  compatibility: "compatible" | "deprecated" = "compatible",
): NonNullable<StationRemoteObservation["protocol"]> => ({
  compatibility,
  negotiatedProtocol: 1,
  local: {
    appVersion: "0.1.14",
    stateSchemaVersion: 22,
    support:
      compatibility === "deprecated"
        ? { preferred: 2, compatibleFrom: 1, warnBelow: 2 }
        : CURRENT_STATION_PROTOCOL_SUPPORT,
  },
  peer: {
    appVersion: "0.1.14",
    stateSchemaVersion: 22,
    support: CURRENT_STATION_PROTOCOL_SUPPORT,
  },
});

const remote = (
  overrides: Partial<StationRemoteObservation> = {},
): StationRemoteObservation => ({
  hostId: "remote-a",
  endpoint: "ssh://remote-a",
  reachability: "reachable",
  source: "live",
  observedAt,
  protocol: protocol(),
  route: {
    phase: "ready",
    sessionOpen: true,
    attempt: 1,
    updatedAt: observedAt,
  },
  ...overrides,
});

describe("Fleet compatibility truth projection", () => {
  it("requires real protocol and semantic evidence before Exact", () => {
    const exact = deriveFleetCompatibilitySnapshot({
      hostId: "remote-a",
      remoteObservation: remote(),
      semanticObservation: { status: "exact" },
      nowMs: now,
    });
    expect(exact.status).toBe("exact");

    const missingProtocol = deriveFleetCompatibilitySnapshot({
      hostId: "remote-a",
      remoteObservation: remote({ protocol: undefined }),
      semanticObservation: { status: "exact" },
      nowMs: now,
    });
    expect(missingProtocol.status).toBe("checking");
    expect(missingProtocol.protocol.state).toBe("missing");
    expect(missingProtocol.headline).not.toBe("Fully compatible");

    const missingSemantic = deriveFleetCompatibilitySnapshot({
      hostId: "remote-a",
      remoteObservation: remote(),
      nowMs: now,
    });
    expect(missingSemantic.status).toBe("checking");
    expect(missingSemantic.semantic.state).toBe("missing");
    expect(missingSemantic.headline).not.toBe("Fully compatible");
  });

  it("does not invent Work, affected nodes, update state, or projection facts", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "remote-a",
      remoteObservation: remote({ protocol: undefined }),
      nowMs: now,
    });

    expect(snapshot.workBacklog).toEqual({ state: "missing" });
    expect(snapshot.update).toEqual({ state: "missing" });
    expect(snapshot.projection).toEqual({
      state: "missing",
      freshness: "missing",
    });
    expect(snapshot.affectedNodes).toBeUndefined();
  });

  it("keeps a warning selection separate from explicit semantic exactness", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "remote-a",
      remoteObservation: remote({ protocol: protocol("deprecated") }),
      semanticObservation: { status: "exact" },
      nowMs: now,
    });

    expect(snapshot.status).toBe("warning-exact");
    expect(snapshot.protocol.state).toBe("selected");
    expect(snapshot.protocol.negotiated).toBe(1);
    expect(snapshot.protocol.isDeprecated).toBe(true);
  });

  it("keeps no-common protocol evidence explicit without fabricating semantic analysis", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "remote-a",
      remoteObservation: remote({
        source: "last-acknowledged",
        route: {
          phase: "update-required",
          sessionOpen: false,
          attempt: 2,
          updatedAt: observedAt,
        },
        protocol: {
          compatibility: "update-required",
          local: {
            appVersion: "0.2.0",
            stateSchemaVersion: 22,
            support: { preferred: 2, compatibleFrom: 2, warnBelow: 2 },
          },
          peer: {
            appVersion: "0.1.14",
            stateSchemaVersion: 18,
            support: CURRENT_STATION_PROTOCOL_SUPPORT,
          },
        },
      }),
      nowMs: now,
    });

    expect(snapshot.status).toBe("no-common");
    expect(snapshot.protocol.state).toBe("no-common");
    expect(snapshot.evidence.state).toBe("stale");
    expect(snapshot.semantic.state).toBe("missing");
  });

  it("keeps stale and unreachable observations from becoming Exact", () => {
    const stale = deriveFleetCompatibilitySnapshot({
      hostId: "remote-a",
      remoteObservation: remote({
        observedAt: new Date(
          now - FLEET_EVIDENCE_STALE_AFTER_MS - 1,
        ).toISOString(),
      }),
      semanticObservation: { status: "exact" },
      nowMs: now,
    });
    expect(stale.status).toBe("stale-evidence");
    expect(stale.evidence.state).toBe("stale");

    const retained = deriveFleetCompatibilitySnapshot({
      hostId: "remote-a",
      remoteObservation: remote({
        source: "last-acknowledged",
        route: {
          phase: "backoff",
          sessionOpen: false,
          attempt: 2,
          updatedAt: observedAt,
        },
      }),
      semanticObservation: { status: "exact" },
      nowMs: now,
    });
    expect(retained.status).toBe("stale-evidence");
    expect(retained.protocol.state).toBe("selected");

    const unreachable = deriveFleetCompatibilitySnapshot({
      hostId: "remote-a",
      remoteObservation: remote({ reachability: "unreachable" }),
      semanticObservation: { status: "exact" },
      nowMs: now,
    });
    expect(unreachable.status).toBe("unreachable");
    expect(unreachable.protocol.state).toBe("selected");
  });

  it("surfaces a real held route head without inventing a semantic proof", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "remote-a",
      remoteObservation: remote(),
      workBacklog: {
        pendingCount: 4,
        heldRouteHead: {
          eventHome: "cc-a",
          entityHome: "remote-a",
          seq: "42",
          reason: "hash-divergence",
        },
      },
      nowMs: now,
    });

    expect(snapshot.status).toBe("restricted-hold");
    expect(snapshot.workBacklog).toMatchObject({
      state: "known",
      pendingCount: 4,
    });
    expect(snapshot.semantic.state).toBe("missing");
  });
});
