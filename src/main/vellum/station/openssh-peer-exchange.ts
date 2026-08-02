import { Cause,
  Context,
  Deferred,
  Effect,
  Result,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Sink,
  Stream, Semaphore } from "effect";
import {
  STATION_API_PROTOCOL,
  StatusRequest,
  type InstallationId as InstallationIdValue,
  type StationApiRequest,
} from "@shared/station-api";
import { stationControlErr } from "@shared/station-api-envelope";
import {
  StationSessionFrame,
  decodeStationSessionFrame,
} from "@shared/station-session";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_PREFACE,
  StationAppVersion,
  StationProtocolOffer,
  StationProtocolPreface,
  StationStateSchemaVersion,
  decideStationProtocolPreface,
  decodeStationProtocolPreface,
  selectStationProtocolCodec,
  type StationProtocolAccept,
  type StationProtocolReject,
} from "@shared/station-protocol";
import { STATION_CONTROL_MAX_FRAME_BYTES } from "@shared/station-ssh-control";
import {
  SshExitError,
  inspectSshTarget,
  type SshError,
  type SshTarget,
} from "../ssh/domain";
import { sharedStream } from "../ssh/program";
import {
  SshTransport,
  type SshLease,
} from "../ssh/service";
import {
  resolveRemoteStationHelper,
  type RemotePackagedPlatform,
} from "../ssh/read-commands";
import {
  StationPeerExchange,
  StationPeerExchangeError,
  isStationPeerRoute,
  mintStationPeerRoute,
  type StationPeerRoute,
  type StationRemoteReportHandler,
} from "./peer-exchange";
import {
  StationSessionTransportError,
  bindNegotiatedStationProtocol,
  makeStationPeerSession,
  type StationPeerProtocolBinding,
  type StationPeerProtocolDiagnostics,
  type StationSessionFrameTransport,
} from "./peer-session";

export const STATION_OPENSSH_MAX_FRAME_BYTES =
  STATION_CONTROL_MAX_FRAME_BYTES;
export const STATION_OPENSSH_MAX_QUEUED_FRAMES = 32;
export const STATION_OPENSSH_MAX_INBOUND_FRAMES = 32;
export const STATION_OPENSSH_MAX_QUEUED_BYTES =
  STATION_OPENSSH_MAX_FRAME_BYTES;
export const STATION_OPENSSH_WRITE_CHUNK_BYTES = 1024 * 1024;

interface OpenSshRouteDetails {
  readonly target: SshTarget;
  readonly platform: RemotePackagedPlatform;
}

const openSshRoutes = new WeakMap<StationPeerRoute, OpenSshRouteDetails>();

/**
 * Mint the OpenSSH adapter capability after fleet enrollment has resolved the
 * exact Remote installation, endpoint, and packaged-platform witness.
 */
export const admitEnrolledOpenSshStationPeer = (input: {
  readonly peerInstallationId: InstallationIdValue;
  readonly endpoint: SshTarget;
  readonly platform: RemotePackagedPlatform;
}): StationPeerRoute => {
  const route = mintStationPeerRoute(input.peerInstallationId);
  openSshRoutes.set(route, {
    target: input.endpoint,
    platform: input.platform,
  });
  return route;
};

const transportError = (
  reason: StationSessionTransportError["reason"],
  message: string,
): StationSessionTransportError =>
  StationSessionTransportError.make({ reason, message });

const readFailure = (error: unknown): StationSessionTransportError =>
  error instanceof StationSessionTransportError
    ? error
    : transportError(
        "read-failed",
        "OpenSSH Station session input failed",
      );

const writeFailure = (error: unknown): StationSessionTransportError =>
  error instanceof StationSessionTransportError
    ? error
    : transportError(
        "write-failed",
        "OpenSSH Station session output failed",
      );

const StationConnectionFrameSchema = Schema.Union([StationProtocolPreface,
StationSessionFrame,]);
type StationConnectionFrame = typeof StationConnectionFrameSchema.Type;

const decodeStationConnectionFrame = Schema.decodeUnknownResult(
  StationConnectionFrameSchema,
  { onExcessProperty: "error" },
);

