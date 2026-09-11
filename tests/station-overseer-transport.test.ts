import {
  Deferred,
  Effect,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  OVERSEER_MAX_REQUEST_BYTES,
  OverseerCaller,
  OverseerRequest,
  type OverseerResult,
} from "../src/shared/overseer-control";
import {
  InstallationId,
  STATION_API_PROTOCOL,
  StationOverseerRequest,
  StationOverseerResponse,
  overseerResponseMatchesRequest,
  type StationOverseerRequest as StationOverseerRequestValue,
} from "../src/shared/station-api";
import { stationControlOk } from "../src/shared/station-api-envelope";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  StationAppVersion,
  StationStateSchemaVersion,
} from "../src/shared/station-protocol";
import type { StationSessionFrame } from "../src/shared/station-session";
import {
  bindNegotiatedStationProtocol,
  makeStationPeerSession,
  type StationSessionFrameTransport,
} from "../src/main/vellum-command/station/peer-session";
import {
  StationControlReportError,
} from "../src/main/vellum-command/station/control-server";
import {
  dispatchRegisteredStationRemoteOverseer,
  makeRemoteStationOverseerDispatcher,
  registerStationRemoteOverseerHandler,
} from "../src/main/vellum-command/station/overseer-transport";

const installationId = Schema.decodeUnknownSync(InstallationId);
const REMOTE = installationId("remote-overseer-test");
const COMMAND_CENTER = installationId("cc-overseer-test");
const OTHER = installationId("other-overseer-test");
const caller = Schema.decodeUnknownSync(OverseerCaller)({
  canvasName: "factory",
  nodeId: "remote-agent",
});
const request = Schema.decodeUnknownSync(OverseerRequest)({
  operation: "status",
  args: {},
});
const success = (data: unknown = { role: "overseer" }): OverseerResult => ({
  ok: true,
  operation: "status",
  data,
});

const stationRequest = (sender = REMOTE) =>
  Schema.decodeUnknownSync(StationOverseerRequest, {
    onExcessProperty: "error",
  })({
    protocol: STATION_API_PROTOCOL,
    op: "overseer",
    senderInstallationId: sender,
    targetInstallationId: COMMAND_CENTER,
    caller,
    request,
  });

const stationResponse = (
  input = stationRequest(),
  responseCaller = caller,
) =>
  Schema.decodeUnknownSync(StationOverseerResponse, {
    onExcessProperty: "error",
  })({
    protocol: STATION_API_PROTOCOL,
    op: "overseer",
    senderInstallationId: COMMAND_CENTER,
    targetInstallationId: input.senderInstallationId,
    caller: responseCaller,
    result: success(),
  });

const diagnostics = {
  appVersion: Schema.decodeUnknownSync(StationAppVersion)("test"),
  stateSchemaVersion: Schema.decodeUnknownSync(StationStateSchemaVersion)(1),
  support: CURRENT_STATION_PROTOCOL_SUPPORT,
};
const protocol = bindNegotiatedStationProtocol({
  negotiatedProtocol: STATION_PROTOCOL_BASELINE,
  local: diagnostics,
  peer: diagnostics,
});

const pairedTransports = Effect.gen(function* () {
  const remoteIncoming = yield* Queue.unbounded<StationSessionFrame>();
  const ccIncoming = yield* Queue.unbounded<StationSessionFrame>();
  const closeBoth = Effect.all([
    (Queue.end as unknown as (
      queue: typeof remoteIncoming,
    ) => Effect.Effect<boolean>)(remoteIncoming),
    (Queue.end as unknown as (
      queue: typeof ccIncoming,
    ) => Effect.Effect<boolean>)(ccIncoming),
  ]).pipe(Effect.asVoid);
  const remote: StationSessionFrameTransport = {
    incoming: Stream.fromQueue(remoteIncoming),
    send: (frame) => Queue.offer(ccIncoming, frame).pipe(Effect.asVoid),
    close: closeBoth,
  };
  const commandCenter: StationSessionFrameTransport = {
    incoming: Stream.fromQueue(ccIncoming),
    send: (frame) => Queue.offer(remoteIncoming, frame).pipe(Effect.asVoid),
    close: closeBoth,
  };
  return { remote, commandCenter };
});

