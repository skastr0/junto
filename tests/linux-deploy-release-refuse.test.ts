import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { LINUX_REMOTE_DEPLOY_DISABLED_DETAIL, RELEASE_CAPABILITIES } from "../src/shared/release-capabilities";
import { InstallationId } from "../src/shared/station-api";
import { admitHostRuntimeApply } from "../src/main/vellum/hosts/host-runtime";
import { applyLinuxHostRuntime } from "../src/main/vellum/hosts/host-runtime-linux";
import { loadRemoteDeploymentProvider } from "../src/main/vellum/hosts/deploy-remote";
import type { HostRuntimeApplyContext } from "../src/main/vellum/hosts/host-runtime-platform";
import type { RemoteHost } from "../src/shared/remote-hosts";
import type { SshTransportShape } from "../src/main/vellum/ssh/service";

/**
 * Live production freeze: HostRuntime.admit after uname, then Linux apply
 * through the release loader. Coordinator does not call the old dispatcher.
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

  it("HostRuntime admit refuses Linux apply under production after uname", () => {
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

  it("Linux apply uses the release loader and refuses before the provider body", async () => {
    expect(RELEASE_CAPABILITIES.linuxRemoteDeploy).toBe(false);
    const ssh = {
      warm: vi.fn(() => Effect.void),
      run: vi.fn(() => Effect.die("apply must not run remote programs")),
      forward: vi.fn(() => Effect.die("apply must not forward")),
    };
    const context: HostRuntimeApplyContext = {
      ssh: ssh as unknown as SshTransportShape,
      host,
      gap: "needInstall",
      configure: {
        commandCenterInstallationId:
          Schema.decodeUnknownSync(InstallationId)("cc-installation"),
        appVersion: "0.1.0",
      },
    };

    const result = await Effect.runPromise(applyLinuxHostRuntime(context));

    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("not-started");
    expect(result.detail).toContain(LINUX_REMOTE_DEPLOY_DISABLED_DETAIL);
    expect(ssh.warm).toHaveBeenCalledOnce();
    expect(ssh.run).not.toHaveBeenCalled();
  });

  it("release loader still refuses so apply cannot bypass the freeze", async () => {
    await expect(loadRemoteDeploymentProvider("linux")).rejects.toThrow(
      /Linux Remote managed deployment is not available/i,
    );
  });

  it("coordinator deploy is HostRuntime.reconcile, not a platformless live freeze", () => {
    const coordinator = readFileSync(
      new URL("../src/main/vellum/hosts/operator-coordinator.ts", import.meta.url),
      "utf8",
    );
    const runtime = readFileSync(
      new URL("../src/main/vellum/hosts/host-runtime.ts", import.meta.url),
      "utf8",
    );
    const linux = readFileSync(
      new URL("../src/main/vellum/hosts/host-runtime-linux.ts", import.meta.url),
      "utf8",
    );
    expect(coordinator).toContain(".reconcile(");
    expect(coordinator).not.toMatch(/hosts\s*\n?\s*\.deployConfiguredRemote/u);
    expect(coordinator).not.toMatch(
      /computeDeployCapabilities\(\{[\s\S]*?platform\s*:/u,
    );
    expect(runtime).toContain("admitHostRuntimeApply");
    expect(runtime).toContain("releaseAllowsTargetPlatform");
    expect(linux).toContain("loadRemoteDeploymentProvider");
    expect(linux).not.toContain("linuxRemoteDeploymentProvider");
  });
});
