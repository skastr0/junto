import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  decideHostRuntimeGap,
  HostRuntimeObservation,
  hostRuntimeGapCopy,
} from "../src/shared/host-runtime";

const observation = (
  overrides: Partial<typeof HostRuntimeObservation.Type>,
): typeof HostRuntimeObservation.Type =>
  Schema.decodeUnknownSync(HostRuntimeObservation)({
    hostId: "remote-a",
    placement: "remote",
    platform: "darwin",
    network: "up",
    package: "present",
    process: "unknown",
    workAttach: "unknown",
    mode: "unenrolled",
    ...overrides,
  });

describe("decideHostRuntimeGap", () => {
  it("never treats unknown as down or ready", () => {
    expect(
      decideHostRuntimeGap(
        observation({
          process: "unknown",
          workAttach: "unknown",
          package: "unknown",
        }),
        "check",
      ),
    ).toBe("stillTrying");
  });

  it("check is ready only when work attach is up on a configured station", () => {
    expect(
      decideHostRuntimeGap(
        observation({ workAttach: "up", mode: "remote" }),
        "check",
      ),
    ).toBe("ready");
    expect(
      decideHostRuntimeGap(
        observation({ workAttach: "up", mode: "unenrolled" }),
        "check",
      ),
    ).toBe("stillTrying");
  });

  it("deploy installs when the package is absent", () => {
    expect(
      decideHostRuntimeGap(observation({ package: "absent" }), "deploy"),
    ).toBe("needInstall");
  });

  it("enrolled Remote with a missing package is restart, not pair", () => {
    expect(
      decideHostRuntimeGap(
        observation({
          package: "absent",
          mode: "remote",
          priorInstallationId: "station-remote-a",
        }),
        "deploy",
      ),
    ).toBe("needRestart");
  });

  it("deploy configures a first install and restarts an enrolled Remote", () => {
    expect(decideHostRuntimeGap(observation({}), "deploy")).toBe(
      "needConfigure",
    );
    expect(
      decideHostRuntimeGap(
        observation({
          mode: "remote",
          priorInstallationId: "station-remote-a",
        }),
        "deploy",
      ),
    ).toBe("needRestart");
  });

  it("does not mix Linux absence into a Darwin observation", () => {
    const linux = observation({
      platform: "linux",
      hostId: "box-studio",
      package: "unknown",
      priorInstallationId: "station-box",
      mode: "remote",
    });
    expect(decideHostRuntimeGap(linux, "deploy")).toBe("needRestart");
  });

  it("operator blockers win over install", () => {
    expect(
      decideHostRuntimeGap(
        observation({
          package: "absent",
          blocker: {
            kind: "quit-app",
            detail: "Quit Vellum Command on this machine, then Deploy again.",
          },
        }),
        "deploy",
      ),
    ).toBe("needOperator");
    expect(
      hostRuntimeGapCopy("needOperator", {
        kind: "quit-app",
        detail: "Quit Vellum Command on this machine, then Deploy again.",
      }),
    ).toContain("Quit Vellum Command");
  });

  it("network down is still trying, not a fake ready or vacant", () => {
    expect(
      decideHostRuntimeGap(observation({ network: "down" }), "deploy"),
    ).toBe("stillTrying");
  });
});

describe("HostRuntime inversion", () => {
  it("Deploy goes through reconcile, not the old ceremony from the coordinator", () => {
    const coordinator = readFileSync(
      new URL("../src/main/vellum/hosts/operator-coordinator.ts", import.meta.url),
      "utf8",
    );
    expect(coordinator).toContain("hostRuntime");
    expect(coordinator).toContain(".reconcile(");
    expect(coordinator).not.toMatch(/hosts\s*\n?\s*\.deployConfiguredRemote/u);
  });

  it("keeps Darwin and Linux as separate platform adapters", () => {
    const darwin = readFileSync(
      new URL("../src/main/vellum/hosts/host-runtime-darwin.ts", import.meta.url),
      "utf8",
    );
    const linux = readFileSync(
      new URL("../src/main/vellum/hosts/host-runtime-linux.ts", import.meta.url),
      "utf8",
    );
    expect(darwin).toContain("remoteDarwinPackageExists");
    expect(darwin).not.toContain("workControlSocketPath");
    expect(darwin).not.toContain("applyConfiguredRemoteGap");
    expect(darwin).toContain("activateDarwinRemoteRuntimeForTarget");
    expect(darwin).toContain("probeRemoteWorkAttach");
    expect(linux).toContain("workControlSocketPath");
    expect(linux).not.toContain("remoteDarwinPackageExists");
    expect(linux).not.toContain("applyConfiguredRemoteGap");
    expect(linux).not.toContain("resolveRemoteDeploymentTarget");
    expect(linux).not.toContain("prepareRemoteDeployment");
    expect(linux).toContain("buildObservedRemoteDeploymentTarget");
    expect(linux).toContain("linuxRemoteDeploymentProvider");
    expect(linux).toContain("probeRemoteWorkAttach");
  });

  it("does not keep a shared applyConfiguredRemoteGap act", () => {
    expect(() =>
      readFileSync(
        new URL("../src/main/vellum/hosts/host-runtime-apply.ts", import.meta.url),
      ),
    ).toThrow();
  });
});
