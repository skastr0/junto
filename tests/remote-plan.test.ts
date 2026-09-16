import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import { inspectRemoteCommand } from "../src/main/junto/ssh/domain";
import * as remotePlan from "../src/main/junto/ssh/remote-plan";
import {
  compileDarwinRemoteDeployScript,
  compileLinuxUserlandDeploy,
  compileLinuxUserlandPreflight,
  compileLinuxUserlandPreflightSource,
  compileLinuxUserlandDeploySource,
  LINUX_WORK_CONTROL_HANDSHAKE_PYTHON,
} from "../src/main/junto/ssh/remote-plan";
import {
  encodeWorkFrame,
  workErr,
} from "../src/shared/work-control";

const run = <A, E>(effect: Effect.Effect<A, E>): A => {
  const result = Effect.runSync(Effect.result(effect));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

describe("remote-plan public surface", () => {
  it("contains only current runtime and deployment capabilities", () => {
    expect(Object.keys(remotePlan).sort()).toEqual([
      "LINUX_WORK_CONTROL_HANDSHAKE_PYTHON",
      "compileDarwinRemoteActivationScript",
      "compileDarwinRemoteDeployScript",
      "compileLinuxUserlandDeploy",
      "compileLinuxUserlandDeploySource",
      "compileLinuxUserlandObserve",
      "compileLinuxUserlandObserveSource",
      "compileLinuxUserlandPreflight",
      "compileLinuxUserlandPreflightSource",
      "compileLinuxUserlandRestart",
      "compileLinuxUserlandRestartSource",
    ]);
  });
});

describe("linux remote preflight compiler", () => {
  it("compiles userland preflight script and keeps admin-free facts", () => {
    const source = compileLinuxUserlandPreflightSource();
    expect(source).toContain("LINUX_USERLAND_PREFLIGHT_V1");
    expect(source).toContain("umask 077");
    expect(source).toContain("systemctl --user");
    expect(source).not.toContain("sudo");
    expect(source).not.toContain("/usr/libexec/junto-release-installer");
    expect(source).not.toContain("/usr/libexec/junto-release-bridge");
  });

  it("compiles to a branded RemoteCommand with plan argv label", () => {
    const command = run(compileLinuxUserlandPreflight());
    const parts = inspectRemoteCommand(command);
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("junto-plan:linux-userland-preflight");
    expect(parts.args[1]).toBe(compileLinuxUserlandPreflightSource());
  });
});

describe("named deploy compilers", () => {
  it("compiles a userland deploy command with a fixed invocation", () => {
    const parts = inspectRemoteCommand(run(compileLinuxUserlandDeploy()));
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("junto-plan:linux-userland-deploy");
    expect(parts.args[1]).toBe(compileLinuxUserlandDeploySource());
  });

  it("compiles a userland systemd restart command with a fixed invocation", () => {
    const parts = inspectRemoteCommand(run(remotePlan.compileLinuxUserlandRestart()));
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("junto-plan:linux-userland-restart");
    expect(parts.args[1]).toBe(remotePlan.compileLinuxUserlandRestartSource());
    expect(parts.args[1]).toContain("systemctl --user restart junto-remote.service");
    expect(parts.args[1]).not.toMatch(/sudo|rm -rf|--junto-headless/u);
  });

  it("compiles a userland generation observe command with a fixed invocation", () => {
    const parts = inspectRemoteCommand(run(remotePlan.compileLinuxUserlandObserve()));
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("junto-plan:linux-userland-observe");
    expect(parts.args[1]).toBe(remotePlan.compileLinuxUserlandObserveSource());
    expect(parts.args[1]).toContain("LINUX_USERLAND_OBSERVE_V1");
    expect(parts.args[1]).toContain("$HOME/.junto/runtime/releases");
    expect(parts.args[1]).toContain("resources/bin/junto-remote");
    expect(parts.args[1]).not.toMatch(/sudo|rm -rf|--junto-headless|current/u);
  });

  it("hardens deploy around junto-remote generation pin, sealed install, and member proof", () => {
    const source = compileLinuxUserlandDeploySource();
    expect(source).toContain("resources/bin/junto-remote");
    expect(source).not.toContain("--junto-state-preflight");
    expect(source).toContain("--install-user-service");
    expect(source).toContain("unit_pins_generation");
    expect(source).toContain("prove_activation");
    expect(source).toContain('GENERATION_MARKER="releases/$VERSION-$SHA"');
    expect(source).toContain("$GENERATION_MARKER/resources/systemd/junto-remote-launch");
    expect(source).toContain("$GENERATION_MARKER/resources/bin/junto-remote");
    expect(source).toContain("state=idempotent");
    expect(source).toContain('"$HOME/.junto/work/control.sock"');
    expect(source).toContain('"$HOME/.junto/work/token"');
    expect(source).toContain("socket.AF_UNIX");
    expect(source).toContain(remotePlan.LINUX_WORK_CONTROL_HANDSHAKE_PYTHON);
    expect(source).toContain('"op": "ping"');
    expect(source).toContain("s.sendall");
    expect(source).not.toMatch(/s\.connect\([^)]+\);\s*s\.close\(\)/u);
    expect(source).not.toContain('"$DEST/junto"');
    expect(source).not.toContain('"$RELEASE/junto"');
    expect(source).not.toMatch(/Xvfb|ozone-platform|--junto-headless/u);
    expect(source).not.toContain("rm -rf");
    expect(source).toContain('/bin/rm -f -- "$ARCHIVE"');
    expect(source).toContain('/bin/rmdir -- "$STAGE"');
    expect(source).not.toContain('|| fail preflight');
  });

  it("work-control handshake python requires a ping envelope, not a connect-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junto-linux-handshake-"));
    const sock = join(dir, "control.sock");
    const tokenPath = join(dir, "token");
    await writeFile(tokenPath, "secret\n", { mode: 0o600 });
    let seen = "";
    const server: Server = await new Promise((resolve, reject) => {
      const next = createServer((socket) => {
        let buf = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          seen = buf.subarray(0, nl).toString("utf8");
          socket.write(encodeWorkFrame(workErr("AuthError", "process unbound")));
        });
      });
      next.on("error", reject);
      next.listen(sock, () => resolve(next));
    });
    try {
      const result = await new Promise<{
        readonly status: number;
        readonly stderr: string;
      }>((resolve, reject) => {
        const child = spawn("/usr/bin/python3", [
          "-c",
          LINUX_WORK_CONTROL_HANDSHAKE_PYTHON,
          sock,
          tokenPath,
        ]);
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (status) =>
          resolve({ status: status ?? 1, stderr }),
        );
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(seen)).toEqual({ token: "secret", op: "ping" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("admits a product Darwin deploy script and refuses free-form shell", () => {
    const product = [
      "begin_candidate_activation() { :; }",
      'echo "UNBOUND_DEPLOY_PATH_PRESENT" >&2',
      "IN_STATION_EXE=/fixed",
      'echo "NEW_LAUNCHD_PID_NOT_PROVEN" >&2',
      'echo "CONTROL_SOCKET_TIMEOUT" >&2',
    ].join("\n");
    const parts = inspectRemoteCommand(
      run(compileDarwinRemoteDeployScript(product)),
    );
    expect(parts.executable).toBe("/bin/bash");
    expect(parts.args[0]).toBe("-lc");
    expect(parts.args[1]).toBe(product);

    const freeForm = Effect.runSync(
      Effect.result(compileDarwinRemoteDeployScript("rm -rf -- /")),
    );
    expect(Result.isFailure(freeForm)).toBe(true);
  });
});

