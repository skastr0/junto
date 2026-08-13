import { join } from "node:path";
import { Effect, Stream } from "effect";
import type { Context } from "effect";
import type {
  HostOpsCleanup,
  HostOpsCopy,
  HostOpsInspect,
  HostOpsPresence,
} from "@shared/host-ops";
import { TERM_REMOTE_SOCK_REL } from "@shared/term-control";
import { inspectSshTarget, SshExitError, type SshTarget } from "../ssh/domain";
import { deploymentStream, homeDirectoryLookup, oneShot } from "../ssh/program";
import {
  remoteDarwinDeployLockExists,
  remoteDarwinIncomingExists,
  remoteDarwinLaunchAgentIncomingRemove,
  remoteDarwinPackageExists,
  remoteTestSocketExists,
} from "../ssh/read-commands";
import { SshTransferExitError, SshTransport } from "../ssh/service";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";
import { appProcessPlane } from "../app-process-plane";
import {
  admitLocalAppBundle,
  awaitTarCloseBounded,
  buildRemoteDeployScript,
  captureTarStderr,
  parseDeployTransferResult,
  resolveLocalAppBundle,
  watchTarExit,
} from "./deploy-darwin";
import { compileDarwinRemoteDeployScript } from "../ssh/remote-plan";

const COPY_TIMEOUT_MS = 20 * 60 * 1000;

const lastScriptTag = (text: string): string | undefined => {
  const tags = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]{3,}/u.test(line));
  return tags.length === 0 ? undefined : tags[tags.length - 1];
};

const presenceFromTest = (
  result:
    | { readonly _tag: "Success" }
    | { readonly _tag: "Failure"; readonly failure: unknown },
): HostOpsPresence => {
  if (result._tag === "Success") return "present";
  if (
    result._tag === "Failure" &&
    result.failure instanceof SshExitError &&
    result.failure.code === 1
  ) {
    return "absent";
  }
  return "unknown";
};

export const inspectDarwinHost = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
): Effect.Effect<HostOpsInspect> =>
  Effect.gen(function* () {
    const observedAt = new Date().toISOString();
    const endpoint = inspectSshTarget(target).endpoint;
    const warm = yield* ssh.warm(target).pipe(Effect.result);
    if (warm._tag === "Failure") {
      return {
        endpoint,
        platform: "darwin" as const,
        network: "down" as const,
        package: "unknown" as const,
        deployLock: "unknown" as const,
        incoming: "unknown" as const,
        termSocket: "unknown" as const,
        observedAt,
      };
    }

    const homeResult = yield* ssh.run(homeDirectoryLookup(target)).pipe(Effect.result);
    const home =
      homeResult._tag === "Success"
        ? decodeRemoteHomeDirectoryOutput(homeResult.success.stdout)
        : null;

    const pkgCmd = yield* remoteDarwinPackageExists();
    const lockCmd = yield* remoteDarwinDeployLockExists();
    const incomingCmd = yield* remoteDarwinIncomingExists();
    const pkg = yield* ssh
      .run(oneShot(target, pkgCmd, { budget: "short" }))
      .pipe(Effect.result);
    const lock = yield* ssh
      .run(oneShot(target, lockCmd, { budget: "short" }))
      .pipe(Effect.result);
    const incoming = yield* ssh
      .run(oneShot(target, incomingCmd, { budget: "short" }))
      .pipe(Effect.result);

    let termSocket: HostOpsPresence = "unknown";
    if (home !== null) {
      const sockCmd = yield* remoteTestSocketExists(
        join(home, TERM_REMOTE_SOCK_REL),
      );
      const sock = yield* ssh
        .run(oneShot(target, sockCmd, { budget: "short" }))
        .pipe(Effect.result);
      termSocket = presenceFromTest(sock);
    }

    return {
      endpoint,
      platform: "darwin" as const,
      network: "up" as const,
      ...(home === null ? {} : { home }),
      package: presenceFromTest(pkg),
      deployLock: presenceFromTest(lock),
      incoming: presenceFromTest(incoming),
      termSocket,
      observedAt,
    };
  });

