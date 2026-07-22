/**
 * Command Center → macOS Remote: install/update Vellum Command.app over SSH and start it.
 *
 * macOS-only for now (Linux Electron station is a separate track). Streams tar over
 * ssh stdin. After install: LaunchAgent + start station + probe term + browser
 * control sockets.
 *
 * Starts WITHOUT --vellum-headless so BrowserWindow exists for WebContentsView
 * (host-local browser automation). Headless-only is terminal-capable but not
 * browser-capable until an offscreen parent window lands.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Context } from "effect";
import { Effect, Stream } from "effect";
import type { RemoteHost } from "@shared/remote-hosts";
import { RemoteHostsError } from "@shared/remote-hosts";
import { controlSocketPath as browserControlSocketPath } from "@shared/browser-control";
import { TERM_REMOTE_SOCK_REL } from "@shared/term-control";
import {
  makeRemoteCommand,
  parseSshEndpoint,
  type SshEndpoint,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShot, sharedStream } from "../ssh/program";
import { SshTransferExitError, SshTransport } from "../ssh/service";
import {
  admitChildProcess,
  releaseOwned,
  signalOwned,
} from "../process-signal";

const PRODUCT_NAME = "Vellum Command";
const APP_BUNDLE_NAME = `${PRODUCT_NAME}.app`;
const LABEL = "skastr0.vellum";
const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;

/** Lazy electron app — avoid import-time electron in unit tests. */
const tryPackagedAppPath = (): string | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    if (!app?.isPackaged) return null;
    let dir = dirname(process.execPath);
    for (let i = 0; i < 6; i += 1) {
      if (
        dir.endsWith(".app") &&
        existsSync(join(dir, "Contents", "MacOS", PRODUCT_NAME))
      ) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not in electron */
  }
  return null;
};

export type DeployRemoteResult = {
  readonly ok: boolean;
  readonly detail: string;
  readonly code?: "io" | "validation" | "not_found" | "conflict";
  readonly message?: string;
  readonly stages: readonly string[];
};

type Ssh = Context.Tag.Service<typeof SshTransport>;

const push = (stages: string[], line: string): void => {
  stages.push(line);
  console.info(`[deploy-remote] ${line}`);
};

/** Resolve the local .app bundle Command Center will push. */
export const resolveLocalAppBundle = (): string | null => {
  const env = process.env.VELLUM_APP_SRC?.trim();
  if (env && existsSync(join(env, "Contents", "MacOS", PRODUCT_NAME)))
    return env;

  const packaged = tryPackagedAppPath();
  if (packaged) return packaged;

  for (const c of [
    `/Applications/${APP_BUNDLE_NAME}`,
    join(process.cwd(), "release", "mac-arm64", APP_BUNDLE_NAME),
    join(process.cwd(), "release", "mac", APP_BUNDLE_NAME),
    join(process.cwd(), "release", "mac-x64", APP_BUNDLE_NAME),
  ]) {
    if (existsSync(join(c, "Contents", "MacOS", PRODUCT_NAME))) return c;
  }
  return null;
};

export const parseDeployTransferResult = (input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly ok: boolean; readonly detail: string } => {
  if (input.stdout.includes("STATION_READY")) {
    return {
      ok: true,
      detail: "app installed; term + browser control sockets ready",
    };
  }
  if (input.stdout.includes("TERM_SOCK_OK")) {
    return {
      ok: true,
      detail:
        "app installed; term control ready (browser control socket not observed yet — open Remote UI/session if needed)",
    };
  }
  return {
    ok: true,
    detail:
      "app installed and started (control sockets not fully observed — station may still be warming)",
  };
};

export type TarExitSettlement =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: Error };

export type TarExitWatch = {
  readonly settlement: Promise<TarExitSettlement>;
  readonly closed: Promise<void>;
  readonly isClosed: () => boolean;
  readonly isReleased: () => boolean;
  readonly release: () => void;
};

const TAR_STDERR_LIMIT_BYTES = 64 * 1024;

