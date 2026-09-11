import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HostsServiceShape } from "../src/main/vellum-command/hosts/service";

describe("HostsService deploy surface", () => {
  it("has no deploy verb: HostRuntime.reconcile is the only deployment path", () => {
    const hostsServiceHasNoDeployRemote: "deployRemote" extends keyof HostsServiceShape
      ? never
      : true = true;
    expect(hostsServiceHasNoDeployRemote).toBe(true);

    const hostsServiceHasNoDeployConfiguredRemote: "deployConfiguredRemote" extends keyof HostsServiceShape
      ? never
      : true = true;
    expect(hostsServiceHasNoDeployConfiguredRemote).toBe(true);

    const service = readFileSync(
      new URL("../src/main/vellum-command/hosts/service.ts", import.meta.url),
      "utf8",
    );
    expect(service).not.toContain("deployConfiguredRemote");
    expect(service).not.toContain("deployRemoteHost");
    expect(service).not.toMatch(/\bdeployRemote\s*:/u);
    expect(service).not.toContain('"./deploy-remote"');
    expect(service).not.toContain("darwinRemoteDeploymentProvider");
    // The service no longer reaches into HostRuntime at all; the coordinator
    // is the single caller of reconcile.
    expect(service).not.toContain("HostRuntime");
  });
});
