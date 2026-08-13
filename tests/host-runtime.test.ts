import { readFileSync } from "node:fs";
import { Context, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  classifyHostRuntimeBlocker,
  decideHostRuntimeGap,
  HOST_RUNTIME_HARD_BLOCKER_COPY,
  HostRuntimeObservation,
  hostRuntimeGapCopy,
} from "../src/shared/host-runtime";
import {
  LINUX_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
} from "../src/shared/release-capabilities";
import { InstallationId } from "../src/shared/station-api";
import {
  admitHostRuntimeApply,
  checkHostRuntime,
  HostRuntime,
  HostRuntimeLive,
  observeRemoteHost,
} from "../src/main/vellum/hosts/host-runtime";
import { linuxHostRuntimePlatform } from "../src/main/vellum/hosts/host-runtime-linux";
import {
  combineHostProcessPlanes,
  readRemoteTextFile,
  workAttachFromTermConnect,
  workAttachFromTokenFile,
} from "../src/main/vellum/hosts/host-runtime-platform";
import { HostsService } from "../src/main/vellum/hosts/service";
import { StationFleetTargetRepository } from "../src/main/vellum/station/fleet-target-repository";
import {
  parseSshEndpoint,
  SshExitError,
  SshTimeoutError,
} from "../src/main/vellum/ssh/domain";
import { SshTransport } from "../src/main/vellum/ssh/service";
import type { RemoteHost } from "../src/shared/remote-hosts";

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
        observation({ workAttach: "up", mode: "command-center" }),
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

  it("Linux first install is needInstall when the generation is absent", () => {
    expect(
      decideHostRuntimeGap(
        observation({
          platform: "linux",
          hostId: "box-studio",
          package: "absent",
          mode: "unenrolled",
        }),
        "deploy",
      ),
    ).toBe("needInstall");
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
        detail: "ignored",
      }),
    ).toBe(HOST_RUNTIME_HARD_BLOCKER_COPY["quit-app"]);
    expect(classifyHostRuntimeBlocker("ENOSPC disk full")?.kind).toBe("disk");
    expect(
      classifyHostRuntimeBlocker("owner-local systemd user service is unavailable")
        ?.kind,
    ).toBe("login-session");
    expect(classifyHostRuntimeBlocker("Permission denied (publickey)")?.kind).toBe(
      "auth",
    );
  });

  it("network down is still trying, not a fake ready or vacant", () => {
    expect(
      decideHostRuntimeGap(observation({ network: "down" }), "deploy"),
    ).toBe("stillTrying");
  });

  it("network unknown is still trying, not down or needConfigure", () => {
    expect(
      decideHostRuntimeGap(observation({ network: "unknown" }), "deploy"),
    ).toBe("stillTrying");
    expect(
      decideHostRuntimeGap(observation({ network: "unknown" }), "check"),
    ).toBe("stillTrying");
  });
});

describe("checkHostRuntime", () => {
  it("is ready only after connect on remote or command-center", () => {
    const ready = checkHostRuntime(
      observation({ workAttach: "up", mode: "remote" }),
    );
    expect(ready.ok).toBe(true);
    expect(ready.detail).toBe(
      "Vellum Command can take work on this machine.",
    );
    expect(
      checkHostRuntime(observation({ workAttach: "up", mode: "unenrolled" }))
        .ok,
    ).toBe(false);
    expect(
      checkHostRuntime(observation({ workAttach: "unknown", mode: "remote" }))
        .ok,
    ).toBe(false);
  });
});

describe("combineHostProcessPlanes", () => {
  it("does not treat an unknown door as down", () => {
    expect(combineHostProcessPlanes("unknown", "down")).toBe("unknown");
    expect(combineHostProcessPlanes("down", "unknown")).toBe("unknown");
    expect(combineHostProcessPlanes("down", "down")).toBe("down");
    expect(combineHostProcessPlanes("up", "unknown")).toBe("up");
  });
});