/** Attach both listeners at spawn time: an error is not proof the child has exited. */
export const watchTarExit = (
  tar: Pick<ChildProcess, "once" | "removeListener">,
  onClose: () => void = () => {},
): TarExitWatch => {
  let settle: (result: TarExitSettlement) => void = () => {};
  let close: () => void = () => {};
  const settlement = new Promise<TarExitSettlement>((resolve) => {
    settle = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  let reported = false;
  let didClose = false;
  let didRelease = false;
  const release = (): void => {
    if (didRelease) return;
    didRelease = true;
    onClose();
  };
  const report = (result: TarExitSettlement): void => {
    if (reported) return;
    reported = true;
    settle(result);
  };

  const onError = (error: Error): void => {
    report({ ok: false, error });
  };
  const onCloseEvent = (code: number | null): void => {
    didClose = true;
    tar.removeListener("error", onError);
    report(
      code === 0
        ? { ok: true }
        : { ok: false, error: new Error(`local tar exited ${String(code)}`) },
    );
    close();
    release();
  };
  tar.once("error", onError);
  tar.once("close", onCloseEvent);
  return {
    settlement,
    closed,
    isClosed: () => didClose,
    isReleased: () => didRelease,
    release,
  };
};

/** Native timer race: completes even while an Effect finalizer is uninterruptible. */
export const awaitTarCloseBounded = (exit: TarExitWatch, timeoutMs: number): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    void exit.closed.then(finish);
  });

export const captureTarStderr = (stream: {
  readonly on: (event: "data", listener: (chunk: Buffer) => void) => unknown;
}): (() => string) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream.on("data", (chunk) => {
    const remaining = TAR_STDERR_LIMIT_BYTES - bytes;
    if (remaining <= 0) return;
    const bounded = Buffer.from(chunk).subarray(0, remaining);
    chunks.push(bounded);
    bytes += bounded.byteLength;
  });
  return () => Buffer.concat(chunks, bytes).toString("utf8");
};

export const describeDeployTransferFailure = (error: unknown): string => {
  if (error instanceof SshTransferExitError) {
    const diagnostic = (error.stderr || error.stdout).trim().slice(0, 900);
    if (diagnostic.includes("REMOTE_NOT_DARWIN")) {
      return "remote host is not macOS — full-app Deploy Remote is Darwin-only (Linux Electron station is a separate track)";
    }
    return diagnostic || error.message;
  }
  return error instanceof Error ? error.message : String(error);
};

const streamAppToRemote = (
  ssh: Ssh,
  endpoint: SshEndpoint,
  input: {
    readonly localApp: string;
    readonly remoteHome: string;
  },
): Effect.Effect<
  { readonly ok: boolean; readonly detail: string },
  Error | import("../ssh/domain").SshError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const parent = dirname(input.localApp);
      const bundle = basename(input.localApp);
      const remoteApp = `/Applications/${bundle}`;
      const remoteExe = `${remoteApp}/Contents/MacOS/${PRODUCT_NAME}`;
      const plistPath = `${input.remoteHome}/Library/LaunchAgents/${LABEL}.plist`;
      const logDir = `${input.remoteHome}/Library/Logs/${PRODUCT_NAME}`;
      const termSock = `${input.remoteHome}/${TERM_REMOTE_SOCK_REL}`;
      const browserSock = browserControlSocketPath(input.remoteHome);

      // No --vellum-headless: WebContentsView needs a BrowserWindow parent.
      const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>
<string>${remoteExe}</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Interactive</string>
<key>StandardOutPath</key><string>${logDir}/vellum.out.log</string>
<key>StandardErrorPath</key><string>${logDir}/vellum.err.log</string>
</dict></plist>
`;
      const plistB64 = Buffer.from(plistBody, "utf8").toString("base64");

      // Paths embedded via JSON.stringify so they are shell-safe literals.
      const remoteScript = `