interface OpenSshFrameCodec<Frame> {
  readonly contractName: string;
  readonly decode: (
    input: unknown,
  ) => Result.Result<Frame, unknown>;
}

const stationSessionFrameCodec: OpenSshFrameCodec<StationSessionFrame> = {
  contractName: "session",
  decode: decodeStationSessionFrame,
};

const stationConnectionFrameCodec: OpenSshFrameCodec<StationConnectionFrame> = {
  contractName: "connection",
  decode: decodeStationConnectionFrame,
};

const decodeFrameLine = <Frame>(
  bytes: Uint8Array,
  codec: OpenSshFrameCodec<Frame>,
): Effect.Effect<Frame, StationSessionTransportError> =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () =>
      transportError(
        "malformed-frame",
        "OpenSSH Station frame is not valid UTF-8",
      ),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () =>
          transportError(
            "malformed-frame",
            "OpenSSH Station frame is not valid JSON",
          ),
      }),
    ),
    Effect.flatMap((raw) => {
      const decoded = codec.decode(raw);
      return Result.isSuccess(decoded)
        ? Effect.succeed(decoded.success)
        : Effect.fail(
            transportError(
              "malformed-frame",
              `OpenSSH Station frame violates the ${codec.contractName} contract`,
            ),
          );
    }),
  );

interface OpenSshFrameDecoder<Frame> {
  readonly push: (
    chunk: Uint8Array,
  ) => Effect.Effect<
    ReadonlyArray<Frame>,
    StationSessionTransportError
  >;
  readonly end: Effect.Effect<
    ReadonlyArray<Frame>,
    StationSessionTransportError
  >;
}

export interface OpenSshStationFrameDecoder
  extends OpenSshFrameDecoder<StationSessionFrame> {}

/**
 * Incremental strict NDJSON decoder. It retains at most one bounded partial
 * line and emits complete frames before reading more transport bytes.
 */
const makeOpenSshFrameDecoder = <Frame>(
  codec: OpenSshFrameCodec<Frame>,
  maxFrameBytes: number,
): OpenSshFrameDecoder<Frame> => {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;

  const overflow = (): StationSessionTransportError =>
    transportError(
      "frame-too-large",
      `OpenSSH Station frame exceeds ${maxFrameBytes} bytes`,
    );

  const push = (
    chunk: Uint8Array,
  ): Effect.Effect<
    ReadonlyArray<Frame>,
    StationSessionTransportError
  > =>
    Effect.suspend(() => {
      const lines: Uint8Array[] = [];
      let offset = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const segment = chunk.subarray(offset, index);
        const lineBytes = pendingBytes + segment.byteLength;
        if (lineBytes + 1 > maxFrameBytes) {
          return Effect.fail(overflow());
        }
        if (lineBytes === 0) {
          return Effect.fail(
            transportError(
              "malformed-frame",
              "OpenSSH Station session does not admit empty frames",
            ),
          );
        }
        lines.push(
          Buffer.concat(
            [...pending, segment].map((part) => Buffer.from(part)),
            lineBytes,
          ),
        );
        pending = [];
        pendingBytes = 0;
        offset = index + 1;
      }

      const remainder = chunk.subarray(offset);
      if (remainder.byteLength > 0) {
        pendingBytes += remainder.byteLength;
        if (pendingBytes + 1 > maxFrameBytes) {
          return Effect.fail(overflow());
        }
        pending.push(Uint8Array.from(remainder));
      }
      return Effect.forEach(lines, (line) => decodeFrameLine(line, codec));
    });

  return {
    push,
    end: Effect.suspend(() =>
      pendingBytes === 0
        ? Effect.succeed([])
        : Effect.fail(
            transportError(
              "malformed-frame",
              "OpenSSH Station session ended with a truncated frame",
            ),
          ),
    ),
  };
};

export const makeOpenSshStationFrameDecoder = (
  maxFrameBytes = STATION_OPENSSH_MAX_FRAME_BYTES,
): OpenSshStationFrameDecoder =>
  makeOpenSshFrameDecoder(stationSessionFrameCodec, maxFrameBytes);

