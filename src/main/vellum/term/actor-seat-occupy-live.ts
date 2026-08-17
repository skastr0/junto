/**
 * Production glue for the actor-seat WHEN.
 *
 * Root layers expose ActorSeatOccupy, never a process HOW. The service reads
 * station configuration for every operation so an Unenrolled process that is
 * configured in place immediately recognizes its durable host id.
 */
import { Effect, Layer, Result, Schema } from "effect";
import { HostId } from "@shared/remote-hosts";
import {
  LogicalSequence,
  StationSha256,
} from "@shared/station-api";
import {
  StationFleetPropagation,
  awaitFleetProjectionApplied,
  type StationFleetPropagationResult,
} from "../station/fleet-propagation";
import { StationFleetTargetRepository } from "../station/fleet-target-repository";
import { decodeStationPortfolioBody } from "../station/portfolio";
import { StationPropagation } from "../station/propagation";
import { StationRepository } from "../station/repository";
import {
  ActorSeatOccupy,
  makeActorSeatOccupy,
  makeRemoteProjectionAdmission,
  type ProjectionAdmissionOutcome,
  type ProjectionAdmissionRef,
} from "./actor-seat-occupy";
import { termPlane } from "./plane";

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const decodeHostId = (hostId: string) => {
  const decoded = Schema.decodeUnknownResult(HostId)(hostId);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const decodeRef = (reference: ProjectionAdmissionRef) => {
  const generation = Schema.decodeUnknownResult(LogicalSequence)(
    reference.generation,
  );
  const contentSha256 = Schema.decodeUnknownResult(StationSha256)(
    reference.contentSha256,
  );
  return Result.isSuccess(generation) && Result.isSuccess(contentSha256)
    ? {
        generation: generation.success,
        contentSha256: contentSha256.success,
      }
    : undefined;
};

/** Truthful non-started copy for one fleet acknowledgement outcome. */
export const projectionAdmissionOutcomeOf = (
  result: StationFleetPropagationResult,
): ProjectionAdmissionOutcome => {
  if (result.ok) {
    return {
      ok: true,
      acked: {
        generation: result.receipt.projection.active.generation,
        contentSha256: result.receipt.projection.active.contentSha256,
      },
    };
  }
  const reason =
    result.error.reason === "deadline" ||
    result.error.reason === "synchronization-failed"
      ? ("not-acknowledged" as const)
      : ("remote-unavailable" as const);
  return {
    ok: false,
    reason,
    message:
      reason === "remote-unavailable"
        ? `Remote host ${result.hostId} is not reachable, so the agent stays stopped until it acknowledges the latest canvas`
        : `Remote host ${result.hostId} has not acknowledged the latest canvas projection, so the agent stays stopped`,
  };
};

export const ActorSeatOccupyLive = Layer.effect(
  ActorSeatOccupy,
  Effect.gen(function* () {
    // Retain the root-owned repository service. Do not snapshot configuration
    // while acquiring the layer: station.configure may happen after boot.
    const station = yield* StationRepository;
    const propagation = yield* StationPropagation;
    const fleetPropagation = yield* StationFleetPropagation;
    const fleetTargets = yield* StationFleetTargetRepository;

    const remoteProjectionAdmission = makeRemoteProjectionAdmission({
      localRole: () =>
        station.configuration.pipe(
          Effect.map((record) => record?.configuration.role),
          Effect.mapError(asError),
        ),
      isFleetTarget: (hostId) => {
        const decoded = decodeHostId(hostId);
        if (decoded === undefined) return Effect.succeed(false);
        return fleetTargets.get(decoded).pipe(
          Effect.map((target) => target !== undefined),
          Effect.mapError(asError),
        );
      },
      compileDesired: (hostId) =>
        propagation.desiredProjectionForHost(hostId).pipe(
          Effect.map((desired) => ({
            generation: desired.generation,
            contentSha256: desired.contentSha256,
          })),
          Effect.mapError(asError),
        ),
      awaitApplied: (hostId, desired) =>
        Effect.suspend(() => {
          const decodedHost = decodeHostId(hostId);
          const decodedRef = decodeRef(desired);
          if (decodedHost === undefined || decodedRef === undefined) {
            return Effect.succeed<ProjectionAdmissionOutcome>({
              ok: false,
              reason: "not-acknowledged",
              message:
                `Remote host ${hostId} has no canonical projection reference to await`,
            });
          }
          return awaitFleetProjectionApplied(
            fleetPropagation,
            decodedHost,
            decodedRef,
          ).pipe(
            Effect.map(projectionAdmissionOutcomeOf),
            Effect.mapError(asError),
          );
        }),
      seatProjected: (acked, hostId, bindingId) =>
        Effect.gen(function* () {
          const decodedRef = decodeRef(acked);
          if (decodedRef === undefined) return false;
          const stored = yield* station
            .projectionByReference(decodedRef)
            .pipe(Effect.mapError(asError));
          if (stored === undefined) return false;
          const decoded = yield* Effect.try({
            try: () => decodeStationPortfolioBody(stored.body),
            catch: asError,
          });
          return decoded.actorSeats.some(
            (seat) =>
              seat.hostId === hostId && seat.bindingId === bindingId,
          );
        }),
    });

    return makeActorSeatOccupy({
      local: termPlane.host,
      localHostId: () =>
        station.configuration.pipe(
          Effect.map((record) => record?.configuration.hostId),
          Effect.mapError(asError),
        ),
      clientForOccupy: async (hostId) => {
        const client = await termPlane.router.clientForOccupy(hostId);
        // Keep routing/control details out of the WHEN. This is the complete
        // Remote process surface needed to inspect or occupy one actor seat.
        return {
          get: (bindingId) => client.get(bindingId),
          createAgentSeat: (input) => client.createAgentSeat(input),
        };
      },
      remoteProjectionAdmission,
    });
  }),
);
