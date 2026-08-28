import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  deriveFleetCompatibilitySnapshot,
  type DeriveFleetCompatibilityInput,
} from "../src/shared/fleet-compatibility-snapshot";
import {
  FleetCompatibilitySection,
  compatibilityStatusColor,
} from "../src/renderer/components/fleet/FleetCompatibilitySection";
import { RemoteStationFaceView } from "../src/renderer/components/remote/RemoteStationFace";
import { GREEN, HUE, DIM } from "../src/renderer/lib/theme";

const renderSection = (input: DeriveFleetCompatibilityInput) => {
  const snapshot = deriveFleetCompatibilitySnapshot(input);
  const html = renderToStaticMarkup(
    createElement(FleetCompatibilitySection, { snapshot }),
  );
  return { snapshot, html };
};

describe("Fleet Compatibility UI & Progressive Disclosure", () => {
  it("renders exact state cleanly with green status dot", () => {
    const { snapshot, html } = renderSection({
      hostId: "studio",
      reachabilityStatus: "reachable",
      protocolObservation: {
        compatibility: "compatible",
        negotiatedProtocol: 1,
        local: {
          appVersion: "0.1.14",
          stateSchemaVersion: 20,
          support: { preferred: 1, compatibleFrom: 1, warnBelow: 1 },
        },
        peer: {
          appVersion: "0.1.14",
          stateSchemaVersion: 20,
          support: { preferred: 1, compatibleFrom: 1, warnBelow: 1 },
        },
      },
    });

    expect(snapshot.status).toBe("exact");
    expect(compatibilityStatusColor(snapshot.status)).toBe(GREEN);
    expect(html).toContain("Fully compatible");
    expect(html).toContain("Operating under exact Station protocol 1 and synchronized intent.");
    expect(html).toContain("data-testid=\"fleet-compatibility-section\"");
    expect(html).toContain("Negotiated protocol");
    expect(html).toContain("v1");
  });

  it("renders warning-exact state when below warning threshold", () => {
    const { snapshot, html } = renderSection({
      hostId: "studio",
      reachabilityStatus: "reachable",
      protocolObservation: {
        compatibility: "deprecated",
        negotiatedProtocol: 1,
        local: {
          appVersion: "0.1.14",
          stateSchemaVersion: 20,
          support: { preferred: 3, compatibleFrom: 1, warnBelow: 2 },
        },
        peer: {
          appVersion: "0.1.14",
          stateSchemaVersion: 20,
          support: { preferred: 1, compatibleFrom: 1, warnBelow: 1 },
        },
      },
    });

    expect(snapshot.status).toBe("warning-exact");
    expect(compatibilityStatusColor(snapshot.status)).toBe(HUE.amber);
    expect(html).toContain("Compatible (Deprecation warning)");
    expect(html).toContain("(deprecated)");
  });

  it("renders restricted-hold state explaining withheld capability without mutating execution", () => {
    const { snapshot, html } = renderSection({
      hostId: "studio",
      reachabilityStatus: "reachable",
      workBacklog: {
        pendingCount: 2,
        heldRouteHead: {
          eventHome: "cc",
          entityHome: "studio",
          seq: "5",
          reason: "restricted capability",
        },
      },
    });

    expect(snapshot.status).toBe("restricted-hold");
    expect(html).toContain("Restricted compatibility (Work held)");
    expect(html).toContain("New capability withheld to prevent data divergence");
  });

  it("renders unsupported state when peer has no common protocol", () => {
    const { snapshot, html } = renderSection({
      hostId: "studio",
      reachabilityStatus: "reachable",
      protocolObservation: {
        compatibility: "update-required",
        local: {
          appVersion: "0.1.14",
          stateSchemaVersion: 20,
          support: { preferred: 2, compatibleFrom: 2, warnBelow: 2 },
        },
        peer: {
          appVersion: "0.1.14",
          stateSchemaVersion: 20,
          support: { preferred: 1, compatibleFrom: 1, warnBelow: 1 },
        },
      },
    });

    expect(snapshot.status).toBe("no-common");
    expect(compatibilityStatusColor(snapshot.status)).toBe(HUE.crimson);
    expect(html).toContain("Update required (Protocol mismatch)");
    expect(html).toContain("Peers have no common Station protocol");
  });

  it("renders checking when probe is actively running", () => {
    const { snapshot, html } = renderSection({
      hostId: "studio",
      reachabilityStatus: "probing",
    });

    expect(snapshot.status).toBe("checking");
    expect(compatibilityStatusColor(snapshot.status)).toBe(HUE.cyan);
    expect(html).toContain("Checking connectivity");
  });

  it("renders stale-evidence when observation is older than threshold", () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { snapshot, html } = renderSection({
      hostId: "studio",
      reachabilityStatus: "reachable",
      remoteObservation: {
        hostId: "studio",
        endpoint: "studio-box",
        reachability: "reachable",
        observedAt: staleTime,
        expectedInstallationId: "inst-1",
        source: "live",
      },
    });

    expect(snapshot.status).toBe("stale-evidence");
    expect(compatibilityStatusColor(snapshot.status)).toBe(HUE.amber);
    expect(html).toContain("Stale status observation");
  });

  it("renders held route head warning when work backlog has blocked head", () => {
    const { html } = renderSection({
      hostId: "studio",
      reachabilityStatus: "reachable",
      workBacklog: {
        pendingCount: 3,
        heldRouteHead: {
          eventHome: "cc",
          entityHome: "studio",
          seq: "14",
          reason: "unrepresentable-record",
        },
      },
    });

    expect(html).toContain("data-testid=\"held-route-head-warning\"");
    expect(html).toContain("Route head held:</strong> unrepresentable-record (seq 14)");
  });

  it("surfaces compatibility on RemoteStationFaceView", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "remote-box",
      reachabilityStatus: "reachable",
    });

    const html = renderToStaticMarkup(
      createElement(RemoteStationFaceView, {
        stats: {
          role: "remote",
          hostId: "remote-box",
          compatibility: snapshot,
        },
      }),
    );

    expect(html).toContain("Compatibility");
    expect(html).toContain(snapshot.headline);
  });
});
