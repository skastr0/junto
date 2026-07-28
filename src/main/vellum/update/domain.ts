import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Effect } from "effect";
import type { StateUpdatePreflightReceipt } from "../state/candidate-readiness";
import { updateError, type UpdateError } from "./errors";

/**
 * Exact downloaded candidate that alone may authorize install.
 *
 * A structurally similar object never authorizes: only this module mints
 * membership via the sealed WeakSet after hash + (later) preflight bind.
 */
export type AuthorizedUpdateCandidate = {
  readonly version: string;
  readonly downloadedFile: string;
  readonly zipSha256: string;
  readonly stagedAppPath?: string;
  readonly preflightReceipt?: StateUpdatePreflightReceipt;
  readonly authorizedAt: string;
};

const authorizedCandidates = new WeakSet<object>();

export const mintAuthorizedCandidate = (
  input: {
    readonly version: string;
    readonly downloadedFile: string;
    readonly zipSha256: string;
    readonly stagedAppPath?: string;
  },
): AuthorizedUpdateCandidate => {
  const candidate: AuthorizedUpdateCandidate = {
    version: input.version,
    downloadedFile: input.downloadedFile,
    zipSha256: input.zipSha256,
    ...(input.stagedAppPath === undefined
      ? {}
      : { stagedAppPath: input.stagedAppPath }),
    authorizedAt: new Date().toISOString(),
  };
  authorizedCandidates.add(candidate);
  return candidate;
};

export const bindPreflightReceipt = (
  candidate: AuthorizedUpdateCandidate,
  receipt: StateUpdatePreflightReceipt,
  zipSha256: string,
): AuthorizedUpdateCandidate => {
  if (!authorizedCandidates.has(candidate)) {
    throw updateError(
      "candidate-mismatch",
      "preflight bind requires a minted update candidate",
    );
  }
  if (candidate.zipSha256 !== zipSha256) {
    throw updateError(
      "candidate-mismatch",
      "preflight receipt zip digest does not match the downloaded candidate",
    );
  }
  const bound: AuthorizedUpdateCandidate = {
    ...candidate,
    preflightReceipt: receipt,
    authorizedAt: new Date().toISOString(),
  };
  authorizedCandidates.add(bound);
  return bound;
};

export const isMintedCandidate = (
  candidate: AuthorizedUpdateCandidate | undefined,
): candidate is AuthorizedUpdateCandidate =>
  candidate !== undefined && authorizedCandidates.has(candidate);

/**
 * Install is permitted only for the exact minted candidate that has a
 * bound preflight receipt for the same ZIP digest.
 */
export const canAuthorizeInstall = (
  candidate: AuthorizedUpdateCandidate | undefined,
): boolean =>
  isMintedCandidate(candidate) &&
  candidate.preflightReceipt !== undefined &&
  candidate.preflightReceipt.ready === true;

export const hashFileSha256 = (
  path: string,
): Effect.Effect<string, UpdateError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(path);
        stream.on("data", (chunk) => {
          hash.update(chunk);
        });
        stream.on("error", reject);
        stream.on("end", () => {
          resolve(hash.digest("hex"));
        });
      }),
    catch: (cause) =>
      updateError(
        "readiness-failed",
        cause instanceof Error
          ? `failed to hash update ZIP: ${cause.message}`
          : "failed to hash update ZIP",
        cause,
      ),
  });

/**
 * Remote auto-rollout may only target the Command Center's currently
 * running version. Fleet walk is partial; this helper is the invariant.
 */
export const remoteRolloutTargetVersion = (
  commandCenterVersion: string,
): string => commandCenterVersion;

export const admitsRemoteAutoRollout = (input: {
  readonly commandCenterVersion: string;
  readonly targetVersion: string;
}): boolean =>
  input.targetVersion.length > 0 &&
  input.targetVersion === input.commandCenterVersion;
