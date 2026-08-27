import { Context,
  Effect,
  Layer,
  Schema,
  Scope, Semaphore } from "effect";
import {
  HostId,
  type HostId as HostIdValue,
} from "@shared/remote-hosts";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "@shared/installation-id";
import { StationContextTagIds } from "./context-services";
import {
  StationPeerSessionClosedError,
  type StationPeerProtocolBinding,
  type StationPeerSession,
} from "./peer-session";

const StationLivePeerTypeId: unique symbol = Symbol(
  "@vellum-command/station/StationLivePeer",
);

/**
 * Ephemeral proof that one exact enrolled Remote had a current Station
 * session. It is neither serializable nor durable authority.
 */
export interface StationLivePeer {
  readonly [StationLivePeerTypeId]: typeof StationLivePeerTypeId;
  readonly hostId: HostIdValue;
  readonly installationId: InstallationIdValue;
  readonly protocol: StationPeerProtocolBinding;
}

interface ActivePeer {
  readonly witness: StationLivePeer;
  readonly session: StationPeerSession;
  readonly lifetime: Semaphore.Semaphore;
}

const livePeerAuthorities = new WeakMap<StationLivePeer, ActivePeer>();

export class StationLivePeerUnavailable extends Schema.TaggedError<StationLivePeerUnavailable>()(
  "StationLivePeerUnavailable",
  {
    hostId: HostId,
    installationId: InstallationId,
    reason: Schema.Literals(["already-live", "identity-mismatch",
    "invalid-witness",
    "session-closed",
    "unavailable",]),
    message: Schema.String,
  },
) {}

const unavailable = (
  hostId: HostIdValue,
  installationId: InstallationIdValue,
  reason: StationLivePeerUnavailable["reason"],
  message: string,
): StationLivePeerUnavailable =>
  StationLivePeerUnavailable.make({
    hostId,
    installationId,
    reason,
    message,
  });

/**
 * Installation-local registry of currently admitted Remote sessions.
 *
 * `withSession` is the linearization seam for a new CC-owned remote claim:
 * session teardown cannot unregister the peer while the guarded SQLite
 * reservation runs. A disconnect immediately after commit leaves a durable
 * replayable command; it never rolls the claim back or mints a replacement.
 */