describe("work attach token and connect", () => {
  const target = Effect.runSync(parseSshEndpoint("studio-box"));

  it("missing token file is down; timeout stays unknown", async () => {
    const missing = await Effect.runPromise(
      readRemoteTextFile(
        {
          run: () =>
            Effect.fail(
              new SshExitError({
                endpoint: "studio-box",
                operation: "cat",
                code: 1,
              }),
            ),
        } as never,
        target,
        "/Users/alice/.vellum-command/term/token",
      ),
    );
    expect(missing).toEqual({ _tag: "missing" });
    expect(workAttachFromTokenFile(missing)).toBe("down");

    const timedOut = await Effect.runPromise(
      readRemoteTextFile(
        {
          run: () =>
            Effect.fail(
              new SshTimeoutError({
                endpoint: "studio-box",
                operation: "cat",
                timeoutMs: 1_000,
              }),
            ),
        } as never,
        target,
        "/Users/alice/.vellum-command/term/token",
      ),
    );
    expect(timedOut).toEqual({ _tag: "unknown" });
    expect(workAttachFromTokenFile(timedOut)).toBe("unknown");
  });

  it("term connect refused is down; unexpected stays unknown", () => {
    const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    expect(workAttachFromTermConnect(refused)).toBe("down");
    expect(
      workAttachFromTermConnect(
        new Error("term control connect timeout: /tmp/sock"),
      ),
    ).toBe("down");
    expect(workAttachFromTermConnect(new Error("codesign helper crashed"))).toBe(
      "unknown",
    );
  });
});

describe("observeRemoteHost", () => {
  const host: RemoteHost = {
    id: "studio",
    label: "Studio",
    kind: "remote",
    sshEndpoint: "studio-box",
    capabilities: ["terminal"],
  };

  it("invalid SSH route is a blocker, not network down", async () => {
    const observed = await Effect.runPromise(
      observeRemoteHost(
        { run: () => Effect.die("ssh must not run") } as never,
        { ...host, sshEndpoint: "-bad" },
        { mode: "unenrolled" },
      ),
    );
    expect(observed.network).toBe("unknown");
    expect(observed.blocker?.kind).toBe("unsupported");
    expect(observed.workAttach).toBe("unknown");
  });

  it("auth refused is a blocker, not network down", async () => {
    const observed = await Effect.runPromise(
      observeRemoteHost(
        {
          run: () =>
            Effect.fail(
              new SshExitError({
                endpoint: "studio-box",
                operation: "uname",
                code: 255,
                detail: "permission denied",
              }),
            ),
        } as never,
        host,
        { mode: "unenrolled" },
      ),
    );
    expect(observed.network).not.toBe("down");
    expect(observed.blocker?.kind).toBe("auth");
    expect(observed.blocker?.detail).toBe(HOST_RUNTIME_HARD_BLOCKER_COPY.auth);
  });

  it("uname probe failure stays unknown, not down", async () => {
    const observed = await Effect.runPromise(
      observeRemoteHost(
        {
          run: () =>
            Effect.fail(
              new SshTimeoutError({
                endpoint: "studio-box",
                operation: "uname",
                timeoutMs: 1_000,
              }),
            ),
        } as never,
        host,
        { mode: "unenrolled" },
      ),
    );
    expect(observed.network).toBe("unknown");
    expect(observed.platform).toBe("unknown");
    expect(observed.blocker).toBeUndefined();
  });

  it("plane probe timeouts stay unknown, not down", async () => {
    let calls = 0;
    const observed = await Effect.runPromise(
      observeRemoteHost(
        {
          run: () => {
            calls += 1;
            if (calls === 1) {
              return Effect.succeed({ stdout: "Darwin\n", stderr: "" });
            }
            if (calls === 2) {
              return Effect.succeed({ stdout: "/Users/alice\n", stderr: "" });
            }
            return Effect.fail(
              new SshTimeoutError({
                endpoint: "studio-box",
                operation: "probe",
                timeoutMs: 1_000,
              }),
            );
          },
        } as never,
        host,
        { mode: "remote", priorInstallationId: "station-studio" },
      ),
    );
    expect(observed.network).toBe("up");
    expect(observed.platform).toBe("darwin");
    expect(observed.package).toBe("unknown");
    expect(observed.process).toBe("unknown");
    expect(observed.workAttach).toBe("unknown");
    expect(checkHostRuntime(observed).ok).toBe(false);
  });

  it("Linux package is present or absent from the userland generation, not always unknown", async () => {
    const present = await Effect.runPromise(
      observeRemoteHost(
        {
          run: (() => {
            let calls = 0;
            return () => {
              calls += 1;
              if (calls === 1) {
                return Effect.succeed({ stdout: "Linux\n", stderr: "" });
              }
              if (calls === 2) {
                return Effect.succeed({ stdout: "/home/alice\n", stderr: "" });
              }
              if (calls === 3) {
                return Effect.succeed({
                  stdout: "LINUX_USERLAND_OBSERVE_V1 present=1\n",
                  stderr: "",
                });
              }
              return Effect.fail(
                new SshTimeoutError({
                  endpoint: "studio-box",
                  operation: "probe",
                  timeoutMs: 1_000,
                }),
              );
            };
          })(),
        } as never,
        host,
        { mode: "unenrolled" },
      ),
    );
    expect(present.platform).toBe("linux");
    expect(present.package).toBe("present");
    expect(present.workAttach).toBe("unknown");
    expect(checkHostRuntime(present).ok).toBe(false);

    const absent = await Effect.runPromise(
      observeRemoteHost(
        {
          run: (() => {
            let calls = 0;
            return () => {
              calls += 1;
              if (calls === 1) {
                return Effect.succeed({ stdout: "Linux\n", stderr: "" });
              }
              if (calls === 2) {
                return Effect.succeed({ stdout: "/home/alice\n", stderr: "" });
              }
              if (calls === 3) {
                return Effect.succeed({
                  stdout: "LINUX_USERLAND_OBSERVE_V1 present=0\n",
                  stderr: "",
                });
              }
              return Effect.fail(
                new SshTimeoutError({
                  endpoint: "studio-box",
                  operation: "probe",
                  timeoutMs: 1_000,
                }),
              );
            };
          })(),
        } as never,
        host,
        { mode: "unenrolled" },
      ),
    );
    expect(absent.package).toBe("absent");
    expect(decideHostRuntimeGap(absent, "deploy")).toBe("needInstall");
  });
});