const encodeOpenSshFrame = <Frame>(
  frame: Frame,
  codec: OpenSshFrameCodec<Frame>,
  maxFrameBytes: number,
): Effect.Effect<Uint8Array, StationSessionTransportError> => {
  const decoded = codec.decode(frame);
  if (Result.isFailure(decoded)) {
    return Effect.fail(
      transportError(
        "malformed-frame",
        `Outbound OpenSSH Station frame violates the ${codec.contractName} contract`,
      ),
    );
  }
  return Effect.try({
    try: () =>
      new TextEncoder().encode(`${JSON.stringify(decoded.success)}\n`),
    catch: () =>
      transportError(
        "malformed-frame",
        "Outbound OpenSSH Station frame could not be encoded",
      ),
  }).pipe(
    Effect.flatMap((encoded) =>
      encoded.byteLength <= maxFrameBytes
        ? Effect.succeed(encoded)
        : Effect.fail(
            transportError(
              "frame-too-large",
              `OpenSSH Station frame exceeds ${maxFrameBytes} bytes`,
            ),
          ),
    ),
  );
};

/** Strict encoder whose byte bound includes the mandatory trailing LF. */
export const encodeOpenSshStationFrame = (
  frame: StationSessionFrame,
  maxFrameBytes = STATION_OPENSSH_MAX_FRAME_BYTES,
): Effect.Effect<Uint8Array, StationSessionTransportError> =>
  encodeOpenSshFrame(frame, stationSessionFrameCodec, maxFrameBytes);

interface OutboundFrame {
  readonly bytes: Uint8Array;
  readonly written: Deferred.Deferred<void, StationSessionTransportError>;
  readonly releaseBytes: Effect.Effect<void>;
}

interface OpenSshTransportState {
  readonly closed: boolean;
  readonly outstanding: ReadonlySet<OutboundFrame>;
}

type InboundFrame<Frame> =
  | {
      readonly _tag: "Frame";
      readonly frame: Frame;
    }
  | {
      readonly _tag: "Failure";
      readonly error: StationSessionTransportError;
    }
  | { readonly _tag: "End" };

export interface OpenSshStationFrameTransportOptions {
  readonly maxFrameBytes?: number;
  readonly maxQueuedBytes?: number;
  readonly maxQueuedFrames?: number;
  readonly maxInboundFrames?: number;
}

interface OpenSshFrameTransport<Frame> {
  readonly incoming: Stream.Stream<
    Frame,
    StationSessionTransportError
  >;
  readonly send: (
    frame: Frame,
  ) => Effect.Effect<void, StationSessionTransportError>;
  readonly close: Effect.Effect<void>;
}

/**
 * Adapt one scoped SSH lease into bounded, serialized Station session frames.
 */
