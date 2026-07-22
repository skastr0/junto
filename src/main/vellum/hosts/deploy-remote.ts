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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Context } from "effect";
import { Effect } from "effect";
import type { RemoteHost } from "@shared/remote-hosts";
import { RemoteHostsError } from "@shared/remote-hosts";
import { controlSocketPath as browserControlSocketPath } from "@shared/browser-control";
import { TERM_REMOTE_SOCK_REL } from "@shared/term-control";
import { makeRemoteCommand, parseSshEndpoint } from "../ssh/domain";
import { homeDirectoryLookup, oneShot } from "../ssh/program";
import { SshTransport } from "../ssh/service";

const PRODUCT_NAME = "Vellum Command";
const APP_BUNDLE_NAME = `${PRODUCT_NAME}.app`;
const LABEL = "skastr0.vellum";
const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
const SSH_BIN = process.env.VELLUM_SSH_EXECUTABLE?.trim() || "/usr/bin/ssh";

/** Lazy electron app — avoid import-time electron in unit tests. */
const tryPackagedAppPath = (): string | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    if (!app?.isPackaged) return null;
    let dir = dirname(process.execPath);
    for (let i = 0; i < 6; i += 1) {
      if (dir.endsWith(".app") && existsSync(join(dir, "Contents", "MacOS", PRODUCT_NAME))) {
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
  if (env && existsSync(join(env, "Contents", "MacOS", PRODUCT_NAME))) return env;

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

const streamAppToRemote = (input: {
  readonly endpoint: string;
  readonly localApp: string;
  readonly remoteHome: string;
}): Promise<{ readonly ok: boolean; readonly detail: string }> =>
  new Promise((resolve) => {
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

    const tar = spawn("tar", ["-C", parent, "-cf", "-", bundle], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ssh = spawn(
      SSH_BIN,
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        input.endpoint,
        "bash",
        "-lc",
        remoteScript,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };

    const timer = setTimeout(() => {
      try {
        tar.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        ssh.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(false, `deploy timed out after ${DEPLOY_TIMEOUT_MS}ms`);
    }, DEPLOY_TIMEOUT_MS);
    timer.unref?.();

    tar.stdout.pipe(ssh.stdin);
    tar.stderr.setEncoding("utf8");
    ssh.stdout.setEncoding("utf8");
    ssh.stderr.setEncoding("utf8");
    tar.stderr.on("data", (c: string) => {
      stderr += c;
    });
    ssh.stdout.on("data", (c: string) => {
      stdout += c;
    });
    ssh.stderr.on("data", (c: string) => {
      stderr += c;
    });
    tar.on("error", (err) => finish(false, `local tar failed: ${err.message}`));
    ssh.on("error", (err) => finish(false, `ssh failed: ${err.message}`));
    ssh.on("close", (code) => {
      if (code === 3 || stderr.includes("REMOTE_NOT_DARWIN")) {
        finish(
          false,
          "remote host is not macOS — full-app Deploy Remote is Darwin-only (Linux Electron station is a separate track)",
        );
        return;
      }
      if (code === 0 && stdout.includes("STATION_READY")) {
        finish(true, "app installed; term + browser control sockets ready");
        return;
      }
      if (code === 0 && stdout.includes("TERM_SOCK_OK")) {
        finish(
          true,
          "app installed; term control ready (browser control socket not observed yet — open Remote UI/session if needed)",
        );
        return;
      }
      if (code === 0) {
        finish(
          true,
          "app installed and started (control sockets not fully observed — station may still be warming)",
        );
        return;
      }
      const err = (stderr || stdout || `ssh exit ${String(code)}`).trim().slice(0, 900);
      finish(false, err || `deploy failed (exit ${String(code)})`);
    });
  });

export const deployRemoteHost = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<DeployRemoteResult, never> =>
  Effect.gen(function* () {
    const stages: string[] = [];
    if (process.platform !== "darwin") {
      return {
        ok: false,
        detail: "Deploy Remote must run from a macOS Command Center (local .app source)",
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
        (e) => new RemoteHostsError("validation", `Invalid endpoint: ${e.message}`),
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
    const unameCmd = yield* makeRemoteCommand("uname", ["-s"]).pipe(Effect.either);
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

    const homeResult = yield* ssh.run(homeDirectoryLookup(endpoint.right)).pipe(Effect.either);
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

    const streamed = yield* Effect.tryPromise({
      try: () =>
        streamAppToRemote({
          endpoint: String(endpoint.right),
          localApp,
          remoteHome: home,
        }),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }).pipe(Effect.either);

    if (streamed._tag === "Left") {
      return {
        ok: false,
        detail: `${host.label}: ${streamed.left.message}`,
        code: "io" as const,
        message: streamed.left.message,
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
    const tokenCmd = yield* makeRemoteCommand("/bin/test", ["-f", tokenPath]).pipe(Effect.either);
    if (tokenCmd._tag === "Right") {
      const tokenProbe = yield* ssh
        .run(oneShot(endpoint.right, tokenCmd.right, { budget: "short" }))
        .pipe(Effect.either);
      if (tokenProbe._tag === "Right") push(stages, "term control token present");
      else push(stages, "term control token not yet visible");
    }

    return {
      ok: true,
      detail: `${host.label} (${host.endpoint}): ${streamed.right.detail}`,
      stages,
    } satisfies DeployRemoteResult;
  });
