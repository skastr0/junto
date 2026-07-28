import {
  Deferred,
  Effect,
  Queue,
  Schema,
  Stream,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  ConfigureResponse,
  InstallationId,
  PairResponse,
  STATION_API_PROTOCOL,
  StatusResponse,
} from "../src/shared/station-api";
import { stationControlOk } from "../src/shared/station-api-envelope";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionResponseFrame,
  type StationSessionFrame,
  type StationSessionRequestFrame,
} from "../src/shared/station-session";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_PREFACE,
  StationProtocolAccept,
} from "../src/shared/station-protocol";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  configureRemoteHost,
  type ConfigureRemoteOptions,
} from "../src/main/vellum/hosts/configure-remote";
import type {
  ConfirmSshReady,
  SshLease,
  SshTransport,
} from "../src/main/vellum/ssh/service";

const installationId = Schema.decodeUnknownSync(InstallationId);
const commandCenterInstallationId = installationId("cc-installation");
const remoteInstallationId = installationId("station-installation");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const options: ConfigureRemoteOptions = {
  commandCenterInstallationId,
  appVersion: "0.1.0",
};

const remoteHost: RemoteHost = {
  id: "studio",
  hermesId: "fleet-studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio-box",
  capabilities: ["herdr", "hermes", "browser"],
};

const localHost: RemoteHost = {
  id: "local",
  label: "local",
  kind: "local",
  capabilities: ["herdr", "hermes"],
};

const statusResponse = StatusResponse.make({
  protocol: STATION_API_PROTOCOL,
  op: "status",
  installationId: remoteInstallationId,
  state: "unenrolled",
  receivedThrough: [],
  peerAcknowledgedThrough: [],
  readiness: {
    database: true,
    workControl: true,
    simulation: true,
    session: true,
  },
  observedAt: "2026-07-27T12:00:00.000Z",
});

const encodedResponse = (
  request: StationSessionRequestFrame,
  response:
    | typeof statusResponse
    | typeof PairResponse.Type
    | typeof ConfigureResponse.Type,
): Uint8Array =>
  encoder.encode(
    `${JSON.stringify(
      StationSessionResponseFrame.make({
        protocol: STATION_SESSION_PROTOCOL,
        frame: "response",
        requestId: request.requestId,
        envelope: stationControlOk(response),
      }),
    )}\n`,
  );

const parseRequest = (bytes: Uint8Array): StationSessionRequestFrame => {
  const frame = JSON.parse(decoder.decode(bytes).trim()) as
    StationSessionFrame;
  if (frame.frame !== "request") {
    throw new Error("expected a Station request frame");
  }
  return frame;
};