const makeOpenSshFrameTransport = <Frame>(
  lease: SshLease,
  codec: OpenSshFrameCodec<Frame>,
  options: OpenSshStationFrameTransportOptions = {},
  observeInboundBytes: (bytes: number) => void = () => undefined,
): Effect.Effect<OpenSshFrameTransport<Frame>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const maxFrameBytes =
      options.maxFrameBytes ?? STATION_OPENSSH_MAX_FRAME_BYTES;
    const maxQueuedBytes =
      options.maxQueuedBytes ?? STATION_OPENSSH_MAX_QUEUED_BYTES;
    const maxQueuedFrames =
      options.maxQueuedFrames ?? STATION_OPENSSH_MAX_QUEUED_FRAMES;
    const maxInboundFrames =
      options.maxInboundFrames ?? STATION_OPENSSH_MAX_INBOUND_FRAMES;
    const outbound = yield* Queue.bounded<OutboundFrame>(maxQueuedFrames);
    const inbound = yield* Queue.bounded<InboundFrame<Frame>>(
      maxInboundFrames,
    );
    const queuedBytes = yield* Semaphore.make(maxQueuedBytes);
    const state = yield* Ref.make<OpenSshTransportState>({
      closed: false,
      outstanding: new Set(),
    });
    const closedSignal = yield* Deferred.make<void>();
    const decoder = makeOpenSshFrameDecoder(codec, maxFrameBytes);
    const closedError = transportError(
      "closed",
      "OpenSSH Station session is closed",
    );

    const unavailable: Effect.Effect<never, StationSessionTransportError> =
      Deferred.await(closedSignal).pipe(
        Effect.zipRight(Effect.fail(closedError)),
      );

    const releaseOnce = (bytes: number): Effect.Effect<void> => {
      let released = false;
      return Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        return queuedBytes.release(bytes).pipe(Effect.asVoid);
      });
    };

    const completeAbandoned = (
      frames: ReadonlyArray<OutboundFrame>,
    ): Effect.Effect<void> =>
      Effect.forEach(
        frames,
        (frame) =>
          Deferred.fail(frame.written, closedError).pipe(
            Effect.zipRight(frame.releaseBytes),
          ),
        { discard: true },
      );

    const removeOutstanding = (
      frame: OutboundFrame,
    ): Effect.Effect<void> =>
      Ref.update(state, (current) => {
        if (!current.outstanding.has(frame)) return current;
        const outstanding = new Set(current.outstanding);
        outstanding.delete(frame);
        return { ...current, outstanding };
      });

    const close = Effect.fn("OpenSshStationFrameTransport.close")(() =>
      Effect.gen(function* () {
        const abandoned = yield* Ref.modify(state, (current) => {
          if (current.closed) {
            return [
              Option.none<ReadonlyArray<OutboundFrame>>(),
              current,
            ] as const;
          }
          return [
            Option.some([...current.outstanding]),
            {
              closed: true,
              outstanding: new Set<OutboundFrame>(),
            },
          ] as const;
        });
        if (Option.isNone(abandoned)) return;
        yield* Deferred.succeed(closedSignal, undefined);
        yield* Queue.shutdown(outbound);
        yield* Queue.shutdown(inbound);
        yield* completeAbandoned(abandoned.value);
        yield* lease.close;
      }).pipe(Effect.uninterruptible),
    );

    const writeBytes = (bytes: Uint8Array): Effect.Effect<void, SshError> =>
      Effect.forEach(
        Array.from(
          {
            length: Math.ceil(
              bytes.byteLength / STATION_OPENSSH_WRITE_CHUNK_BYTES,
            ),
          },
          (_, index) =>
            bytes.subarray(
              index * STATION_OPENSSH_WRITE_CHUNK_BYTES,
              Math.min(
                (index + 1) * STATION_OPENSSH_WRITE_CHUNK_BYTES,
                bytes.byteLength,
              ),
            ),
        ),
        lease.write,
        { discard: true },
      );

    const writeOne = (frame: OutboundFrame): Effect.Effect<void> =>
      writeBytes(frame.bytes).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Deferred.fail(frame.written, writeFailure(error)).pipe(
              Effect.zipRight(close()),
              Effect.asVoid,
            ),
          onSuccess: () =>
            Deferred.succeed(frame.written, undefined).pipe(Effect.asVoid),
        }),
        Effect.ensuring(removeOutstanding(frame)),
        Effect.ensuring(frame.releaseBytes),
      );

    const writer = Effect.forever(
      Queue.take(outbound).pipe(Effect.flatMap(writeOne)),
    );

    const offerInbound = (
      message: InboundFrame<Frame>,
    ): Effect.Effect<void> =>
      Queue.offer(inbound, message).pipe(Effect.asVoid, Effect.ignore);

    const decodeInput = Stream.runForEach(lease.stdout, (chunk) => {
      observeInboundBytes(chunk.byteLength);
      return decoder.push(chunk).pipe(
        Effect.flatMap((frames) =>
          Effect.forEach(
            frames,
            (frame) => offerInbound({ _tag: "Frame", frame }),
            { discard: true },
          ),
        ),
      );
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          offerInbound({
            _tag: "Failure",
            error: readFailure(error),
          }),
        onSuccess: () =>
          decoder.end.pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                offerInbound({ _tag: "Failure", error }),
              onSuccess: () => offerInbound({ _tag: "End" }),
            }),
          ),
      }),
    );

    const incoming = Stream.fromQueue(inbound).pipe(
      Stream.takeUntil((message) => message._tag === "End"),
      Stream.mapEffect((message) => {
        switch (message._tag) {
          case "Frame":
            return Effect.succeed(Option.some(message.frame));
          case "Failure":
            return Effect.fail(message.error);
          case "End":
            return Effect.succeed(Option.none<Frame>());
        }
      }),
      Stream.filterMap((frame) => frame),
    );

    const send = (
      frame: Frame,
    ): Effect.Effect<void, StationSessionTransportError> =>
      Effect.gen(function* () {
        if ((yield* Ref.get(state)).closed) {
          return yield* closedError;
        }
        const bytes = yield* encodeOpenSshFrame(
          frame,
          codec,
          maxFrameBytes,
        );
        if (bytes.byteLength > maxQueuedBytes) {
          return yield* transportError(
            "queue-capacity",
            `OpenSSH Station frame exceeds the ${maxQueuedBytes}-byte outbound queue`,
          );
        }
        const written = yield* Deferred.make<
          void,
          StationSessionTransportError
        >();
        const releaseBytes = releaseOnce(bytes.byteLength);
        const outboundFrame: OutboundFrame = {
          bytes,
          written,
          releaseBytes,
        };
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(
              Effect.raceFirst(
                queuedBytes.take(bytes.byteLength).pipe(Effect.asVoid),
                unavailable,
              ),
            );
            const registered = yield* Ref.modify(
              state,
              (current) => {
                if (current.closed) return [false, current] as const;
                const outstanding = new Set(current.outstanding);
                outstanding.add(outboundFrame);
                return [
                  true,
                  { ...current, outstanding },
                ] as const;
              },
            );
            if (!registered) {
              yield* releaseBytes;
              return yield* closedError;
            }
            const accepted = yield* restore(
              Effect.raceFirst(
                Queue.offer(outbound, outboundFrame),
                unavailable,
              ),
            ).pipe(
              Effect.catchCause((cause) =>
                Cause.isInterruptedOnly(cause)
                  ? Ref.get(state).pipe(
                      Effect.flatMap((current) =>
                        current.closed
                          ? Effect.fail(closedError)
                          : Effect.failCause(cause)
                      ),
                    )
                  : Effect.failCause(cause)
              ),
              Effect.onError(() =>
                removeOutstanding(outboundFrame).pipe(
                  Effect.zipRight(releaseBytes),
                )
              ),
            );
            if (!accepted) {
              yield* removeOutstanding(outboundFrame);
              yield* releaseBytes;
              return yield* closedError;
            }
            yield* restore(Deferred.await(written));
          }),
        );
      });

    yield* Effect.addFinalizer(close);
    yield* Effect.forkScoped(writer);
    yield* Effect.forkScoped(decodeInput);
    yield* Effect.forkScoped(Stream.runDrain(lease.stderr).pipe(Effect.ignore));

    return {
      incoming,
      send,
      close: close(),
    };
  });

