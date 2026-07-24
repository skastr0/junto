/**
 * Command Center: read remote applied.ack and promote staged → applied.
 * Reconvergence: re-push when last ack generation lags desired authority gen.
 */

import type { Context } from "effect";
import { Effect } from "effect";
import {
  projectionRecordFromResult,
  type StationProjectionRecord,
} from "@shared/station-status";
import { compareProjectionGeneration } from "@shared/station-projection";
import { decodeRemoteHomeDirectoryOutput } from "../hosts/remote-home";
import {
  parseSshEndpoint,
  type SshError,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShot } from "../ssh/program";
import { confineProjectionAckPath } from "../ssh/remote-plan";
import { remoteCat } from "../ssh/read-commands";
import { SshTransport } from "../ssh/service";
import {
  recordStationProjection,
  readStationStatus,
} from "../station-status-store";
import {
  ackMatchesStagedFrame,
  parseProjectionAppliedAckText,
  type StationProjectionAppliedAck,
} from "./ack";
import { reduceProjectionDelivery } from "./delivery";

type Ssh = Context.Tag.Service<typeof SshTransport>;

const describeReadError = (error: unknown): string => {
  if (error && typeof error === "object" && "_tag" in error) {
    const tagged = error as SshError;
    switch (tagged._tag) {
      case "SshInputError":
        return tagged.message;
      case "SshTimeoutError":
        return `remote ack read timed out after ${tagged.timeoutMs}ms`;
      case "SshSpawnError":
        return `remote ack read spawn failed: ${tagged.message}`;
      case "SshExitError":
        return `remote ack read exited ${tagged.code}`;
      case "SshSetupError":
      case "SshIoError":
      case "SshForwardError":
        return tagged.message;
      case "SshOutputLimitError":
        return `remote ack read exceeded ${tagged.limitBytes} byte limit`;
      default:
        return "remote ack read failed";
    }
  }
  return error instanceof Error ? error.message : String(error);
};

const isUnreachableError = (error: unknown): boolean => {
  if (!error || typeof error !== "object" || !("_tag" in error)) return false;
  const tag = (error as { _tag: string })._tag;
  return (
    tag === "SshTimeoutError" ||
    tag === "SshSpawnError" ||
    tag === "SshSetupError" ||
    tag === "SshIoError"
  );
};

export type ReadRemoteProjectionAckResult =
  | {
      readonly ok: true;
      readonly ack: StationProjectionAppliedAck;
      readonly path: string;
    }
  | {
      readonly ok: false;
      readonly status: "absent" | "invalid" | "unreachable" | "rejected";
      readonly detail: string;
    };

/**
 * Typed SSH read of remote `~/.vellum/projections/applied.ack` via remoteCat.
 * Never hand-authors shell.
 */
