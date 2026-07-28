import {
  Cause,
  Context,
  Deferred,
  Effect,
  Either,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";
import {
  type InstallationId as InstallationIdValue,
  type StationApiRequest,
} from "@shared/station-api";
import { stationControlErr } from "@shared/station-api-envelope";
import {
  decodeStationSessionFrame,
  type StationSessionFrame,
} from "@shared/station-session";
import { STATION_CONTROL_MAX_FRAME_BYTES } from "@shared/station-ssh-control";
import {
  type SshError,
  type SshTarget,
} from "../ssh/domain";
import { sharedStream } from "../ssh/program";
import {
  SshTransport,
  type SshLease,
} from "../ssh/service";
import {
  remoteVellumStation,
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
  makeStationPeerSession,
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

const decodeFrameLine = (
  bytes: Uint8Array,
): Effect.Effect<StationSessionFrame, StationSessionTransportError> =>
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
      const decoded = decodeStationSessionFrame(raw);
      return Either.isRight(decoded)
        ? Effect.succeed(decoded.right)
        : Effect.fail(
            transportError(
              "malformed-frame",
              "OpenSSH Station frame violates the session contract",
            ),
          );
    }),
  );

export interface OpenSshStationFrameDecoder {
  readonly push: (
    chunk: Uint8Array,
  ) => Effect.Effect<
    ReadonlyArray<StationSessionFrame>,
    StationSessionTransportError
  >;
  readonly end: Effect.Effect<
    ReadonlyArray<StationSessionFrame>,
    StationSessionTransportError
  >;
}

/**
 * Incremental strict NDJSON decoder. It retains at most one bounded partial
 * line and emits complete frames before reading more transport bytes.
 */
export const makeOpenSshStationFrameDecoder = (
  maxFrameBytes = STATION_OPENSSH_MAX_FRAME_BYTES,
): OpenSshStationFrameDecoder => {
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
    ReadonlyArray<StationSessionFrame>,
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
      return Effect.forEach(lines, decodeFrameLine);
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

/** Strict encoder whose byte bound includes the mandatory trailing LF. */
export const encodeOpenSshStationFrame = (
  frame: StationSessionFrame,
  maxFrameBytes = STATION_OPENSSH_MAX_FRAME_BYTES,
): Effect.Effect<Uint8Array, StationSessionTransportError> => {
  const decoded = decodeStationSessionFrame(frame);
  if (Either.isLeft(decoded)) {
    return Effect.fail(
      transportError(
        "malformed-frame",
        "Outbound OpenSSH Station frame violates the session contract",
      ),
    );
  }
  return Effect.try({
    try: () =>
      new TextEncoder().encode(`${JSON.stringify(decoded.right)}\n`),
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

interface OutboundFrame {
  readonly bytes: Uint8Array;
  readonly written: Deferred.Deferred<void, StationSessionTransportError>;
  readonly releaseBytes: Effect.Effect<void>;
}

interface OpenSshTransportState {
  readonly closed: boolean;
  readonly outstanding: ReadonlySet<OutboundFrame>;
}

type InboundFrame =
  | {
      readonly _tag: "Frame";
      readonly frame: StationSessionFrame;
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

/**
 * Adapt one scoped SSH lease into bounded, serialized Station session frames.
 */
export const makeOpenSshStationFrameTransport = (
  lease: SshLease,
  options: OpenSshStationFrameTransportOptions = {},
): Effect.Effect<StationSessionFrameTransport, never, Scope.Scope> =>
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
    const inbound = yield* Queue.bounded<InboundFrame>(maxInboundFrames);
    const queuedBytes = yield* Effect.makeSemaphore(maxQueuedBytes);
    const state = yield* Ref.make<OpenSshTransportState>({
      closed: false,
      outstanding: new Set(),
    });
    const closedSignal = yield* Deferred.make<void>();
    const decoder = makeOpenSshStationFrameDecoder(maxFrameBytes);
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

    const offerInbound = (message: InboundFrame): Effect.Effect<void> =>
      Queue.offer(inbound, message).pipe(Effect.asVoid, Effect.ignore);

    const decodeInput = Stream.runForEach(lease.stdout, (chunk) =>
      decoder.push(chunk).pipe(
        Effect.flatMap((frames) =>
          Effect.forEach(
            frames,
            (frame) => offerInbound({ _tag: "Frame", frame }),
            { discard: true },
          ),
        ),
      ),
    ).pipe(
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
            return Effect.succeed(Option.none<StationSessionFrame>());
        }
      }),
      Stream.filterMap((frame) => frame),
    );

    const send = (
      frame: StationSessionFrame,
    ): Effect.Effect<void, StationSessionTransportError> =>
      Effect.gen(function* () {
        if ((yield* Ref.get(state)).closed) {
          return yield* closedError;
        }
        const bytes = yield* encodeOpenSshStationFrame(
          frame,
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
              Effect.catchAllCause((cause) =>
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

const exchangeError = (
  peerInstallationId: InstallationIdValue,
  reason: StationPeerExchangeError["reason"],
  message: string,
): StationPeerExchangeError =>
  StationPeerExchangeError.make({
    peerInstallationId,
    reason,
    message,
  });

export const makeOpenSshStationPeerExchange = (
  ssh: Context.Tag.Service<typeof SshTransport>,
  commandCenterInstallationId: InstallationIdValue,
): Context.Tag.Service<typeof StationPeerExchange> => {
  const open = Effect.fn("OpenSshStationPeerExchange.open")(
    (
      route: StationPeerRoute,
      onRemoteReport: StationRemoteReportHandler,
    ) =>
      Effect.gen(function* () {
        const details = openSshRoutes.get(route);
        if (!isStationPeerRoute(route) || details === undefined) {
          return yield* exchangeError(
            route.peerInstallationId,
            "unsupported-route",
            "Station peer route was not admitted by the OpenSSH adapter",
          );
        }
        const command = yield* remoteVellumStation(details.platform);
        return yield* ssh.connect(
          sharedStream(details.target, command, "agent"),
          (lease, confirm) =>
            Effect.gen(function* () {
              const transport =
                yield* makeOpenSshStationFrameTransport(lease);
              const session = yield* makeStationPeerSession({
                localRole: "command-center",
                localInstallationId: commandCenterInstallationId,
                peerInstallationId: route.peerInstallationId,
                transport,
                handleRequest: (request: StationApiRequest) =>
                  request.op === "report"
                    ? onRemoteReport(request)
                    : Effect.succeed(
                        stationControlErr(
                          "authorization_denied",
                          "A Remote may initiate only report",
                          false,
                        ),
                      ),
              });
              return confirm(session);
            }),
        );
      }).pipe(
        Effect.mapError((error) =>
          error instanceof StationPeerExchangeError
            ? error
            : exchangeError(
                route.peerInstallationId,
                "connect-failed",
                "OpenSSH Station peer session could not be opened",
              ),
        ),
      ),
  );
  return StationPeerExchange.of({ open });
};

export const OpenSshStationPeerExchangeLive = (
  commandCenterInstallationId: InstallationIdValue,
) =>
  Layer.effect(
    StationPeerExchange,
    Effect.map(SshTransport, (ssh) =>
      makeOpenSshStationPeerExchange(
        ssh,
        commandCenterInstallationId,
      ),
    ),
  );