export const makeOpenSshStationFrameTransport = (
  lease: SshLease,
  options: OpenSshStationFrameTransportOptions = {},
): Effect.Effect<StationSessionFrameTransport, never, Scope.Scope> =>
  makeOpenSshFrameTransport(
    lease,
    stationSessionFrameCodec,
    options,
  );

const exchangeError = (
  peerInstallationId: InstallationIdValue,
  reason: StationPeerExchangeError["reason"],
  message: string,
  diagnostics: {
    readonly localProtocol?: StationPeerProtocolDiagnostics;
    readonly peerProtocol?: StationPeerProtocolDiagnostics;
  } = {},
): StationPeerExchangeError =>
  StationPeerExchangeError.make({
    peerInstallationId,
    reason,
    message,
    ...diagnostics,
  });

export interface OpenSshStationPeerExchangeDiagnostics
  extends StationPeerProtocolDiagnostics {}

const DEFAULT_OPENSSH_STATION_DIAGNOSTICS:
  OpenSshStationPeerExchangeDiagnostics = Object.freeze({
    appVersion: Schema.decodeUnknownSync(StationAppVersion)("development"),
    stateSchemaVersion: Schema.decodeUnknownSync(
      StationStateSchemaVersion,
    )(1),
    support: CURRENT_STATION_PROTOCOL_SUPPORT,
  });

