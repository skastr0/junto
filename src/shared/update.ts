import { Schema } from "effect";

/**
 * Command Center auto-update surface.
 *
 * Platform providers check and download the fixed release feeds. macOS admits
 * Developer ID bundles; Linux admits signed desktop archives into immutable
 * owner-local generations. The coordinator authorizes exact staged bytes.
 * Schema+data migration runs on normal app open after cutover. Installation is
 * explicit "Restart to update" only — never auto on quit.
 */

export const UpdatePhase = Schema.Literals(["idle", "checking",
"available",
"downloading",
"ready",
"installing",
"error",]);
export type UpdatePhase = typeof UpdatePhase.Type;

export const UpdateDownloadProgress = Schema.Struct({
  percent: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  bytesPerSecond: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  transferred: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  total: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type UpdateDownloadProgress = typeof UpdateDownloadProgress.Type;

export const AvailableRelease = Schema.Struct({
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64))),
  releaseDate: Schema.optionalKey(Schema.String),
  releaseName: Schema.optionalKey(Schema.String),
  releaseNotes: Schema.optionalKey(Schema.String),
});
export type AvailableRelease = typeof AvailableRelease.Type;

export const UpdateErrorCode = Schema.Literals(["not-packaged", "platform-unsupported",
"check-failed",
"download-failed",
"readiness-failed",
"install-refused",
"not-ready",
"candidate-mismatch",
"unknown",]);
export type UpdateErrorCode = typeof UpdateErrorCode.Type;

export const UpdateErrorInfo = Schema.Struct({
  code: UpdateErrorCode,
  message: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(500))),
});
export type UpdateErrorInfo = typeof UpdateErrorInfo.Type;

/**
 * Operator-visible install identity for Settings. No private digests,
 * signing blobs, or host filesystem paths — only facts useful for support
 * and release evidence (version, channel surface, packaged vs dev).
 */
export const UpdateInstallProvenance = Schema.Struct({
  packaged: Schema.Boolean,
  platform: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(32))),
  arch: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(32))),
  electronVersion: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64))),
  providerKind: Schema.Literals(["mac", "linux", "unsupported"]),
  feedUrl: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(512)))),
});
export type UpdateInstallProvenance = typeof UpdateInstallProvenance.Type;

/**
 * Renderer-facing update state. No filesystem paths, digests, or receipts
 * cross this boundary — those stay main-owned readiness authority.
 */
export const UpdateStatus = Schema.Struct({
  phase: UpdatePhase,
  currentVersion: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64))),
  available: Schema.optionalKey(AvailableRelease),
  progress: Schema.optionalKey(UpdateDownloadProgress),
  error: Schema.optionalKey(UpdateErrorInfo),
  /**
   * Operator may Restart: minted candidate with admitted staged app path.
   * True in phase `ready` once expand+admit succeeded. Final quitAndInstall
   * requires the same main-side canAuthorizeInstall gate.
   */
  canInstall: Schema.Boolean,
  lastCheckedAt: Schema.optionalKey(Schema.String),
  install: Schema.optionalKey(UpdateInstallProvenance),
});
export type UpdateStatus = typeof UpdateStatus.Type;

export const decodeUpdateStatus = Schema.decodeUnknownSync(UpdateStatus);

export const idleUpdateStatus = (
  currentVersion: string,
  install?: UpdateInstallProvenance,
): UpdateStatus => ({
  phase: "idle",
  currentVersion,
  canInstall: false,
  ...(install === undefined ? {} : { install }),
});

export interface UpdateApi {
  readonly updateGetState: () => Promise<UpdateStatus>;
  readonly updateCheck: () => Promise<UpdateStatus>;
  readonly updateRestartAndInstall: () => Promise<UpdateStatus>;
  readonly onUpdateStateChanged: (
    listener: (status: UpdateStatus) => void,
  ) => () => void;
}