export const readRemoteProjectionAck = (
  ssh: Ssh,
  endpointRaw: string,
): Effect.Effect<ReadRemoteProjectionAckResult, never> =>
  Effect.gen(function* () {
    const parsedEither = yield* Effect.either(parseSshEndpoint(endpointRaw));
    if (parsedEither._tag === "Left") {
      return {
        ok: false as const,
        status: "rejected" as const,
        detail: parsedEither.left.message,
      };
    }
    const endpoint = parsedEither.right;
    const warmEither = yield* Effect.either(ssh.warm(endpoint));
    if (warmEither._tag === "Left") {
      return {
        ok: false as const,
        status: isUnreachableError(warmEither.left)
          ? ("unreachable" as const)
          : ("rejected" as const),
        detail: describeReadError(warmEither.left),
      };
    }

    const homeEither = yield* Effect.either(
      ssh.run(homeDirectoryLookup(endpoint)),
    );
    if (homeEither._tag === "Left") {
      return {
        ok: false as const,
        status: isUnreachableError(homeEither.left)
          ? ("unreachable" as const)
          : ("rejected" as const),
        detail: describeReadError(homeEither.left),
      };
    }
    const remoteHome = decodeRemoteHomeDirectoryOutput(homeEither.right.stdout);
    if (remoteHome === null) {
      return {
        ok: false as const,
        status: "rejected" as const,
        detail:
          "remote home response must be exactly one canonical absolute path followed by LF",
      };
    }

    const pathEither = yield* Effect.either(
      confineProjectionAckPath(remoteHome),
    );
    if (pathEither._tag === "Left") {
      return {
        ok: false as const,
        status: "rejected" as const,
        detail: pathEither.left.message,
      };
    }
    const ackPath = pathEither.right;

    const catEither = yield* Effect.either(remoteCat(ackPath));
    if (catEither._tag === "Left") {
      return {
        ok: false as const,
        status: "rejected" as const,
        detail: catEither.left.message,
      };
    }

    const runEither = yield* Effect.either(
      ssh.run(oneShot(endpoint, catEither.right, { budget: "status" })),
    );
    if (runEither._tag === "Left") {
      const err = runEither.left;
      if (
        err &&
        typeof err === "object" &&
        "_tag" in err &&
        (err as SshError)._tag === "SshExitError" &&
        (err as { code?: number | null }).code === 1
      ) {
        // cat missing file typically exits 1
        return {
          ok: false as const,
          status: "absent" as const,
          detail: "remote applied.ack absent",
        };
      }
      return {
        ok: false as const,
        status: isUnreachableError(err)
          ? ("unreachable" as const)
          : ("rejected" as const),
        detail: describeReadError(err),
      };
    }

    const text = runEither.right.stdout;
    if (!text || text.trim().length === 0) {
      return {
        ok: false as const,
        status: "absent" as const,
        detail: "remote applied.ack empty",
      };
    }
    const ack = parseProjectionAppliedAckText(text);
    if (!ack) {
      return {
        ok: false as const,
        status: "invalid" as const,
        detail: "remote applied.ack failed shape validation",
      };
    }
    return { ok: true as const, ack, path: ackPath };
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        ok: false as const,
        status: "rejected" as const,
        detail: describeReadError(error).slice(0, 4_096),
      }),
    ),
  );

export type PromoteHostFromAckInput = {
  readonly hostId: string;
  readonly endpoint: string;
  readonly staged: StationProjectionRecord;
  readonly now?: () => string;
  readonly record?: (row: StationProjectionRecord) => Promise<void>;
};

export type PromoteHostFromAckResult =
  | {
      readonly status: "applied";
      readonly record: StationProjectionRecord;
      readonly ack: StationProjectionAppliedAck;
    }
  | {
      readonly status: "unchanged";
      readonly reason:
        | "not-staged"
        | "ack-absent"
        | "ack-mismatch"
        | "ack-invalid"
        | "unreachable"
        | "rejected";
      readonly detail: string;
    };

/**
 * Pure decision: given a staged receipt and an ack, promote or leave.
 */
export const decideAckPromotion = (
  staged: StationProjectionRecord,
  ack: StationProjectionAppliedAck,
):
  | { readonly promote: true; readonly detail: string }
  | { readonly promote: false; readonly reason: "ack-mismatch"; readonly detail: string } => {
  if (
    ackMatchesStagedFrame(ack, {
      generation: staged.generation,
      frameSha256: staged.frameSha256,
      manifestSha256: staged.manifestSha256,
    })
  ) {
    return {
      promote: true,
      detail: `remote ack confirms generation ${ack.generation} applied at ${ack.appliedAt}`,
    };
  }
  return {
    promote: false,
    reason: "ack-mismatch",
    detail: `remote ack gen ${ack.generation} does not match staged gen ${staged.generation}`,
  };
};

/**
 * Read remote applied.ack; when it matches the staged receipt, mark applied.
 * Unreachable / absent / mismatch leave staged honestly.
 */
