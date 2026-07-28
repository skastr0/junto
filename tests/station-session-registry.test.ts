import {
  Deferred,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect";
import { describe, expect, it } from "vitest";
import { HostId } from "../src/shared/remote-hosts";
import { InstallationId } from "../src/shared/installation-id";
import {
  bindNegotiatedStationProtocol,
  type StationPeerSession,
} from "../src/main/vellum/station/peer-session";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  StationAppVersion,
  StationStateSchemaVersion,
} from "../src/shared/station-protocol";
import {
  StationLivePeerRegistry,
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";

const hostId = Schema.decodeUnknownSync(HostId);
const installationId = Schema.decodeUnknownSync(InstallationId);

const COMMAND_CENTER = installationId("registry-command-center");
const REMOTE = installationId("registry-remote");
const OTHER_REMOTE = installationId("registry-other-remote");
const HOST = hostId("registry-host");
const PROTOCOL_DIAGNOSTICS = {
  appVersion: StationAppVersion.make("registry-test"),
  stateSchemaVersion: StationStateSchemaVersion.make(1),
  support: CURRENT_STATION_PROTOCOL_SUPPORT,
};
const PROTOCOL = bindNegotiatedStationProtocol({
  negotiatedProtocol: 2,
  local: PROTOCOL_DIAGNOSTICS,
  peer: PROTOCOL_DIAGNOSTICS,
});

const makeSession = (
  peerInstallationId = REMOTE,
): Effect.Effect<{
  readonly session: StationPeerSession;
  readonly setOpen: (open: boolean) => Effect.Effect<void>;
}> =>
  Effect.gen(function* () {
    const open = yield* Ref.make(true);
    const lifecycle = yield* Effect.makeSemaphore(1);
    const session: StationPeerSession = {
      localInstallationId: COMMAND_CENTER,
      peerInstallationId,
      protocol: PROTOCOL,
      request: () => Effect.die("registry test does not issue requests"),
      withOpen: (effect) =>
        lifecycle.withPermits(1)(
          Effect.gen(function* () {
            if (!(yield* Ref.get(open))) {
              return yield* Effect.die(
                "registry test should reject a closed session before withOpen",
              );
            }
            return yield* effect;
          }),
        ),
      isOpen: Ref.get(open),
      awaitClosed: Effect.never,
      close: lifecycle.withPermits(1)(Ref.set(open, false)),
    };
    return {
      session,
      setOpen: (value) => Ref.set(open, value),
    };
  });

describe("StationLivePeerRegistry", () => {
  it("reports liveness only for the exact active identity and open session", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* StationLivePeerRegistry;
          const peer = yield* makeSession();

          yield* registry.activate(HOST, REMOTE, peer.session);

          expect(yield* registry.isLive(HOST, REMOTE)).toBe(true);
          expect((yield* registry.require(HOST, REMOTE)).protocol).toEqual(
            PROTOCOL,
          );
          expect(yield* registry.isLive(HOST, OTHER_REMOTE)).toBe(false);

          const wrongIdentity = yield* registry.require(
            HOST,
            OTHER_REMOTE,
          ).pipe(Effect.either);
          expect(Either.isLeft(wrongIdentity)).toBe(true);
          if (Either.isLeft(wrongIdentity)) {
            expect(wrongIdentity.left.reason).toBe(
              "identity-mismatch",
            );
          }

          yield* peer.setOpen(false);
          expect(yield* registry.isLive(HOST, REMOTE)).toBe(false);

          const closed = yield* registry.require(HOST, REMOTE).pipe(
            Effect.either,
          );
          expect(Either.isLeft(closed)).toBe(true);
          if (Either.isLeft(closed)) {
            expect(closed.left.reason).toBe("session-closed");
          }
        }),
      ).pipe(Effect.provide(StationLivePeerRegistryLive)),
    );
  });

  it("rejects activation when the session does not prove the requested peer", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* StationLivePeerRegistry;
          const peer = yield* makeSession(OTHER_REMOTE);

          const result = yield* registry.activate(
            HOST,
            REMOTE,
            peer.session,
          ).pipe(Effect.either);

          expect(Either.isLeft(result)).toBe(true);
          if (Either.isLeft(result)) {
            expect(result.left.reason).toBe("identity-mismatch");
          }
          expect(yield* registry.isLive(HOST, REMOTE)).toBe(false);
        }),
      ).pipe(Effect.provide(StationLivePeerRegistryLive)),
    );
  });

  it("linearizes teardown after an in-flight guarded operation", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* StationLivePeerRegistry;
          const peer = yield* makeSession();
          const peerScope = yield* Scope.make();
          const witness = yield* registry.activate(
            HOST,
            REMOTE,
            peer.session,
          ).pipe(Effect.provideService(Scope.Scope, peerScope));
          const guardedStarted = yield* Deferred.make<void>();
          const releaseGuarded = yield* Deferred.make<void>();

          const guarded = yield* registry.withSession(
            witness,
            Effect.gen(function* () {
              yield* Deferred.succeed(guardedStarted, undefined);
              yield* Deferred.await(releaseGuarded);
              return "committed" as const;
            }),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(guardedStarted);

          const closing = yield* Scope.close(
            peerScope,
            Exit.void,
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow();

          expect(Option.isNone(yield* Fiber.poll(closing))).toBe(true);
          expect(yield* registry.isLive(HOST, REMOTE)).toBe(true);
          expect(yield* registry.require(HOST, REMOTE)).toBe(witness);

          yield* Deferred.succeed(releaseGuarded, undefined);
          expect(yield* Fiber.join(guarded)).toBe("committed");
          yield* Fiber.join(closing);

          expect(yield* registry.isLive(HOST, REMOTE)).toBe(false);
          const afterClose = yield* registry.require(HOST, REMOTE).pipe(
            Effect.either,
          );
          expect(Either.isLeft(afterClose)).toBe(true);
          if (Either.isLeft(afterClose)) {
            expect(afterClose.left.reason).toBe("unavailable");
          }
          const staleWitness = yield* registry.withSession(
            witness,
            Effect.void,
          ).pipe(Effect.either);
          expect(Either.isLeft(staleWitness)).toBe(true);
          if (Either.isLeft(staleWitness)) {
            expect(staleWitness.left.reason).toBe("invalid-witness");
          }
        }),
      ).pipe(Effect.provide(StationLivePeerRegistryLive)),
    );
  });
});
