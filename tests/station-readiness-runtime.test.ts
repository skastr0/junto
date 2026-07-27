import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  InstallationId,
  LogicalSequence,
  StationConfiguration,
  type StationConfiguration as StationConfigurationValue,
} from "../src/shared/station-api";
import {
  stationProjectionInstalledForReadiness,
  supervisorAlignedForReadiness,
} from "../src/main/runtime";
import {
  stationProjectionContentSha256,
  type StationProjection,
  type StationStatusFacts,
} from "../src/main/vellum/station/repository";

const installationId = Schema.decodeUnknownSync(InstallationId);
const logicalSequence = Schema.decodeUnknownSync(LogicalSequence);
const stationConfiguration = Schema.decodeUnknownSync(StationConfiguration);

const commandCenterInstallationId = installationId("command-installation");
const remoteInstallationId = installationId("remote-installation");
const body = JSON.stringify({ canvases: [] });
const contentSha256 = stationProjectionContentSha256(body);
const receivedAt = "2026-07-27T15:00:01.000Z";

const remoteConfiguration = (): StationConfigurationValue =>
  stationConfiguration({
    role: "remote",
    hostId: "studio",
    agentHostId: "studio",
    commandCenterInstallationId,
    commandCenterRef: "command.tailnet",
    supervisedPreferred: true,
  });

const commandCenterConfiguration = (): StationConfigurationValue =>
  stationConfiguration({
    role: "command-center",
    hostId: "local",
    supervisedPreferred: false,
  });

const projection = (): StationProjection => ({
  scope: "full",
  generation: logicalSequence("7"),
  body,
  contentSha256,
  createdAt: "2026-07-27T15:00:00.000Z",
  receivedAt,
});

const remoteFacts = (): StationStatusFacts => ({
  installationId: remoteInstallationId,
  pairing: {
    commandCenterInstallationId,
    stationLabel: "Studio",
    appVersion: "0.1.0",
    pairedAt: "2026-07-27T14:00:00.000Z",
  },
  configuration: remoteConfiguration(),
  configuredAt: "2026-07-27T14:30:00.000Z",
  projection: {
    generation: logicalSequence("7"),
    contentSha256,
    receivedAt,
  },
  receivedThrough: [],
  peerAcknowledgedThrough: [],
});

describe("station readiness runtime facts", () => {
  it.each([
    ["remote", true, "installed", true],
    ["remote", true, "absent", false],
    ["remote", true, "unknown", false],
    ["remote", false, "absent", true],
    ["remote", false, "installed", false],
    ["command-center", false, "absent", true],
    ["command-center", false, "installed", false],
    ["command-center", false, "unknown", true],
  ] as const)(
    "aligns role %s / preference %s with observed provider %s",
    (role, supervisedPreferred, supervisedInstalled, expected) => {
      expect(
        supervisorAlignedForReadiness({
          role,
          hostId: "studio",
          supervisedPreferred,
          supervisedInstalled,
        }),
      ).toBe(expected);
    },
  );

  it("requires the exact active full projection for a Remote", () => {
    const facts = remoteFacts();
    const installed = projection();

    expect(
      stationProjectionInstalledForReadiness(facts, installed),
    ).toBe(true);
    expect(
      stationProjectionInstalledForReadiness(
        { ...facts, projection: undefined },
        installed,
      ),
    ).toBe(false);
    expect(
      stationProjectionInstalledForReadiness(facts, undefined),
    ).toBe(false);
    expect(
      stationProjectionInstalledForReadiness(facts, {
        ...installed,
        generation: logicalSequence("8"),
      }),
    ).toBe(false);
    expect(
      stationProjectionInstalledForReadiness(facts, {
        ...installed,
        contentSha256: stationProjectionContentSha256(
          JSON.stringify({ canvases: [{ id: "different" }] }),
        ),
      }),
    ).toBe(false);
    expect(
      stationProjectionInstalledForReadiness(facts, {
        ...installed,
        receivedAt: "2026-07-27T15:00:02.000Z",
      }),
    ).toBe(false);
  });

  it("does not require a projection on a configured Command Center", () => {
    const commandCenterFacts: StationStatusFacts = {
      installationId: commandCenterInstallationId,
      configuration: commandCenterConfiguration(),
      configuredAt: "2026-07-27T14:30:00.000Z",
      receivedThrough: [],
      peerAcknowledgedThrough: [],
    };
    expect(
      stationProjectionInstalledForReadiness(commandCenterFacts, undefined),
    ).toBe(true);
    expect(
      stationProjectionInstalledForReadiness(
        {
          ...commandCenterFacts,
          configuration: undefined,
        },
        undefined,
      ),
    ).toBe(false);
  });
});