export const copyDarwinHost = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
): Effect.Effect<HostOpsCopy> =>
  Effect.scoped(
    Effect.gen(function* () {
      const startedAt = Date.now();
      const observedAt = new Date().toISOString();
      const unknownAfter = {
        package: "unknown" as const,
        deployLock: "unknown" as const,
        incoming: "unknown" as const,
        termSocket: "unknown" as const,
      };
      const fail = (
        stderr: string,
        extra: Partial<HostOpsCopy> = {},
      ): HostOpsCopy => ({
        ok: false,
        exit: null,
        stdout: "",
        stderr,
        expectedPackage: "unknown",
        after: unknownAfter,
        elapsedMs: Date.now() - startedAt,
        observedAt,
        ...extra,
      });

      const appPath = resolveLocalAppBundle();
      if (appPath === null) {
        return fail("local Vellum Command.app was not found");
      }
      const admission = yield* Effect.tryPromise({
        try: () => admitLocalAppBundle(appPath),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.result);
      if (admission._tag === "Failure") {
        return fail(admission.failure.message, { localApp: appPath });
      }

      const homeResult = yield* ssh
        .run(homeDirectoryLookup(target))
        .pipe(Effect.result);
      const home =
        homeResult._tag === "Success"
          ? decodeRemoteHomeDirectoryOutput(homeResult.success.stdout)
          : null;
      if (home === null) {
        return fail("remote home is not a canonical absolute path", {
          localApp: appPath,
        });
      }

      const pkgCmd = yield* remoteDarwinPackageExists();
      const pkg = yield* ssh
        .run(oneShot(target, pkgCmd, { budget: "short" }))
        .pipe(Effect.result);
      const expectedPackage = presenceFromTest(pkg);
      const expectedPackageState =
        expectedPackage === "absent" ? ("absent" as const) : ("present" as const);

      const remoteScript = buildRemoteDeployScript(home, admission.success.cdHash, {
        kind: "app-tar",
        expectedPackageState,
      });
      const source = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const lease = appProcessPlane.spawnChild({
              source: "hosts.host-ops.tar",
              purpose: "stream app bundle to remote host",
              command: "/usr/bin/tar",
              args: ["-C", admission.success.appPath, "-cf", "-", "."],
            });
            return {
              lease,
              exit: watchTarExit(lease.io),
              stderr: captureTarStderr(lease.io.stderr),
            };
          },
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        }),
        ({ lease, exit }) =>
          exit.isClosed()
            ? Effect.void
            : Effect.sync(() =>
                appProcessPlane.forceTerminate(
                  lease,
                  "host-ops copy stream scope finalized",
                ),
              ).pipe(
                Effect.andThen(
                  Effect.promise(() => awaitTarCloseBounded(exit, 2_000)),
                ),
              ),
      );
      const command = yield* compileDarwinRemoteDeployScript(remoteScript).pipe(
        Effect.result,
      );
      if (command._tag === "Failure") {
        return fail(
          command.failure instanceof Error
            ? command.failure.message
            : String(command.failure),
          { localApp: appPath, expectedPackage },
        );
      }
      const transferred = yield* ssh
        .transfer(
          deploymentStream(target, command.success),
          Stream.fromAsyncIterable(
            source.lease.io.stdout,
            (error) =>
              new Error(
                `local tar stream failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
          ).pipe(Stream.map((chunk) => Uint8Array.from(chunk))),
          COPY_TIMEOUT_MS,
        )
        .pipe(Effect.result);

      let exit: number | null = null;
      let stdout = "";
      let stderr = "";
      if (transferred._tag === "Success") {
        exit = 0;
        stdout = transferred.success.stdout;
        stderr = transferred.success.stderr;
      } else if (transferred.failure instanceof SshTransferExitError) {
        exit = transferred.failure.code;
        stdout = transferred.failure.stdout;
        stderr = transferred.failure.stderr;
      } else {
        stderr =
          transferred.failure instanceof Error
            ? transferred.failure.message
            : String(transferred.failure);
      }

      const sourceResult = yield* Effect.promise(() => source.exit.settlement);
      if (!sourceResult.ok && stderr.length === 0) {
        stderr = `local tar failed: ${sourceResult.error.message}${source.stderr() ? `: ${source.stderr()}` : ""}`;
      }

      const parsed = parseDeployTransferResult({ stdout, stderr });
      const after = yield* inspectDarwinHost(ssh, target);
      const tag = lastScriptTag(stderr) ?? lastScriptTag(stdout);
      return {
        ok: parsed.ok,
        exit,
        stdout,
        stderr,
        ...(tag === undefined ? {} : { tag }),
        localApp: appPath,
        expectedPackage,
        after: {
          package: after.package,
          deployLock: after.deployLock,
          incoming: after.incoming,
          termSocket: after.termSocket,
        },
        elapsedMs: Date.now() - startedAt,
        observedAt: new Date().toISOString(),
      };
    }),
  );

export const cleanupDarwinHost = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
): Effect.Effect<HostOpsCleanup> =>
  Effect.gen(function* () {
    const observedAt = new Date().toISOString();
    const homeResult = yield* ssh
      .run(homeDirectoryLookup(target))
      .pipe(Effect.result);
    const home =
      homeResult._tag === "Success"
        ? decodeRemoteHomeDirectoryOutput(homeResult.success.stdout)
        : null;
    if (home === null) {
      return {
        ok: false,
        removed: [],
        stderr: "remote home is not a canonical absolute path",
        observedAt,
      };
    }
    const removeCmd = yield* remoteDarwinLaunchAgentIncomingRemove(home).pipe(
      Effect.result,
    );
    if (removeCmd._tag === "Failure") {
      return {
        ok: false,
        removed: [],
        stderr:
          removeCmd.failure instanceof Error
            ? removeCmd.failure.message
            : String(removeCmd.failure),
        observedAt,
      };
    }
    const removedPath = `${home}/Library/LaunchAgents/skastr0.vellumcommand.plist.incoming`;
    const removed = yield* ssh
      .run(oneShot(target, removeCmd.success, { budget: "short" }))
      .pipe(Effect.result);
    if (removed._tag === "Failure") {
      return {
        ok: false,
        removed: [],
        stderr:
          removed.failure instanceof Error
            ? removed.failure.message
            : String(removed.failure),
        observedAt,
      };
    }
    return {
      ok: true,
      removed: [removedPath],
      stderr: "",
      observedAt,
    };
  });

