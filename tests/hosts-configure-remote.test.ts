import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ConfigureResponse,
  InstallationId,
  PairResponse,
  STATION_API_PROTOCOL,
  StatusResponse,
} from "../src/shared/station-api";
import type { StationBrowserPinnedTrustRecord } from "../src/shared/station-browser";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  configureRemoteHost,
  type ConfigureRemoteOptions,
  type StationRemote,
} from "../src/main/vellum/hosts/configure-remote";

const installationId = Schema.decodeUnknownSync(InstallationId);
const commandCenterInstallationId = installationId("cc-installation");
const remoteInstallationId = installationId("station-installation");

const browserTrust: StationBrowserPinnedTrustRecord = {
  version: 1,
  generation: 1,
  keyId: "ed25519-command-center",
  originInstallationId: commandCenterInstallationId,
  status: "active",
  publicKeySpki: Buffer.from(
    "bounded-public-key-material",
    "utf8",
  ).toString("base64"),
  replacesKeyId: null,
  updatedAt: 1_774_780_400_000,
};

const options: ConfigureRemoteOptions = {
  commandCenterInstallationId,
  commandCenterRef: "local",
  appVersion: "0.1.0",
  browserTrust,
};

const remoteHost: RemoteHost = {
  id: "studio",
  hermesId: "fleet-studio",
  label: "Studio",
  kind: "remote",
  endpoint: "studio-box",
  capabilities: ["herdr", "hermes", "browser"],
};

const localHost: RemoteHost = {
  id: "local",
  label: "local",
  kind: "local",
  capabilities: ["herdr", "hermes"],
};

type Ssh = Parameters<typeof configureRemoteHost>[0];
const unusedSsh = {} as Ssh;

const makeRemote = (
  input: {
    readonly state?: "unenrolled" | "paired" | "configured" | "ready";
    readonly responseHostId?: string;
  } = {},
) => {
  const calls: string[] = [];
  const status = vi.fn(() =>
    Effect.sync(() => {
      calls.push("status");
      return StatusResponse.make({
        protocol: STATION_API_PROTOCOL,
        op: "status",
        installationId: remoteInstallationId,
        state: input.state ?? "unenrolled",
        receivedThrough: [],
        readiness: {
          database: true,
          workControl: true,
          simulation: true,
        },
        observedAt: "2026-07-27T12:00:00.000Z",
      });
    }),
  );
  const pair = vi.fn((_endpoint, request) =>
    Effect.sync(() => {
      calls.push("pair");
      return PairResponse.make({
        protocol: STATION_API_PROTOCOL,
        op: "pair",
        commandCenterInstallationId:
          request.commandCenterInstallationId,
        stationInstallationId: request.stationInstallationId,
        pairedAt: "2026-07-27T12:00:01.000Z",
      });
    }),
  );
  const configure = vi.fn((_endpoint, request) =>
    Effect.sync(() => {
      calls.push("configure");
      const configuration =
        request.configuration.role === "remote"
          ? {
              ...request.configuration,
              hostId:
                (input.responseHostId ??
                  request.configuration.hostId) as typeof request.configuration.hostId,
            }
          : request.configuration;
      return ConfigureResponse.make({
        protocol: STATION_API_PROTOCOL,
        op: "configure",
        installationId: request.installationId,
        configuration,
        host: request.host,
        configuredAt: "2026-07-27T12:00:02.000Z",
      });
    }),
  );
  const remote = {
    status,
    pair,
    configure,
    project: () => Effect.die("project must not run"),
    report: () => Effect.die("report must not run"),
  } as StationRemote;
  return { remote, calls, status, pair, configure };
};

describe("configureRemoteHost", () => {
  it("rejects local hosts before contacting a Station", async () => {
    const { remote, status } = makeRemote();
    const result = await Effect.runPromise(
      Effect.either(
        configureRemoteHost(unusedSsh, localHost, options, remote),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.code).toBe("validation");
      expect(result.left.message).toMatch(/local/u);
    }
    expect(status).not.toHaveBeenCalled();
  });

  it("uses status, pair, and configure as the sole durable lane", async () => {
    const { remote, calls, pair, configure } = makeRemote();
    const result = await Effect.runPromise(
      configureRemoteHost(unusedSsh, remoteHost, options, remote),
    );

    expect(calls).toEqual(["status", "pair", "configure"]);
    expect(pair).toHaveBeenCalledWith(
      "studio-box",
      expect.objectContaining({
        protocol: STATION_API_PROTOCOL,
        commandCenterInstallationId,
        stationInstallationId: remoteInstallationId,
        stationLabel: "Studio",
        appVersion: "0.1.0",
      }),
    );
    expect(configure).toHaveBeenCalledWith(
      "studio-box",
      expect.objectContaining({
        installationId: remoteInstallationId,
        configuration: {
          role: "remote",
          hostId: "studio",
          agentHostId: "fleet-studio",
          commandCenterInstallationId,
          commandCenterRef: "local",
          supervisedPreferred: true,
          browserTrust,
        },
        host: remoteHost,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      stationInstallationId: remoteInstallationId,
      configuredAt: "2026-07-27T12:00:02.000Z",
      station: {
        role: "remote",
        hostId: "studio",
        agentHostId: "fleet-studio",
        commandCenterRef: "local",
        supervisedPreferred: true,
      },
    });
  });

  it("replays the typed ceremony when the Station reports ready", async () => {
    const { remote, calls } = makeRemote({ state: "ready" });
    const result = await Effect.runPromise(
      configureRemoteHost(unusedSsh, remoteHost, options, remote),
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["status", "pair", "configure"]);
  });

  it("fails closed when the configure receipt changes the host", async () => {
    const { remote } = makeRemote({ responseHostId: "other" });
    const result = await Effect.runPromise(
      Effect.either(
        configureRemoteHost(unusedSsh, remoteHost, options, remote),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.code).toBe("conflict");
      expect(result.left.message).toMatch(/different Remote configuration/u);
    }
  });
});