const prefacePeerDiagnostics = (
  response: StationProtocolAccept | StationProtocolReject,
): StationPeerProtocolDiagnostics => ({
  appVersion: response.appVersion,
  stateSchemaVersion: response.stateSchemaVersion,
  support: response.support,
});

const asSessionTransport = (
  connection: OpenSshFrameTransport<StationConnectionFrame>,
  incoming: Stream.Stream<
    StationConnectionFrame,
    StationSessionTransportError
  > = connection.incoming,
): StationSessionFrameTransport => ({
  incoming: incoming.pipe(
    Stream.mapEffect((frame) => {
      const decoded = decodeStationSessionFrame(frame);
      return Result.isSuccess(decoded)
        ? Effect.succeed(decoded.success)
        : Effect.fail(
            transportError(
              "malformed-frame",
              "OpenSSH Station connection changed protocol after binding",
            ),
          );
    }),
  ),
  send: (frame) => connection.send(frame),
  close: connection.close,
});

const openError = (
  peerInstallationId: InstallationIdValue,
  error: unknown,
  localProtocol: StationPeerProtocolDiagnostics,
): StationPeerExchangeError => {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "StationPeerExchangeError"
  ) {
    return error as StationPeerExchangeError;
  }
  if (
    error instanceof StationSessionTransportError &&
    (
      error.reason === "malformed-frame" ||
      error.reason === "frame-too-large"
    )
  ) {
    return exchangeError(
      peerInstallationId,
      "protocol-negotiation",
      error.message,
      { localProtocol },
    );
  }
  return exchangeError(
    peerInstallationId,
    "connect-failed",
    "OpenSSH Station peer session could not be opened",
    { localProtocol },
  );
};

const makeVerifiedCommandCenterSession = (
  commandCenterInstallationId: InstallationIdValue,
  peerInstallationId: InstallationIdValue,
  protocol: StationPeerProtocolBinding,
  transport: StationSessionFrameTransport,
  onRemoteReport: StationRemoteReportHandler,
) =>
  Effect.gen(function* () {
    const verified = yield* Deferred.make<void>();
    const session = yield* makeStationPeerSession({
      localRole: "command-center",
      localInstallationId: commandCenterInstallationId,
      peerInstallationId,
      protocol,
      transport,
      handleRequest: (request: StationApiRequest) =>
        request.op === "report"
          ? Deferred.await(verified).pipe(
              Effect.zipRight(
                Effect.suspend(() => onRemoteReport(request)),
              ),
            )
          : Effect.succeed(
              stationControlErr(
                "authorization_denied",
                "A Remote may initiate only report",
                false,
              ),
            ),
    });

    // Identity is a same-session fact, not a property inferred from the SSH
    // route. Session correlation strictly requires this response's
    // installationId to equal peerInstallationId and closes on mismatch.
    yield* session.request(
      StatusRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "status",
      }),
    );
    yield* Deferred.succeed(verified, undefined);
    return session;
  });