set -euo pipefail
umask 022
# Full-app Remote is macOS-only (LaunchAgent + .app).
test "$(uname -s)" = "Darwin" || { echo "REMOTE_NOT_DARWIN $(uname -s)" >&2; exit 3; }
osascript -e 'tell application ${JSON.stringify(PRODUCT_NAME)} to quit' >/dev/null 2>&1 || true
sleep 1
launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
mkdir -p /Applications
IN=${JSON.stringify(`${remoteApp}.incoming`)}
APP=${JSON.stringify(remoteApp)}
BUNDLE=${JSON.stringify(bundle)}
EXE=${JSON.stringify(remoteExe)}
TERM_SOCK=${JSON.stringify(termSock)}
BROWSER_SOCK=${JSON.stringify(browserSock)}
PLIST=${JSON.stringify(plistPath)}
LOGDIR=${JSON.stringify(logDir)}
rm -rf "$IN"
mkdir -p "$IN"
tar -C "$IN" -xf -
test -x "$IN/$BUNDLE/Contents/MacOS/${PRODUCT_NAME}"
rm -rf "$APP"
mv "$IN/$BUNDLE" "$APP"
rm -rf "$IN"
test -x "$EXE"
mkdir -p "$(dirname "$PLIST")" "$LOGDIR"
echo ${JSON.stringify(plistB64)} | base64 -d > "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
# GUI session required for WebContentsView parenting (browser automation).
open -a "$APP" >/dev/null 2>&1 || ("$EXE" >/dev/null 2>&1 &)
TERM_OK=0
BROWSER_OK=0
for i in $(seq 1 60); do
  if [ -S "$TERM_SOCK" ]; then TERM_OK=1; fi
  if [ -S "$BROWSER_SOCK" ]; then BROWSER_OK=1; fi
  if [ "$TERM_OK" = "1" ] && [ "$BROWSER_OK" = "1" ]; then
    echo "STATION_READY term=1 browser=1"
    exit 0
  fi
  sleep 1
done
echo "STATION_PARTIAL term=$TERM_OK browser=$BROWSER_OK" >&2
# Term sock is enough for native remote terminals; browser may lag.
if [ "$TERM_OK" = "1" ]; then
  echo "TERM_SOCK_OK browser=$BROWSER_OK"
  exit 0
fi
echo "TERM_SOCK_TIMEOUT" >&2
exit 2
`.trim();

      const tar = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const child = spawn("tar", ["-C", parent, "-cf", "-", bundle], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          const owned = admitChildProcess({
            source: "hosts.deploy-remote.tar",
            child,
          });
          return {
            child,
            owned,
            exit: watchTarExit(child, () => releaseOwned(owned)),
            stderr: captureTarStderr(child.stderr),
          };
        }),
        ({ owned, exit }) =>
          exit.isReleased() || exit.isClosed()
            ? Effect.void
            : Effect.sync(() => {
                signalOwned(owned, "SIGKILL");
              }).pipe(
                Effect.zipRight(Effect.promise(() => awaitTarCloseBounded(exit, 2_000))),
                Effect.ensuring(Effect.sync(() => exit.release())),
              ),
      );
      const command = yield* makeRemoteCommand("bash", ["-lc", remoteScript]);
      const output = yield* ssh.transfer(
        sharedStream(endpoint, command),
        Stream.fromAsyncIterable(
          tar.child.stdout,
          (error) =>
            new Error(
              `local tar stream failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
        ).pipe(Stream.map((chunk) => Uint8Array.from(chunk))),
        DEPLOY_TIMEOUT_MS,
      );
      const tarResult = yield* Effect.promise(() => tar.exit.settlement);
      if (!tarResult.ok) {
        return yield* Effect.fail(
          new Error(
            `local tar failed: ${tarResult.error.message}${tar.stderr() ? `: ${tar.stderr()}` : ""}`,
          ),
        );
      }
      return parseDeployTransferResult(output);
    }),
  );

