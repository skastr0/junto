/**
 * Apply DesiredFile[] over SshTransport.
 *
 * Fixed-shape remote write plan (mkdir -p + atomic stdin write + chmod).
 * Paths admitted as clean absolute POSIX; `~` expanded against remote home.
 * Idempotent: skip when remote content hash matches desired.
 */

import type { Context } from "effect";
import { Effect, Schema } from "effect";
import {
  makeRemoteCommand,
  makeRemoteStdin,
  type RemoteCommand,
  type SshEndpoint,
  type SshError,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShot, oneShotWithStdin } from "../ssh/program";
import { remoteCat } from "../ssh/read-commands";
import { SshTransport, SshTransferExitError } from "../ssh/service";
import { decodeRemoteHomeDirectoryOutput } from "../hosts/remote-home";
import type { ApplyOperation, ApplyReceipt, DesiredFile } from "./desired";
import {
  admitDesiredTargetPath,
  admitRemoteAbsPath,
  contentHash,
  PathSafetyError,
  shellSingleQuote,
} from "./paths";

export class RemoteApplyError extends Schema.TaggedError<RemoteApplyError>()("RemoteApplyError", {
  path: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

export type RemoteApplyErrorUnion =
  | RemoteApplyError
  | PathSafetyError
  | SshError
  | SshTransferExitError;

type Ssh = Context.Tag.Service<typeof SshTransport>;

const DEFAULT_FILE_MODE = 0o644;

/**
 * Compile a fixed remote write plan for one admitted absolute path.
 * Sole shell emitter for plugin-install remote apply.
 */
export const compilePluginDesiredFileWrite = (
  absolutePath: string,
  mode: number,
): Effect.Effect<RemoteCommand, PathSafetyError | SshError> =>
  Effect.gen(function* () {
    const path = yield* admitRemoteAbsPath(absolutePath);
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
    if (parent.length === 0 || parent === path) {
      return yield* Effect.fail(
        new PathSafetyError({
          path,
          message: "refusing write without a parent directory",
        }),
      );
    }
    yield* admitRemoteAbsPath(parent);

    const modeOctal = (mode & 0o7777).toString(8).padStart(3, "0");
    const qPath = shellSingleQuote(path);
    const qParent = shellSingleQuote(parent);
    const qTmpBase = shellSingleQuote(`${path}.vellum-plugin`);
    const source = [
      "set -eu",
      "umask 022",
      `if [ -L ${qParent} ]; then printf '%s\\n' 'vellum-plugin-install: parent is a symlink' >&2; exit 73; fi`,
      `/bin/mkdir -p -- ${qParent}`,
      `if [ -L ${qParent} ] || [ ! -d ${qParent} ]; then printf '%s\\n' 'vellum-plugin-install: parent unsafe' >&2; exit 73; fi`,
      `if [ -L ${qPath} ]; then printf '%s\\n' 'vellum-plugin-install: target is a symlink' >&2; exit 73; fi`,
      `if [ -e ${qPath} ] && [ ! -f ${qPath} ]; then printf '%s\\n' 'vellum-plugin-install: target not a regular file' >&2; exit 73; fi`,
      `tmp=${qTmpBase}.$$`,
      `if [ -e "$tmp" ] || [ -L "$tmp" ]; then printf '%s\\n' 'vellum-plugin-install: temp path busy' >&2; exit 73; fi`,
      "set -C",
      `cat > "$tmp" || { set +C; /bin/rm -f -- "$tmp"; exit 73; }`,
      "set +C",
      `/bin/chmod ${modeOctal} -- "$tmp" || { /bin/rm -f -- "$tmp"; exit 73; }`,
      `/bin/mv -f -- "$tmp" ${qPath} || { /bin/rm -f -- "$tmp"; exit 73; }`,
      `/bin/chmod ${modeOctal} -- ${qPath}`,
      "",
    ].join("\n");

    return yield* makeRemoteCommand("/bin/sh", [
      "-c",
      source,
      "vellum-plugin-install:desired-file-write",
    ]);
  });

const resolveRemoteHome = (
  ssh: Ssh,
  endpoint: SshEndpoint,
): Effect.Effect<string, RemoteApplyError | SshError> =>
  ssh.run(homeDirectoryLookup(endpoint)).pipe(
    Effect.flatMap((result) => {
      const home = decodeRemoteHomeDirectoryOutput(
        result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`,
      );
      if (!home) {
        return Effect.fail(
          new RemoteApplyError({
            message: "remote home directory lookup returned an unsafe path",
          }),
        );
      }
      return Effect.succeed(home);
    }),
  );

const readRemoteIfPresent = (
  ssh: Ssh,
  endpoint: SshEndpoint,
  path: string,
): Effect.Effect<string | null, never> =>
  remoteCat(path).pipe(
    Effect.flatMap((command) => ssh.run(oneShot(endpoint, command, { budget: "status" }))),
    Effect.map((result) => result.stdout),
    Effect.catchAll(() => Effect.succeed(null as string | null)),
  );

const applyOne = (
  ssh: Ssh,
  endpoint: SshEndpoint,
  remoteHome: string,
  file: DesiredFile,
  root: string | undefined,
): Effect.Effect<ApplyOperation, RemoteApplyErrorUnion> =>
  Effect.gen(function* () {
    const expanded = yield* admitDesiredTargetPath(file.targetPath, {
      root,
      home: remoteHome,
    });
    // After local-style admission, re-admit as remote-safe POSIX absolute.
    const path = yield* admitRemoteAbsPath(expanded);
    const desiredHash = contentHash(file.content);
    const onDisk = yield* readRemoteIfPresent(ssh, endpoint, path);

    if (onDisk !== null && contentHash(onDisk) === desiredHash) {
      return { type: "skip" as const, path, reason: "unchanged" };
    }

    const mode = file.mode ?? DEFAULT_FILE_MODE;
    const command = yield* compilePluginDesiredFileWrite(path, mode);
    const input = yield* makeRemoteStdin(file.content);
    yield* ssh.run(
      oneShotWithStdin(endpoint, command, input, { budget: "bulk" }),
    );

    return {
      type: "write" as const,
      path,
      reason: onDisk === null ? "created" : "updated",
    };
  });

export type ApplyRemoteOptions = {
  readonly endpoint: SshEndpoint;
  readonly files: ReadonlyArray<DesiredFile>;
  /** Optional confinement root on the remote (absolute, after ~ expand). */
  readonly root?: string;
};

export const applyDesiredFilesRemote = (
  options: ApplyRemoteOptions,
): Effect.Effect<ApplyReceipt, RemoteApplyErrorUnion, SshTransport> =>
  Effect.gen(function* () {
    const ssh = yield* SshTransport;
    const remoteHome = yield* resolveRemoteHome(ssh, options.endpoint);
    const root =
      options.root !== undefined
        ? yield* admitDesiredTargetPath(options.root, { home: remoteHome })
        : undefined;

    const operations: ApplyOperation[] = [];
    let applied = 0;
    let skipped = 0;

    for (const file of options.files) {
      const op = yield* applyOne(ssh, options.endpoint, remoteHome, file, root);
      operations.push(op);
      if (op.type === "write") applied += 1;
      else skipped += 1;
    }

    return { operations, applied, skipped } satisfies ApplyReceipt;
  });
