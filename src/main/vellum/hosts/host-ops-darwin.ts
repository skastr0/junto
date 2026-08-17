import { join } from "node:path";
import { Effect } from "effect";
import type { Context } from "effect";
import type { HostWorkAttach } from "@shared/host-runtime";
import type {
  HostOpsAttach,
  HostOpsCleanup,
  HostOpsCopy,
  HostOpsInspect,
  HostOpsPresence,
} from "@shared/host-ops";
import {
  TERM_REMOTE_SOCK_REL,
  termControlTokenPath,
} from "@shared/term-control";
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
import { TermControlClient } from "../term/control-client";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";
import { appProcessPlane } from "../app-process-plane";
import {
  admitLocalAppBundle,
  awaitTarCloseBounded,
  buildRemoteDeployScript,
  captureTarStderr,
  compileExpectedPackageState,
  parseDeployTransferResult,
  resolveLocalAppBundle,
  watchTarExit,
} from "./deploy-darwin";
import { stationControlDir, stationDoorSocketPath } from "@shared/station-ssh-control";
import {
  combineHostProcessPlanes,
  probeRemoteDoorSocket,
  readRemoteTextFile,
  withRemoteUnixForward,
  workAttachFromTermConnect,
  workAttachFromTokenFile,
} from "./host-runtime-platform";
import { compileDarwinRemoteDeployScript } from "../ssh/remote-plan";
import {
  estimateDirectoryBytes,
  watchCopyNodeStdout,
} from "./deploy-copy-stream";

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
        process: "unknown" as const,
        workAttach: "unknown" as const,
        observedAt,
      };
    }

    const homeResult = yield* ssh.run(homeDirectoryLookup(target)).pipe(Effect.result);
    const home =
      homeResult._tag === "Success"
        ? decodeRemoteHomeDirectoryOutput(homeResult.success.stdout)
        : null;

    const pkgCmd = yield* remoteDarwinPackageExists().pipe(Effect.result);
    const lockCmd = yield* remoteDarwinDeployLockExists().pipe(Effect.result);
    const incomingCmd = yield* remoteDarwinIncomingExists().pipe(Effect.result);
    const pkg =
      pkgCmd._tag === "Success"
        ? yield* ssh
            .run(oneShot(target, pkgCmd.success, { budget: "short" }))
            .pipe(Effect.result)
        : pkgCmd;
    const lock =
      lockCmd._tag === "Success"
        ? yield* ssh
            .run(oneShot(target, lockCmd.success, { budget: "short" }))
            .pipe(Effect.result)
        : lockCmd;
    const incoming =
      incomingCmd._tag === "Success"
        ? yield* ssh
            .run(oneShot(target, incomingCmd.success, { budget: "short" }))
            .pipe(Effect.result)
        : incomingCmd;

    let termSocket: HostOpsPresence = "unknown";
    let processPlane: HostOpsInspect["process"] = "unknown";
    let workAttach: HostOpsInspect["workAttach"] = "unknown";
    if (home !== null) {
      const sockCmd = yield* remoteTestSocketExists(
        join(home, TERM_REMOTE_SOCK_REL),
      ).pipe(Effect.result);
      if (sockCmd._tag === "Success") {
        const sock = yield* ssh
          .run(oneShot(target, sockCmd.success, { budget: "short" }))
          .pipe(Effect.result);
        termSocket = presenceFromTest(sock);
      }
      processPlane = yield* inspectDarwinProcess(ssh, target, home);
      workAttach = yield* probeDarwinWorkAttach(ssh, target, home);
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
      process: processPlane,
      workAttach,
      observedAt,
    };
  });

export const copyDarwinHost = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
  compiledPackageState?: "absent" | "present",
  hostId?: string,
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
      const expectedPackageState = compileExpectedPackageState(
        expectedPackage,
        compiledPackageState,
      );

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
          watchCopyNodeStdout(
            source.lease.io.stdout,
            estimateDirectoryBytes(admission.success.appPath),
            hostId,
          ),
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
  ).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ok: false,
        exit: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        expectedPackage: "unknown" as const,
        after: {
          package: "unknown" as const,
          deployLock: "unknown" as const,
          incoming: "unknown" as const,
          termSocket: "unknown" as const,
        },
        elapsedMs: 0,
        observedAt: new Date().toISOString(),
      }),
    ),
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

const inspectDarwinProcess = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
  home: string,
): Effect.Effect<HostOpsInspect["process"]> =>
  Effect.gen(function* () {
    const stationHome = stationControlDir(home);
    const enroll = yield* probeRemoteDoorSocket(
      ssh,
      target,
      stationDoorSocketPath(stationHome, "enroll"),
    );
    const peer = yield* probeRemoteDoorSocket(
      ssh,
      target,
      stationDoorSocketPath(stationHome, "peer"),
    );
    return combineHostProcessPlanes(enroll, peer);
  });

const attachReceipt = (
  workAttach: HostWorkAttach,
  observedAt: string,
  detail?: string,
): HostOpsAttach => ({
  ok: workAttach === "up",
  workAttach,
  detail:
    detail ??
    (workAttach === "up"
      ? "work attach connected"
      : `work attach ${workAttach}`),
  observedAt,
});

/** Ready is a real term connect. Sock-on-disk is leftover, not workAttach. */
const probeDarwinWorkAttach = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
  home: string,
): Effect.Effect<HostWorkAttach> =>
  Effect.gen(function* () {
    const token = yield* readRemoteTextFile(
      ssh,
      target,
      termControlTokenPath(home),
    );
    const fromToken = workAttachFromTokenFile(token);
    if (fromToken !== undefined) return fromToken;
    if (token._tag !== "present") return "unknown";
    return yield* withRemoteUnixForward(
      ssh,
      target,
      join(home, TERM_REMOTE_SOCK_REL),
      (localSocket) =>
        Effect.tryPromise({
          try: async () => {
            const client = await TermControlClient.connect({
              socketPath: localSocket,
              token: token.text,
              timeoutMs: 2_000,
            });
            await client.drainOnQuit();
            return "up" as const;
          },
          catch: (error) =>
            error instanceof Error ? error : new Error("term attach failed"),
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(workAttachFromTermConnect(error)),
          ),
        ),
    );
  });

export const attachDarwinHost = (
  ssh: Context.Service.Shape<typeof SshTransport>,
  target: SshTarget,
): Effect.Effect<HostOpsAttach> =>
  Effect.gen(function* () {
    const observedAt = new Date().toISOString();
    const homeResult = yield* ssh
      .run(homeDirectoryLookup(target))
      .pipe(Effect.result);
    if (homeResult._tag === "Failure") {
      return attachReceipt("unknown", observedAt, "remote home lookup failed");
    }
    const home = decodeRemoteHomeDirectoryOutput(homeResult.success.stdout);
    if (home === null) {
      return attachReceipt(
        "unknown",
        observedAt,
        "remote home is not a canonical absolute path",
      );
    }
    return attachReceipt(
      yield* probeDarwinWorkAttach(ssh, target, home),
      observedAt,
    );
  });