export const deployRemoteHost = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<DeployRemoteResult, never> =>
  Effect.gen(function* () {
    const stages: string[] = [];
    if (process.platform !== "darwin") {
      return {
        ok: false,
        detail:
          "Deploy Remote must run from a macOS Command Center (local .app source)",
        code: "validation" as const,
        stages,
      };
    }
    if (host.kind !== "remote" || !host.endpoint) {
      return {
        ok: false,
        detail: `host ${host.id} is not a remote SSH endpoint`,
        code: "validation" as const,
        stages,
      };
    }

    const localApp = resolveLocalAppBundle();
    if (!localApp) {
      return {
        ok: false,
        detail:
          "no local Vellum Command.app found — package/install on Command Center first (/Applications or release/mac-arm64)",
        code: "not_found" as const,
        message: "local app bundle missing",
        stages,
      };
    }
    push(stages, `local bundle ${localApp}`);

    const endpoint = yield* parseSshEndpoint(host.endpoint).pipe(
      Effect.mapError(
        (e) =>
          new RemoteHostsError("validation", `Invalid endpoint: ${e.message}`),
      ),
      Effect.either,
    );
    if (endpoint._tag === "Left") {
      return {
        ok: false,
        detail: endpoint.left.message,
        code: "validation" as const,
        stages,
      };
    }
    push(stages, "endpoint ok");

    const warm = yield* ssh.warm(endpoint.right).pipe(Effect.either);
    if (warm._tag === "Left") {
      return {
        ok: false,
        detail: `${host.label}: SSH warm failed — check SSH config / Tailscale / keys`,
        code: "io" as const,
        stages,
      };
    }
    push(stages, "ssh warm ok");

    // Fail fast on Linux before streaming hundreds of MB.
    const unameCmd = yield* makeRemoteCommand("uname", ["-s"]).pipe(
      Effect.either,
    );
    if (unameCmd._tag === "Right") {
      const unameRes = yield* ssh
        .run(oneShot(endpoint.right, unameCmd.right, { budget: "short" }))
        .pipe(Effect.either);
      if (unameRes._tag === "Right") {
        const osName = unameRes.right.stdout.trim();
        push(stages, `remote uname ${osName}`);
        if (osName !== "Darwin") {
          return {
            ok: false,
            detail: `${host.label}: remote OS is ${osName || "unknown"} — full-app Deploy is macOS-only`,
            code: "validation" as const,
            message: "remote not Darwin",
            stages,
          };
        }
      }
    }

    const homeResult = yield* ssh
      .run(homeDirectoryLookup(endpoint.right))
      .pipe(Effect.either);
    if (homeResult._tag === "Left") {
      return {
        ok: false,
        detail: `${host.label}: remote home lookup failed`,
        code: "io" as const,
        stages,
      };
    }
    const home = homeResult.right.stdout.trim();
    if (!home.startsWith("/")) {
      return {
        ok: false,
        detail: `${host.label}: could not read remote home`,
        code: "io" as const,
        stages,
      };
    }
    push(stages, `remote home ${home}`);

    const streamed = yield* streamAppToRemote(ssh, endpoint.right, {
      localApp,
      remoteHome: home,
    }).pipe(Effect.either);

    if (streamed._tag === "Left") {
      return {
        ok: false,
        detail: `${host.label}: ${describeDeployTransferFailure(streamed.left)}`,
        code: "io" as const,
        message: describeDeployTransferFailure(streamed.left),
        stages,
      };
    }
    push(stages, streamed.right.detail);
    if (!streamed.right.ok) {
      return {
        ok: false,
        detail: `${host.label}: ${streamed.right.detail}`,
        code: "io" as const,
        message: streamed.right.detail,
        stages,
      };
    }

    const tokenPath = join(home, ".vellum", "term", "token");
    const tokenCmd = yield* makeRemoteCommand("/bin/test", [
      "-f",
      tokenPath,
    ]).pipe(Effect.either);
    if (tokenCmd._tag === "Right") {
      const tokenProbe = yield* ssh
        .run(oneShot(endpoint.right, tokenCmd.right, { budget: "short" }))
        .pipe(Effect.either);
      if (tokenProbe._tag === "Right")
        push(stages, "term control token present");
      else push(stages, "term control token not yet visible");
    }

    return {
      ok: true,
      detail: `${host.label} (${host.endpoint}): ${streamed.right.detail}`,
      stages,
    } satisfies DeployRemoteResult;
  });
