import { Schema } from "effect";

/**
 * Command Center auto-update surface.
 *
 * electron-updater owns feed check / download / cache / quitAndInstall.
 * Vellum Command owns the readiness gate only: hash the exact ZIP, expand to a
 * proof-only staging dir, admit the staged app, then permit install.
 * Schema+data migration runs on normal app open after cutover. Installation is
 * explicit "Restart to update" only — never auto on quit.
 */

export const UpdatePhase = Schema.Literal(
  "idle",
  "checking",
  "available",
  "downloading",
  "ready",
  "installing",
  "error",
);
export type UpdatePhase = typeof UpdatePhase.Type;

export const UpdateDownloadProgress = Schema.Struct({
  percent: Schema.Number.pipe(Schema.between(0, 100)),
  bytesPerSecond: Schema.Number.pipe(Schema.nonNegative()),
  transferred: Schema.Number.pipe(Schema.nonNegative()),
  total: Schema.Number.pipe(Schema.nonNegative()),
});
export type UpdateDownloadProgress = typeof UpdateDownloadProgress.Type;

export const AvailableRelease = Schema.Struct({
  version: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  releaseDate: Schema.optionalWith(Schema.String, { exact: true }),
  releaseName: Schema.optionalWith(Schema.String, { exact: true }),
  releaseNotes: Schema.optionalWith(Schema.String, { exact: true }),
});
export type AvailableRelease = typeof AvailableRelease.Type;

export const UpdateErrorCode = Schema.Literal(
  "not-packaged",
  "platform-unsupported",
  "check-failed",
  "download-failed",
  "readiness-failed",
  "install-refused",
  "not-ready",
  "candidate-mismatch",
  "unknown",
);
export type UpdateErrorCode = typeof UpdateErrorCode.Type;

export const UpdateErrorInfo = Schema.Struct({
  code: UpdateErrorCode,
  message: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)),
});
export type UpdateErrorInfo = typeof UpdateErrorInfo.Type;

/**
 * Operator-visible install identity for Settings. No private digests,
 * signing blobs, or host filesystem paths — only facts useful for support
 * and release evidence (version, channel surface, packaged vs dev).
 */
export const UpdateInstallProvenance = Schema.Struct({
  packaged: Schema.Boolean,
  platform: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32)),
  arch: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32)),
  electronVersion: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  providerKind: Schema.Literal("mac", "linux", "unsupported"),
  feedUrl: Schema.optionalWith(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
    { exact: true },
  ),
});
export type UpdateInstallProvenance = typeof UpdateInstallProvenance.Type;

/**
 * Renderer-facing update state. No filesystem paths, digests, or receipts
 * cross this boundary — those stay main-owned readiness authority.
 */
export const UpdateStatus = Schema.Struct({
  phase: UpdatePhase,
  currentVersion: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  available: Schema.optionalWith(AvailableRelease, { exact: true }),
  progress: Schema.optionalWith(UpdateDownloadProgress, { exact: true }),
  error: Schema.optionalWith(UpdateErrorInfo, { exact: true }),
  /**
   * Operator may Restart: minted candidate with admitted staged app path.
   * True in phase `ready` once expand+admit succeeded. Final quitAndInstall
   * requires the same main-side canAuthorizeInstall gate.
   */
  canInstall: Schema.Boolean,
  lastCheckedAt: Schema.optionalWith(Schema.String, { exact: true }),
  install: Schema.optionalWith(UpdateInstallProvenance, { exact: true }),
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