describe("linuxHostRuntimePlatform.observePlanes", () => {
  const target = Effect.runSync(parseSshEndpoint("studio-box"));
  const observeThenTimeout = (stdout: string) => {
    let calls = 0;
    return {
      run: () => {
        calls += 1;
        if (calls === 1) {
          return Effect.succeed({ stdout, stderr: "" });
        }
        return Effect.fail(
          new SshTimeoutError({
            endpoint: "studio-box",
            operation: "probe",
            timeoutMs: 1_000,
          }),
        );
      },
    } as never;
  };

  it("maps a generation receipt to present or absent, and probe failure to unknown", async () => {
    const present = await Effect.runPromise(
      linuxHostRuntimePlatform.observePlanes(
        observeThenTimeout("LINUX_USERLAND_OBSERVE_V1 present=1\n"),
        target,
        "/home/alice",
      ),
    );
    expect(present.package).toBe("present");
    expect(present.process).toBe("unknown");
    expect(present.workAttach).toBe("unknown");

    const absent = await Effect.runPromise(
      linuxHostRuntimePlatform.observePlanes(
        observeThenTimeout("LINUX_USERLAND_OBSERVE_V1 present=0\n"),
        target,
        "/home/alice",
      ),
    );
    expect(absent.package).toBe("absent");

    const unknown = await Effect.runPromise(
      linuxHostRuntimePlatform.observePlanes(
        {
          run: () =>
            Effect.fail(
              new SshTimeoutError({
                endpoint: "studio-box",
                operation: "observe",
                timeoutMs: 1_000,
              }),
            ),
        } as never,
        target,
        "/home/alice",
      ),
    );
    expect(unknown.package).toBe("unknown");
    expect(unknown.process).toBe("unknown");
    expect(unknown.workAttach).toBe("unknown");
  });

  it("does not treat a malformed generation receipt as absent", async () => {
    const planes = await Effect.runPromise(
      linuxHostRuntimePlatform.observePlanes(
        observeThenTimeout("garbage\n"),
        target,
        "/home/alice",
      ),
    );
    expect(planes.package).toBe("unknown");
  });
});

