import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Effect } from "effect";
import { updateError, type UpdateError } from "./errors";

/**
 * Exact downloaded candidate that alone may authorize install.
 *
 * A structurally similar object never authorizes: only this module mints
 * membership via the sealed WeakSet after hash + staged-app admit.
 */
export type AuthorizedUpdateCandidate = {
  readonly version: string;
  readonly downloadedFile: string;
  readonly zipSha256: string;
  readonly stagedAppPath?: string;
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

export const isMintedCandidate = (
  candidate: AuthorizedUpdateCandidate | undefined,
): candidate is AuthorizedUpdateCandidate =>
  candidate !== undefined && authorizedCandidates.has(candidate);

/**
 * Operator may Restart: minted candidate with a staged admitted app path.
 * Surfaces as UpdateStatus.canInstall in the ready phase.
 */
export const canOperatorInstall = (
  candidate: AuthorizedUpdateCandidate | undefined,
): boolean =>
  isMintedCandidate(candidate) &&
  candidate.stagedAppPath !== undefined &&
  candidate.stagedAppPath.length > 0;

/**
 * Install finalize is permitted only for the exact minted candidate with a
 * staged admitted app path. Schema+data migration runs on normal app open.
 */
export const canAuthorizeInstall = (
  candidate: AuthorizedUpdateCandidate | undefined,
): boolean => canOperatorInstall(candidate);

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