// Station plane: canonical Context.Service (effect v4).
export class StationLivePeerRegistry extends Context.Service<StationLivePeerRegistry,
  {
    readonly activate: (
      hostId: HostIdValue,
      installationId: InstallationIdValue,
      session: StationPeerSession,
    ) => Effect.Effect<
      StationLivePeer,
      StationLivePeerUnavailable,
      Scope.Scope
    >;
    readonly require: (
      hostId: HostIdValue,
      installationId: InstallationIdValue,
    ) => Effect.Effect<StationLivePeer, StationLivePeerUnavailable>;
    /**
     * Read-only scheduling hint for actor selection. This does not mint a
     * witness or authorize work; reservation must still use require +
     * withSession at the commit boundary.
     */
    readonly isLive: (
      hostId: HostIdValue,
      installationId: InstallationIdValue,
    ) => Effect.Effect<boolean>;
    /**
     * Subscribe to authoritative active-peer lifecycle changes. Notifications
     * are published only after an activation is visible or its exact matching
     * registration has been removed.
     */
    readonly subscribe: (listener: () => void) => () => void;
    readonly withSession: <A, E, R>(
      witness: StationLivePeer,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StationLivePeerUnavailable, R>;
  }>()(StationContextTagIds.livePeerRegistry) {}

export const StationLivePeerRegistryLive = Layer.effect(
  StationLivePeerRegistry,
  Effect.gen(function* () {
    const registryLock = yield* Semaphore.make(1);
    const active = new Map<HostIdValue, ActivePeer>();
    const listeners = new Set<() => void>();

    const notify = (): void => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // The lifecycle mutation is already authoritative. One observer
          // cannot prevent the remaining observers from seeing it.
        }
      }
    };

    const registered = (
      peer: ActivePeer,
    ): Effect.Effect<boolean> =>
      registryLock.withPermits(1)(
        Effect.sync(() => active.get(peer.witness.hostId) === peer),
      );

    const activate: Context.Service.Shape<
      typeof StationLivePeerRegistry
    >["activate"] = (hostId, installationId, session) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          if (
            session.peerInstallationId !== installationId ||
            !(yield* session.isOpen)
          ) {
            return yield* unavailable(
              hostId,
              installationId,
              "identity-mismatch",
              "Station session does not match the enrolled live peer",
            );
          }
          const lifetime = yield* Semaphore.make(1);
          const witness = Object.freeze({
            [StationLivePeerTypeId]: StationLivePeerTypeId,
            hostId,
            installationId,
            protocol: session.protocol,
          }) as StationLivePeer;
          const peer: ActivePeer = { witness, session, lifetime };
          const admitted = yield* registryLock.withPermits(1)(
            Effect.sync(() => {
              if (active.has(hostId)) return false;
              active.set(hostId, peer);
              livePeerAuthorities.set(witness, peer);
              return true;
            }),
          );
          if (!admitted) {
            return yield* unavailable(
              hostId,
              installationId,
              "already-live",
              "Station host already has an active peer session",
            );
          }
          yield* Effect.sync(notify);
          return peer;
        }),
        (peer) =>
          peer.lifetime.withPermits(1)(
            Effect.gen(function* () {
              const removed = yield* registryLock.withPermits(1)(
                Effect.sync(() => {
                  const isCurrent =
                    active.get(peer.witness.hostId) === peer;
                  if (isCurrent) {
                    active.delete(peer.witness.hostId);
                  }
                  livePeerAuthorities.delete(peer.witness);
                  return isCurrent;
                }),
              );
              if (removed) yield* Effect.sync(notify);
            }),
          ),
      ).pipe(Effect.map((peer) => peer.witness));

    const requirePeer: Context.Service.Shape<
      typeof StationLivePeerRegistry
    >["require"] = (hostId, installationId) =>
      registryLock.withPermits(1)(
        Effect.gen(function* () {
          const peer = active.get(hostId);
          if (peer === undefined) {
            return yield* unavailable(
              hostId,
              installationId,
              "unavailable",
              "Remote Station does not have a live session",
            );
          }
          if (peer.witness.installationId !== installationId) {
            return yield* unavailable(
              hostId,
              installationId,
              "identity-mismatch",
              "Live Station identity does not match the claim target",
            );
          }
          if (!(yield* peer.session.isOpen)) {
            return yield* unavailable(
              hostId,
              installationId,
              "session-closed",
              "Remote Station session is no longer open",
            );
          }
          return peer.witness;
        }),
      );

    const isLive: Context.Service.Shape<
      typeof StationLivePeerRegistry
    >["isLive"] = (hostId, installationId) =>
      registryLock.withPermits(1)(
        Effect.gen(function* () {
          const peer = active.get(hostId);
          return peer !== undefined &&
            peer.witness.installationId === installationId &&
            (yield* peer.session.isOpen);
        }),
      );

    const withSession: Context.Service.Shape<
      typeof StationLivePeerRegistry
    >["withSession"] = (witness, effect) => {
      const peer = livePeerAuthorities.get(witness);
      if (peer === undefined) {
        return Effect.fail(
          unavailable(
            witness.hostId,
            witness.installationId,
            "invalid-witness",
            "Live Station witness was not minted by this registry",
          ),
        );
      }
      return peer.lifetime.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* registered(peer))) {
            return yield* unavailable(
              witness.hostId,
              witness.installationId,
              "unavailable",
              "Live Station witness is no longer current",
            );
          }
          return yield* peer.session.withOpen(effect).pipe(
            Effect.mapError((error) =>
              error instanceof StationPeerSessionClosedError
                ? unavailable(
                  witness.hostId,
                  witness.installationId,
                  "session-closed",
                  "Remote Station session closed before the guarded operation",
                )
                : error
            ),
          );
        }),
      );
    };

    return StationLivePeerRegistry.of({
      activate,
      require: requirePeer,
      isLive,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      withSession,
    });
  }),
);
