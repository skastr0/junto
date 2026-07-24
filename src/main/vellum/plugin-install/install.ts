/**
 * Orchestration: packager dryRun compile → apply DesiredFile[] local or remote.
 */

import { Effect, Schema } from "effect";
import type { SshEndpoint } from "../ssh/domain";
import type { SshTransport } from "../ssh/service";
import {
  applyDesiredFilesLocal,
  type LocalApplyErrorUnion,
} from "./apply-local";
import {
  applyDesiredFilesRemote,
  type RemoteApplyErrorUnion,
} from "./apply-remote";
import type { ApplyOperation, ApplyReceipt, DesiredFile } from "./desired";
import { compilePluginPackage } from "./package";
import { PathSafetyError, rehomeDesiredFiles } from "./paths";
import type {
  HarnessId,
  HarnessScope,
  PackageResult,
  PackageWriteOperation,
} from "./types";

export class InstallError extends Schema.TaggedError<InstallError>()("InstallError", {
  kind: Schema.Literal("compile", "apply", "validation", "path", "ssh"),
  message: Schema.String,
  target: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
}) {}

export type InstallReceipt = {
  readonly target: HarnessId;
  readonly packageId: string;
  readonly packageRoot: string;
  readonly planRoot: string;
  /** Apply-layer ops (write/skip). */
  readonly operations: ReadonlyArray<ApplyOperation>;
  readonly applied: number;
  readonly skipped: number;
  /** Packager planned package-root ops (write/skip/prune/drift) from dryRun. */
  readonly packageOperations: ReadonlyArray<PackageWriteOperation>;
};

export type InstallVellumPluginOptions = {
  readonly pluginPath: string;
  readonly target: HarnessId;
  readonly mode: "local" | "remote";
  /** Required when mode is remote. */
  readonly endpoint?: SshEndpoint;
  readonly scope?: HarnessScope;
  /** Packager package output root override. */
  readonly out?: string;
  readonly projectPath?: string;
  /**
   * Optional confinement root for apply.
   * Local: filesystem root. Remote: absolute path on the remote host.
   */
  readonly applyRoot?: string;
};

const mapApplyError = (
  error: LocalApplyErrorUnion | RemoteApplyErrorUnion,
  target: HarnessId,
): InstallError => {
  if (error instanceof PathSafetyError) {
    return new InstallError({
      kind: "path",
      message: error.message,
      target,
      path: error.path,
    });
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: string })._tag);
    if (tag.startsWith("Ssh") || tag === "SshTransferExitError") {
      const message =
        "message" in error && typeof (error as { message: unknown }).message === "string"
          ? (error as { message: string }).message
          : tag;
      return new InstallError({
        kind: "ssh",
        message,
        target,
        ...("path" in error && typeof (error as { path: unknown }).path === "string"
          ? { path: (error as { path: string }).path }
          : {}),
      });
    }
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error);
  const path =
    typeof error === "object" &&
    error !== null &&
    "path" in error &&
    typeof (error as { path: unknown }).path === "string"
      ? (error as { path: string }).path
      : undefined;
  return new InstallError({
    kind: "apply",
    message,
    target,
    ...(path !== undefined ? { path } : {}),
  });
};

const toReceipt = (
  packaged: PackageResult,
  apply: ApplyReceipt,
): InstallReceipt => ({
  target: packaged.target,
  packageId: packaged.packageId,
  packageRoot: packaged.packageRoot,
  planRoot: packaged.planRoot,
  operations: apply.operations,
  applied: apply.applied,
  skipped: apply.skipped,
  packageOperations: packaged.operations,
});

/**
 * Files to materialize from a package dryRun result.
 * Prefer `compileFiles` (harness-shaped whole files from lowerers).
 * When `applyRoot` is set, re-home absolute plan/package paths under it.
 */
export const desiredFilesFromPackage = (
  result: {
    readonly compileFiles: ReadonlyArray<DesiredFile>;
    readonly packageRoot: string;
    readonly planRoot: string;
  },
  applyRoot?: string,
): ReadonlyArray<DesiredFile> => {
  const files = result.compileFiles;
  if (applyRoot === undefined || applyRoot.trim().length === 0) return files;
  return rehomeDesiredFiles(
    files,
    [result.planRoot, result.packageRoot],
    applyRoot,
  );
};

const compileForInstall = (
  opts: InstallVellumPluginOptions,
): Effect.Effect<PackageResult, InstallError> =>
  compilePluginPackage({
    pluginPath: opts.pluginPath,
    target: opts.target,
    scope: opts.scope,
    out: opts.out,
    projectPath: opts.projectPath,
  }).pipe(
    Effect.mapError(
      (error): InstallError =>
        new InstallError({
          kind: "compile",
          message: error.message,
          target: opts.target,
        }),
    ),
  );

/**
 * Compile a plugin (packager dryRun) and apply DesiredFile[] locally or over SSH.
 *
 * Harness targets: any `HarnessId` from the packager (v1 exercised for
 * `claude-code` and `codex-cli`).
 *
 * Local mode has no service requirements. Remote mode requires `SshTransport`.
 */
export function installVellumPlugin(
  opts: InstallVellumPluginOptions & { readonly mode: "local" },
): Effect.Effect<InstallReceipt, InstallError>;
export function installVellumPlugin(
  opts: InstallVellumPluginOptions & {
    readonly mode: "remote";
    readonly endpoint: SshEndpoint;
  },
): Effect.Effect<InstallReceipt, InstallError, SshTransport>;
export function installVellumPlugin(
  opts: InstallVellumPluginOptions,
): Effect.Effect<InstallReceipt, InstallError, SshTransport> {
  if (opts.mode === "remote") {
    if (opts.endpoint === undefined) {
      return Effect.fail(
        new InstallError({
          kind: "validation",
          message: "remote install requires endpoint",
          target: opts.target,
        }),
      );
    }
    if (opts.applyRoot === undefined || opts.applyRoot.trim().length === 0) {
      return Effect.fail(
        new InstallError({
          kind: "validation",
          message:
            "remote install requires applyRoot (harness home confinement — refuse free absolute writes)",
          target: opts.target,
        }),
      );
    }
    const endpoint = opts.endpoint;
    const applyRoot = opts.applyRoot.trim();
    return compileForInstall(opts).pipe(
      Effect.flatMap((packaged) =>
        applyDesiredFilesRemote({
          endpoint,
          files: desiredFilesFromPackage(packaged, applyRoot),
          root: applyRoot,
        }).pipe(
          Effect.mapError((error) => mapApplyError(error, opts.target)),
          Effect.map((apply) => toReceipt(packaged, apply)),
        ),
      ),
    );
  }

  return compileForInstall(opts).pipe(
    Effect.flatMap((packaged) =>
      applyDesiredFilesLocal({
        files: desiredFilesFromPackage(packaged, opts.applyRoot),
        ...(opts.applyRoot !== undefined ? { root: opts.applyRoot } : {}),
      }).pipe(
        Effect.mapError((error) => mapApplyError(error, opts.target)),
        Effect.map((apply) => toReceipt(packaged, apply)),
      ),
    ),
  ) as Effect.Effect<InstallReceipt, InstallError, SshTransport>;
}