describe("admitHostRuntimeApply", () => {
  const linuxObservation = observation({
    platform: "linux",
    hostId: "studio",
    package: "absent",
  });
  const darwinObservation = observation({
    platform: "darwin",
    hostId: "studio",
    package: "absent",
  });

  it("lets a Linux Command Center apply a Linux Remote only when the flag is on", () => {
    const admitted = admitHostRuntimeApply({
      observation: linuxObservation,
      hostLabel: "Studio",
      commandCenterPlatform: "linux",
      release: { linuxRemoteDeploy: true, darwinRemoteDeploy: true },
    });
    expect(admitted).toEqual({ ok: true, platform: "linux" });
  });

  it("keeps linuxRemoteDeploy off and refuses Linux apply under production", () => {
    expect(RELEASE_CAPABILITIES.linuxRemoteDeploy).toBe(false);
    const fromLinuxCc = admitHostRuntimeApply({
      observation: linuxObservation,
      hostLabel: "Studio",
      commandCenterPlatform: "linux",
    });
    const fromDarwinCc = admitHostRuntimeApply({
      observation: linuxObservation,
      hostLabel: "Studio",
      commandCenterPlatform: "darwin",
    });
    expect(fromLinuxCc.ok).toBe(false);
    expect(fromDarwinCc.ok).toBe(false);
    if (fromLinuxCc.ok || fromDarwinCc.ok) return;
    expect(fromLinuxCc.detail).toBe(
      `Studio: ${LINUX_REMOTE_DEPLOY_DISABLED_DETAIL}`,
    );
    expect(fromDarwinCc.detail).toBe(fromLinuxCc.detail);
    expect(fromLinuxCc.code).toBe("validation");
  });

  it("refuses a Darwin Remote from a Linux Command Center after uname", () => {
    const admitted = admitHostRuntimeApply({
      observation: darwinObservation,
      hostLabel: "Studio",
      commandCenterPlatform: "linux",
      release: { linuxRemoteDeploy: true, darwinRemoteDeploy: true },
    });
    expect(admitted.ok).toBe(false);
    if (admitted.ok) return;
    expect(admitted.detail).toBe(
      "Studio: a Darwin Remote needs a macOS Command Center (local .app source)",
    );
    expect(admitted.code).toBe("validation");
  });

  it("does not treat an unknown platform as down or as a Linux apply", () => {
    const admitted = admitHostRuntimeApply({
      observation: observation({ platform: "unknown", package: "absent" }),
      hostLabel: "Studio",
      commandCenterPlatform: "linux",
      release: { linuxRemoteDeploy: true, darwinRemoteDeploy: true },
    });
    expect(admitted.ok).toBe(false);
    if (admitted.ok) return;
    expect(admitted.detail).not.toMatch(/Can't reach|network/u);
    expect(admitted.detail).not.toBe(
      `Studio: ${LINUX_REMOTE_DEPLOY_DISABLED_DETAIL}`,
    );
  });
});

describe("HostRuntimeLive Linux flag honesty", () => {
  const host: RemoteHost = {
    id: "studio",
    label: "Studio",
    kind: "remote",
    sshEndpoint: "studio-box",
    capabilities: ["terminal"],
  };
  const configure = {
    commandCenterInstallationId:
      Schema.decodeUnknownSync(InstallationId)("cc-installation"),
    appVersion: "0.1.0",
  };

  it("observes a Linux generation then refuses apply while the flag is off", async () => {
    expect(RELEASE_CAPABILITIES.linuxRemoteDeploy).toBe(false);
    let warmCalls = 0;
    let runs = 0;
    const stub = <Tag extends Context.Service<any, any>>(
      tag: Tag,
    ): Context.Service.Shape<Tag> => ({}) as Context.Service.Shape<Tag>;
    const layer = Layer.provideMerge(
      HostRuntimeLive,
      Layer.mergeAll(
        Layer.succeed(HostsService, {
          ...stub(HostsService),
          get: () => Effect.succeed(host),
        }),
        Layer.succeed(SshTransport, {
          ...stub(SshTransport),
          warm: () =>
            Effect.sync(() => {
              warmCalls += 1;
            }),
          run: () => {
            runs += 1;
            if (runs === 1) {
              return Effect.succeed({ stdout: "Linux\n", stderr: "" });
            }
            if (runs === 2) {
              return Effect.succeed({ stdout: "/home/alice\n", stderr: "" });
            }
            if (runs === 3) {
              return Effect.succeed({
                stdout: "LINUX_USERLAND_OBSERVE_V1 present=0\n",
                stderr: "",
              });
            }
            return Effect.fail(
              new SshTimeoutError({
                endpoint: "studio-box",
                operation: "probe",
                timeoutMs: 1_000,
              }),
            );
          },
        }),
        Layer.succeed(StationFleetTargetRepository, {
          ...stub(StationFleetTargetRepository),
          get: () => Effect.succeed(undefined),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* HostRuntime;
        return yield* runtime.reconcile("studio", {
          intent: "deploy",
          configure,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe(
      `Studio: ${LINUX_REMOTE_DEPLOY_DISABLED_DETAIL}`,
    );
    expect(result.code).toBe("validation");
    expect(result.disposition).toBe("not-started");
    expect(warmCalls).toBe(0);
    expect(runs).toBeGreaterThanOrEqual(3);
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
    const runtime = readFileSync(
      new URL("../src/main/vellum/hosts/host-runtime.ts", import.meta.url),
      "utf8",
    );
    expect(runtime).toContain("commandCenterMayPrepareRemote");
    expect(runtime).toContain("admitHostRuntimeApply");
    expect(runtime).toContain("releaseAllowsTargetPlatform");
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
    expect(darwin).toContain("TermControlClient.connect");
    expect(darwin).not.toContain("handshakeLinuxWorkControl");
    expect(darwin).not.toContain("remoteTestSocketExists");
    expect(darwin).toContain("combineHostProcessPlanes");
    expect(linux).toContain("workControlSocketPath");
    expect(linux).not.toContain("remoteDarwinPackageExists");
    expect(linux).not.toContain("applyConfiguredRemoteGap");
    expect(linux).not.toContain("resolveRemoteDeploymentTarget");
    expect(linux).not.toContain("prepareRemoteDeployment");
    expect(linux).not.toContain("TermControlClient");
    expect(linux).toContain("buildObservedRemoteDeploymentTarget");
    expect(linux).toContain("loadRemoteDeploymentProvider");
    expect(linux).not.toContain("linuxRemoteDeploymentProvider");
    expect(linux).toContain("activateLinuxRemoteRuntimeForTarget");
    expect(linux).toContain("observeLinuxUserlandPackage");
    expect(linux).toContain("handshakeLinuxWorkControl");
    expect(linux).toContain("proveWorkAttach");
    expect(linux).toContain("combineHostProcessPlanes");
    expect(linux).not.toMatch(/package:\s*"unknown" as const/u);
    expect(linux).not.toContain("linuxRemoteDeploy");
    const platform = readFileSync(
      new URL("../src/main/vellum/hosts/host-runtime-platform.ts", import.meta.url),
      "utf8",
    );
    expect(platform).toContain("handshakeLinuxWorkControl");
    expect(platform).not.toMatch(/sock\.once\("connect", \(\) => done\("up"\)\)/u);
  });

  it("does not keep a shared applyConfiguredRemoteGap act", () => {
    expect(() =>
      readFileSync(
        new URL("../src/main/vellum/hosts/host-runtime-apply.ts", import.meta.url),
      ),
    ).toThrow();
  });

  it("does not mint onAdmitted pre-mutation receipts", () => {
    const service = readFileSync(
      new URL("../src/main/vellum/hosts/service.ts", import.meta.url),
      "utf8",
    );
    const configured = readFileSync(
      new URL("../src/main/vellum/hosts/deploy-configured-remote.ts", import.meta.url),
      "utf8",
    );
    expect(service).not.toContain("onAdmitted");
    expect(configured).not.toContain("onAdmitted");
  });
});
