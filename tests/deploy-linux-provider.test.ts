/**
 * Live Linux deploy surface: decode receipts, HostRuntime restart act, and the
 * userland observe script. The platform-provider dispatch path is deleted;
 * deploy flows only through HostRuntime reconcile -> HostOps.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { classifyHostRuntimeBlocker } from "../src/shared/host-runtime";
import {
  activateLinuxRemoteRuntimeForTarget,
  buildLinuxRemotePreflightScript,
  decodeLinuxRemoteObserve,
  decodeLinuxRemoteRestart,
  linuxObserveToHostPackage,
} from "../src/main/vellum-command/hosts/deploy-linux";
import type { RemoteDeploymentTarget } from "../src/main/vellum-command/hosts/remote-deployment";
import { parseSshEndpoint, type SshEndpoint } from "../src/main/vellum-command/ssh/domain";
import { compileLinuxUserlandObserveSource } from "../src/main/vellum-command/ssh/remote-plan";

const endpoint = Effect.runSync(parseSshEndpoint("studio-box"));

const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: String(endpoint),
  capabilities: ["terminal", "browser"],
};

const target: RemoteDeploymentTarget = {
  host: host as RemoteHost & {
    readonly kind: "remote";
    readonly sshEndpoint: string;
  },
  endpoint: endpoint as SshEndpoint,
  sshTarget: {
    endpoint,
    identity: undefined,
  } as never,
  platform: { platform: "linux", kernelName: "Linux" },
  progress: ["target admitted"],
};

const sshWithStdout = (stdout: string) =>
  ({
    run: () =>
      Effect.succeed({
        stdout,
        stderr: "",
        exitCode: 0,
      }),
  }) as never;

describe("Linux remote receipt decoding", () => {
  it("keeps the preflight marker constant", () => {
    expect(buildLinuxRemotePreflightScript()).toBe("userland runtime preflight");
  });

  it("decodes restart receipts", () => {
    expect(decodeLinuxRemoteRestart("LINUX_USERLAND_RESTART_V1 ok=1\n")).toEqual(
      { ok: true },
    );
    expect(
      decodeLinuxRemoteRestart("LINUX_USERLAND_RESTART_V1 ok=0 reason=restart\n"),
    ).toEqual({ ok: false, reason: "restart" });
    expect(decodeLinuxRemoteRestart("garbage")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("decodes observe receipts into package presence", () => {
    expect(decodeLinuxRemoteObserve("LINUX_USERLAND_OBSERVE_V1 present=1\n")).toEqual(
      { ok: true, present: true },
    );
    expect(decodeLinuxRemoteObserve("LINUX_USERLAND_OBSERVE_V1 present=0\n")).toEqual(
      { ok: true, present: false },
    );
    expect(
      linuxObserveToHostPackage(decodeLinuxRemoteObserve("garbage")),
    ).toBe("unknown");
  });
});

describe("Linux HostRuntime restart act", () => {
  it("restarts the systemd user service as the HostRuntime restart act", async () => {
    const result = await Effect.runPromise(
      activateLinuxRemoteRuntimeForTarget(
        sshWithStdout("LINUX_USERLAND_RESTART_V1 ok=1\n"),
        target,
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("systemd user service restarted");
  });

  it("does not label a failed systemd restart as a missing login session", async () => {
    const result = await Effect.runPromise(
      activateLinuxRemoteRuntimeForTarget(
        sshWithStdout("LINUX_USERLAND_RESTART_V1 ok=0 reason=restart\n"),
        target,
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("systemd user service restart failed");
    expect(classifyHostRuntimeBlocker(result.detail)).toBeUndefined();
  });
});

describe("Linux userland generation observe", () => {
  it("reports present only when a canonical generation tree exists", () => {
    const home = mkdtempSync(join(tmpdir(), "vellum-linux-observe-"));
    const run = () =>
      spawnSync(
        "/bin/sh",
        [
          "-c",
          compileLinuxUserlandObserveSource(),
          "vellum-plan:linux-userland-observe",
        ],
        { encoding: "utf8", env: { ...process.env, HOME: home } },
      );
    try {
      const empty = run();
      expect(empty.status).toBe(0);
      expect(
        linuxObserveToHostPackage(decodeLinuxRemoteObserve(empty.stdout)),
      ).toBe("absent");

      const dest = join(
        home,
        ".vellum-command",
        "runtime",
        "releases",
        `1.2.3-${"a".repeat(64)}`,
      );
      mkdirSync(join(dest, "resources", "bin"), { recursive: true });
      mkdirSync(join(dest, "resources", "systemd"), { recursive: true });
      const remote = join(dest, "resources", "bin", "vellum-command-remote");
      const launch = join(
        dest,
        "resources",
        "systemd",
        "vellum-command-remote-launch",
      );
      writeFileSync(remote, "remote");
      writeFileSync(launch, "launch");
      chmodSync(remote, 0o755);
      chmodSync(launch, 0o755);

      const installed = run();
      expect(installed.status).toBe(0);
      expect(
        linuxObserveToHostPackage(decodeLinuxRemoteObserve(installed.stdout)),
      ).toBe("present");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