describe("Remote overseer Station transport", () => {
  it("strictly decodes bounded identity-bearing requests and exact responses", () => {
    const admitted = stationRequest();
    expect(overseerResponseMatchesRequest(admitted, stationResponse(admitted)))
      .toBe(true);

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(StationOverseerRequest, {
          onExcessProperty: "error",
        })({
          ...admitted,
          caller: { ...caller, installationId: REMOTE },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(StationOverseerRequest, {
          onExcessProperty: "error",
        })({
          ...admitted,
          request: {
            operation: "status",
            args: { payload: "x".repeat(OVERSEER_MAX_REQUEST_BYTES + 1) },
          },
        }),
      ),
    ).toBe(true);
    expect(
      overseerResponseMatchesRequest(
        admitted,
        stationResponse(admitted, { ...caller, nodeId: "operator-seat" }),
      ),
    ).toBe(false);
  });

  it("registers one current CC authority callback and fails closed without it", async () => {
    const source = { installationId: REMOTE, caller };
    const absent = await Effect.runPromise(
      dispatchRegisteredStationRemoteOverseer(request, source),
    );
    expect(absent).toMatchObject({
      ok: false,
      error: { type: "Forbidden" },
    });

    let observedSource: typeof source | undefined;
    const dispose = registerStationRemoteOverseerHandler((received, authenticated) => {
      observedSource = authenticated;
      return Effect.succeed(success({ operation: received.operation }));
    });
    expect(() =>
      registerStationRemoteOverseerHandler(() => Effect.succeed(success()))
    ).toThrow("already registered");
    const handled = await Effect.runPromise(
      dispatchRegisteredStationRemoteOverseer(request, source),
    );
    expect(handled).toEqual(success({ operation: "status" }));
    expect(observedSource).toEqual(source);
    dispose();

    const afterDispose = await Effect.runPromise(
      dispatchRegisteredStationRemoteOverseer(request, source),
    );
    expect(afterDispose.ok).toBe(false);
  });

  it("round-trips one command across two correlated live sessions", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transports = yield* pairedTransports;
          const observed = yield* Deferred.make<StationOverseerRequestValue>();
          yield* makeStationPeerSession({
            localRole: "command-center",
            localInstallationId: COMMAND_CENTER,
            peerInstallationId: REMOTE,
            protocol,
            transport: transports.commandCenter,
            handleRequest: (incoming) => {
              if (incoming.op !== "overseer") {
                return Effect.die("expected overseer request");
              }
              return Deferred.succeed(observed, incoming).pipe(
                Effect.andThen(
                  Effect.succeed(
                    stationControlOk(stationResponse(incoming)),
                  ),
                ),
              );
            },
          });
          const remote = yield* makeStationPeerSession({
            localRole: "remote",
            localInstallationId: REMOTE,
            peerInstallationId: COMMAND_CENTER,
            protocol,
            transport: transports.remote,
            handleRequest: () => Effect.die("Remote accepts no inbound test request"),
          });

          const response = yield* remote.request(stationRequest());
          expect(response.result).toEqual(success());
          expect((yield* Deferred.await(observed)).caller).toEqual(caller);
          expect(yield* remote.isOpen).toBe(true);
        }),
      ),
    );
  });

  it("rejects a request whose claimed sender is not the live Remote session", async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transports = yield* pairedTransports;
          const remote = yield* makeStationPeerSession({
            localRole: "remote",
            localInstallationId: REMOTE,
            peerInstallationId: COMMAND_CENTER,
            protocol,
            transport: transports.remote,
            handleRequest: () => Effect.die("unexpected inbound request"),
          });
          return yield* remote.request(stationRequest(OTHER));
        }),
      ),
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      _tag: "StationPeerSessionProtocolError",
      reason: "outbound-route-mismatch",
    });
  });

  it("reports timeout/disconnect as uncertain completion without replay", async () => {
    let attempts = 0;
    const dispatcher = makeRemoteStationOverseerDispatcher({
      remoteInstallationId: REMOTE,
      commandCenterInstallationId: COMMAND_CENTER,
      control: {
        sessionReady: () => true,
        overseer: async () => {
          attempts += 1;
          throw new StationControlReportError(
            "request-timeout",
            "connection closed after send",
          );
        },
      },
    });

    await expect(dispatcher.dispatch(request, caller)).rejects.toMatchObject({
      name: "StationRemoteOverseerDispatchError",
      failure: "uncertain-completion",
    });
    expect(attempts).toBe(1);
  });

  it("derives Station direction around the process caller", async () => {
    let observed: StationOverseerRequestValue | undefined;
    const dispatcher = makeRemoteStationOverseerDispatcher({
      remoteInstallationId: REMOTE,
      commandCenterInstallationId: COMMAND_CENTER,
      control: {
        sessionReady: () => true,
        overseer: async (incoming) => {
          observed = incoming;
          return stationResponse(incoming);
        },
      },
    });

    await expect(dispatcher.dispatch(request, caller)).resolves.toEqual(success());
    expect(observed).toMatchObject({
      senderInstallationId: REMOTE,
      targetInstallationId: COMMAND_CENTER,
      caller,
    });
  });
});