const makeSsh = (
  input: {
    readonly responseHostId?: string;
  } = {},
): {
  readonly ssh: typeof SshTransport.Service;
  readonly events: string[];
  readonly requests: StationSessionRequestFrame[];
} => {
  const events: string[] = [];
  const requests: StationSessionRequestFrame[] = [];
  let connection = 0;

  const connect = (
    _program: unknown,
    awaitReady: (
      lease: SshLease,
      confirm: ConfirmSshReady,
    ) => Effect.Effect<unknown, unknown, unknown>,
  ) =>
    Effect.gen(function* () {
      const index = connection;
      connection += 1;
      const bootstrap = index === 0;
      events.push(bootstrap ? "bootstrap-open" : "peer-open");

      const bootstrapOutput = yield* Deferred.make<Uint8Array>();
      const peerOutput = yield* Queue.unbounded<Uint8Array>();
      let closed = false;
      const close = Effect.suspend(() => {
        if (closed) return Effect.void;
        closed = true;
        events.push(bootstrap ? "bootstrap-close" : "peer-close");
        return bootstrap
          ? Effect.void
          : Queue.shutdown(peerOutput);
      });
      const lease: SshLease = {
        write: (bytes) =>
          Effect.gen(function* () {
            const raw = JSON.parse(
              decoder.decode(bytes).trim(),
            ) as Record<string, unknown>;
            if (!bootstrap && raw.frame === "offer") {
              events.push("protocol-offer");
              yield* Queue.offer(
                peerOutput,
                encoder.encode(
                  `${JSON.stringify(
                    StationProtocolAccept.make({
                      protocol: STATION_PROTOCOL_PREFACE,
                      frame: "accept",
                      appVersion: "0.1.0",
                      stateSchemaVersion: 1,
                      support: CURRENT_STATION_PROTOCOL_SUPPORT,
                      selected: 2,
                    }),
                  )}\n`,
                ),
              );
              return;
            }
            const request = parseRequest(bytes);
            requests.push(request);
            if (bootstrap) {
              events.push(`bootstrap-${request.request.op}`);
              yield* Deferred.succeed(
                bootstrapOutput,
                encodedResponse(request, statusResponse),
              );
              return;
            }
            events.push(request.request.op);
            if (request.request.op === "status") {
              yield* Queue.offer(
                peerOutput,
                encodedResponse(request, statusResponse),
              );
              return;
            }
            if (request.request.op === "pair") {
              yield* Queue.offer(
                peerOutput,
                encodedResponse(
                  request,
                  PairResponse.make({
                    protocol: STATION_API_PROTOCOL,
                    op: "pair",
                    commandCenterInstallationId:
                      request.request.commandCenterInstallationId,
                    stationInstallationId:
                      request.request.stationInstallationId,
                    pairedAt: "2026-07-27T12:00:01.000Z",
                  }),
                ),
              );
              return;
            }
            if (request.request.op === "configure") {
              yield* Queue.offer(
                peerOutput,
                encodedResponse(
                  request,
                  ConfigureResponse.make({
                    protocol: STATION_API_PROTOCOL,
                    op: "configure",
                    installationId: request.request.installationId,
                    configuration: {
                      ...request.request.configuration,
                      hostId:
                        (input.responseHostId ??
                          request.request.configuration.hostId) as
                          typeof request.request.configuration.hostId,
                    },
                    host: request.request.host,
                    configuredAt: "2026-07-27T12:00:02.000Z",
                  }),
                ),
              );
              return;
            }
            return yield* Effect.dieMessage(
              `unexpected enrollment operation: ${request.request.op}`,
            );
          }),
        writeSensitive: () => Effect.dieMessage("unexpected sensitive write"),
        closeInput: bootstrap
          ? Effect.sync(() => {
              events.push("bootstrap-input-close");
            })
          : Effect.dieMessage("peer input must stay open"),
        stdout: bootstrap
          ? Stream.fromEffect(Deferred.await(bootstrapOutput))
          : Stream.fromQueue(peerOutput),
        stderr: Stream.empty,
        exitCode: bootstrap ? Effect.succeed(0) : Effect.never,
        close,
      };
      const ready = yield* awaitReady(
        lease,
        ((value: unknown) => ({ value })) as ConfirmSshReady,
      );
      return (ready as { readonly value: unknown }).value;
    });

  const ssh = {
    run: () =>
      Effect.sync(() => {
        events.push("platform");
        return { stdout: "Linux\n", stderr: "" };
      }),
    connect,
    connectWithExitObservation: connect,
    transfer: () => Effect.dieMessage("Station enrollment must not transfer"),
    transact: () => Effect.dieMessage("Station enrollment must not transact"),
  } as unknown as typeof SshTransport.Service;
  return { ssh, events, requests };
};

describe("configureRemoteHost", () => {
  it("rejects local hosts before contacting OpenSSH", async () => {
    const fixture = makeSsh();
    const result = await Effect.runPromise(
      Effect.either(configureRemoteHost(fixture.ssh, localHost, options)),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.code).toBe("validation");
      expect(result.left.message).toMatch(/local/u);
    }
    expect(fixture.events).toEqual([]);
  });

  it("closes one-status bootstrap before pair and configure share one normal session", async () => {
    const fixture = makeSsh();
    const result = await Effect.runPromise(
      configureRemoteHost(fixture.ssh, remoteHost, options),
    );

    expect(fixture.events).toEqual([
      "platform",
      "bootstrap-open",
      "bootstrap-status",
      "bootstrap-input-close",
      "bootstrap-close",
      "peer-open",
      "protocol-offer",
      "status",
      "pair",
      "configure",
      "peer-close",
    ]);
    expect(
      fixture.requests.map((request) => request.request.op),
    ).toEqual(["status", "status", "pair", "configure"]);
    const pair = fixture.requests[2]?.request;
    expect(pair).toMatchObject({
      protocol: STATION_API_PROTOCOL,
      op: "pair",
      commandCenterInstallationId,
      stationInstallationId: remoteInstallationId,
      stationLabel: "Studio",
      appVersion: "0.1.0",
    });
    const configure = fixture.requests[3]?.request;
    expect(configure).toMatchObject({
      protocol: STATION_API_PROTOCOL,
      op: "configure",
      installationId: remoteInstallationId,
      configuration: {
        role: "remote",
        hostId: "studio",
        agentHostId: "fleet-studio",
        commandCenterInstallationId,
        supervisedPreferred: true,
      },
      host: {
        id: "studio",
        label: "Studio",
        kind: "remote",
        hermesId: "fleet-studio",
        capabilities: ["herdr", "hermes", "browser"],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      stationInstallationId: remoteInstallationId,
      configuredAt: "2026-07-27T12:00:02.000Z",
      station: {
        role: "remote",
        hostId: "studio",
        agentHostId: "fleet-studio",
        supervisedPreferred: true,
      },
    });
  });

  it("fails closed when the configure receipt changes the host", async () => {
    const fixture = makeSsh({ responseHostId: "other" });
    const result = await Effect.runPromise(
      Effect.either(configureRemoteHost(fixture.ssh, remoteHost, options)),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.code).toBe("conflict");
      expect(result.left.message).toMatch(/different Remote configuration/u);
    }
    expect(fixture.events.at(-1)).toBe("peer-close");
  });
});