export const makeOpenSshStationPeerExchange = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  commandCenterInstallationId: InstallationIdValue,
  diagnostics: OpenSshStationPeerExchangeDiagnostics =
    DEFAULT_OPENSSH_STATION_DIAGNOSTICS,
): Context.Service.Shape<typeof StationPeerExchange> => {
  const localProtocol: StationPeerProtocolDiagnostics = {
    appVersion: diagnostics.appVersion,
    stateSchemaVersion: diagnostics.stateSchemaVersion,
    support: diagnostics.support,
  };

  const open = Effect.fn("OpenSshStationPeerExchange.open")(
    (
      route: StationPeerRoute,
      onRemoteReport: StationRemoteReportHandler,
    ) =>
      Effect.gen(function* () {
        const details = openSshRoutes.get(route);
        if (!isStationPeerRoute(route) || details === undefined) {
          return yield* Effect.fail(
            exchangeError(
              route.peerInstallationId,
              "unsupported-route",
              "Station peer route was not admitted by the OpenSSH adapter",
            ),
          );
        }

        const offer = StationProtocolOffer.make({
          protocol: STATION_PROTOCOL_PREFACE,
          frame: "offer",
          ...localProtocol,
        });
        const negotiationCommand = yield* resolveRemoteStationHelper(
          ssh,
          details.target,
          details.platform,
          "negotiation",
        );
        const negotiatedAttempt = yield* ssh
          .connectWithExitObservation(
            sharedStream(details.target, negotiationCommand, "agent"),
            (lease, confirm) =>
              Effect.gen(function* () {
                const connection = yield* makeOpenSshFrameTransport(
                  lease,
                  stationConnectionFrameCodec,
                );
                yield* connection.send(offer);

                // `connectWithExitObservation` lets this consumer own the
                // process-exit race. None is observable only after stdout EOF
                // and decoder drain, so code 64 is a true zero-byte witness.
                const [first, remaining] = yield* Stream.peel(
                  connection.incoming,
                  Sink.head(),
                );
                if (Option.isNone(first)) {
                  const code = yield* lease.exitCode;
                  return yield* new SshExitError({
                    endpoint: inspectSshTarget(details.target).endpoint,
                    operation: "stream",
                    code,
                  });
                }

                const decoded = decodeStationProtocolPreface(first.value);
                if (
                  Result.isFailure(decoded) ||
                  decoded.success.frame === "offer"
                ) {
                  return yield* Effect.fail(
                    exchangeError(
                      route.peerInstallationId,
                      "protocol-negotiation",
                      "Remote did not return one strict compatibility response",
                      { localProtocol },
                    ),
                  );
                }
                const response = decoded.success;
                const peerProtocol = prefacePeerDiagnostics(response);
                const decision = decideStationProtocolPreface(offer, response);
                switch (decision._tag) {
                  case "no-common":
                    return yield* Effect.fail(
                      exchangeError(
                        route.peerInstallationId,
                        "protocol-incompatible",
                        "Command Center and Remote have no common Station protocol",
                        { localProtocol, peerProtocol },
                      ),
                    );
                  case "invalid-accept":
                  case "invalid-reject":
                    return yield* Effect.fail(
                      exchangeError(
                        route.peerInstallationId,
                        "protocol-negotiation",
                        "Remote returned an inconsistent compatibility decision",
                        { localProtocol, peerProtocol },
                      ),
                    );
                  case "accepted":
                    break;
                }
                const codec = selectStationProtocolCodec(decision.selected);
                if (Result.isFailure(codec)) {
                  return yield* Effect.fail(
                    exchangeError(
                      route.peerInstallationId,
                      "protocol-negotiation",
                      `Station protocol ${decision.selected} has no compiled codec`,
                      { localProtocol, peerProtocol },
                    ),
                  );
                }
                const protocol = bindNegotiatedStationProtocol({
                  negotiatedProtocol: codec.success,
                  local: localProtocol,
                  peer: peerProtocol,
                });
                const session = yield* makeVerifiedCommandCenterSession(
                  commandCenterInstallationId,
                  route.peerInstallationId,
                  protocol,
                  asSessionTransport(connection, remaining),
                  onRemoteReport,
                );
                return confirm(session);
              }),
          )
          .pipe(Effect.result);
        if (Result.isSuccess(negotiatedAttempt)) {
          return negotiatedAttempt.success;
        }
        return yield* Effect.fail(
          openError(
            route.peerInstallationId,
            negotiatedAttempt.failure,
            localProtocol,
          ),
        );
      }).pipe(
        Effect.mapError((error) =>
          openError(route.peerInstallationId, error, localProtocol),
        ),
      ),
  );
  return StationPeerExchange.of({ open });
};

export const OpenSshStationPeerExchangeLive = (
  commandCenterInstallationId: InstallationIdValue,
  diagnostics: OpenSshStationPeerExchangeDiagnostics =
    DEFAULT_OPENSSH_STATION_DIAGNOSTICS,
) =>
  Layer.effect(
    StationPeerExchange,
    Effect.map(SshTransport, (ssh) =>
      makeOpenSshStationPeerExchange(
        ssh,
        commandCenterInstallationId,
        diagnostics,
      ),
    ),
  );
