import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { LINUX_REMOTE_DEPLOY_DISABLED_DETAIL, RELEASE_CAPABILITIES } from "../src/shared/release-capabilities";
import { admitHostRuntimeApply, applyHostRuntime } from "../src/main/vellum-command/hosts/host-runtime";
import { HostOps, HostTarget } from "../src/main/vellum-command/hosts/host-ops";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { parseSshEndpoint } from "../src/main/vellum-command/ssh/domain";
import { SshTransport } from "../src/main/vellum-command/ssh/service";

/**
 * Live production freeze: HostRuntime.admit after observe, then Linux
 * HostOps.copy stays LINUX_REMOTE_DEPLOY_OFF.
 */
const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio-box",
  capabilities: ["terminal"],
};

const linuxObservation = {
  hostId: "studio",
  placement: "remote" as const,
  platform: "linux" as const,
  network: "up" as const,
  package: "absent" as const,
  process: "unknown" as const,
  workAttach: "unknown" as const,
  mode: "unenrolled" as const,
};

describe("production Linux deploy freeze (live HostRuntime path)", () => {
  it("keeps linuxRemoteDeploy off in production defaults", () => {
    expect(RELEASE_CAPABILITIES.linuxRemoteDeploy).toBe(false);
    expect(RELEASE_CAPABILITIES.boxFleet).toBe(false);
  });

  it("HostRuntime admit refuses Linux apply under production after observe", () => {
    const fromDarwinCc = admitHostRuntimeApply({
      observation: linuxObservation,
      hostLabel: "Studio",
      commandCenterPlatform: "darwin",
    });
    const fromLinuxCc = admitHostRuntimeApply({
      observation: linuxObservation,
      hostLabel: "Studio",
      commandCenterPlatform: "linux",
    });
    expect(fromDarwinCc.ok).toBe(false);
    expect(fromLinuxCc.ok).toBe(false);
    if (fromDarwinCc.ok || fromLinuxCc.ok) return;
    expect(fromDarwinCc.detail).toBe(
      `Studio: ${LINUX_REMOTE_DEPLOY_DISABLED_DETAIL}`,
    );
    expect(fromLinuxCc.detail).toBe(fromDarwinCc.detail);
    expect(fromDarwinCc.code).toBe("validation");
  });

  it("Linux HostOps copy refuses before a provider body", async () => {
    const target = Effect.runSync(parseSshEndpoint("studio-box"));
    const ssh = {
      warm: () => Effect.void,
      run: () => Effect.die("copy must not run remote programs"),
      forward: () => Effect.die("copy must not forward"),
    };
    const result = await Effect.runPromise(
      applyHostRuntime({
        host,
        gap: "needInstall",
      }).pipe(
        Effect.provide(
          HostOps.layerLinux.pipe(
            Layer.provide(HostTarget.layer(target)),
            Layer.provide(Layer.succeed(SshTransport, ssh as never)),
          ),
        ),
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("not-started");
    expect(result.detail).toContain("LINUX_REMOTE_DEPLOY_OFF");
    expect(result.detail).toMatch(/Linux Remote Deploy is not enabled/i);
  });

  it("coordinator deploy is HostRuntime.reconcile, not a platformless live freeze", () => {
    const coordinator = readFileSync(
      new URL("../src/main/vellum-command/hosts/operator-coordinator.ts", import.meta.url),
      "utf8",
    );
    const runtime = readFileSync(
      new URL("../src/main/vellum-command/hosts/host-runtime.ts", import.meta.url),
      "utf8",
    );
    const linuxOps = readFileSync(
      new URL("../src/main/vellum-command/hosts/host-ops-linux.ts", import.meta.url),
      "utf8",
    );
    expect(coordinator).toContain(".reconcile(");
    expect(coordinator).not.toMatch(/hosts\s*\n?\s*\.deployConfiguredRemote/u);
    expect(coordinator).not.toMatch(
      /computeDeployCapabilities\(\{[\s\S]*?platform\s*:/u,
    );
    expect(runtime).toContain("admitHostRuntimeApply");
    expect(runtime).toContain("releaseAllowsTargetPlatform");
    expect(runtime).toContain("applyHostRuntime");
    expect(linuxOps).toContain("LINUX_REMOTE_DEPLOY_OFF");
    expect(linuxOps).not.toContain("linuxRemoteDeploymentProvider");
  });
});