export const promoteHostDeliveryFromAck = (
  ssh: Ssh,
  input: PromoteHostFromAckInput,
): Effect.Effect<PromoteHostFromAckResult, never> =>
  Effect.gen(function* () {
    if (input.staged.status !== "staged") {
      return {
        status: "unchanged" as const,
        reason: "not-staged" as const,
        detail: `delivery status is ${input.staged.status}, not staged`,
      };
    }

    const read = yield* readRemoteProjectionAck(ssh, input.endpoint);
    if (!read.ok) {
      const reason =
        read.status === "absent"
          ? ("ack-absent" as const)
          : read.status === "invalid"
            ? ("ack-invalid" as const)
            : read.status === "unreachable"
              ? ("unreachable" as const)
              : ("rejected" as const);
      return {
        status: "unchanged" as const,
        reason,
        detail: read.detail,
      };
    }

    const decision = decideAckPromotion(input.staged, read.ack);
    if (!decision.promote) {
      return {
        status: "unchanged" as const,
        reason: decision.reason,
        detail: decision.detail,
      };
    }

    const reduced = reduceProjectionDelivery("staged", {
      type: "applied",
      detail: decision.detail,
    });
    const now = input.now ?? (() => new Date().toISOString());
    const record = projectionRecordFromResult({
      hostId: input.hostId,
      endpoint: input.endpoint,
      generation: input.staged.generation,
      manifestSha256: input.staged.manifestSha256,
      frameSha256: input.staged.frameSha256,
      status: reduced.ok ? reduced.status : "applied",
      detail: reduced.ok ? reduced.detail : decision.detail,
      at: now(),
    });
    const recordFn = input.record ?? recordStationProjection;
    yield* Effect.promise(() => recordFn(record));
    return {
      status: "applied" as const,
      record,
      ack: read.ack,
    };
  });

/**
 * Promote every staged host delivery that has a matching remote ack.
 */
export const reconcileStagedProjectionAcks = (
  ssh: Ssh,
  deps: {
    readonly now?: () => string;
    readonly record?: (row: StationProjectionRecord) => Promise<void>;
  } = {},
): Effect.Effect<
  ReadonlyArray<{
    readonly hostId: string;
    readonly result: PromoteHostFromAckResult;
  }>,
  never
> =>
  Effect.gen(function* () {
    const status = yield* Effect.promise(() => readStationStatus());
    const projections = status.projections ?? {};
    const outcomes: Array<{
      hostId: string;
      result: PromoteHostFromAckResult;
    }> = [];

    for (const [hostId, row] of Object.entries(projections)) {
      if (row.status !== "staged") continue;
      const endpoint = row.endpoint?.trim() ?? "";
      if (!endpoint) {
        outcomes.push({
          hostId,
          result: {
            status: "unchanged",
            reason: "rejected",
            detail: "staged projection missing endpoint",
          },
        });
        continue;
      }
      const result = yield* promoteHostDeliveryFromAck(ssh, {
        hostId,
        endpoint,
        staged: row,
        now: deps.now,
        record: deps.record,
      });
      outcomes.push({ hostId, result });
    }
    return outcomes;
  });

/**
 * Whether CC should re-push to a host: desired generation is ahead of the
 * last confirmed ack (or staged/applied receipt) generation.
 */
export const needsProjectionRepush = (
  desiredGeneration: string,
  last: {
    readonly generation: string;
    readonly status: StationProjectionRecord["status"];
  } | null
  | undefined,
  remoteAckGeneration?: string,
): boolean => {
  // Prefer remote ack gen when known; else local receipt.
  const confirmed =
    remoteAckGeneration !== undefined
      ? remoteAckGeneration
      : last && (last.status === "applied" || last.status === "staged")
        ? last.generation
        : undefined;
  if (confirmed === undefined) return true;
  return compareProjectionGeneration(desiredGeneration, confirmed) > 0;
};

