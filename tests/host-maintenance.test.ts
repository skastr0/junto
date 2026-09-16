/**
 * Maintenance authority on the live update path: an update of an incumbent
 * Remote acquires the terminal maintenance lease before any incumbent
 * mutation, refuses typed on active sessions with the fixed recovery action,
 * and releases the lease on every outcome.
 */
import { readFileSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/release-capabilities", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/shared/release-capabilities")
  >();
  return {
    ...actual,
    RELEASE_CAPABILITIES: Object.freeze({
      ...actual.RELEASE_CAPABILITIES,
      freshRemoteEnrollment: true,
      managedRemoteDeploy: true,
      darwinRemoteDeploy: true,
    }),
  };
});

/**
 * The live acquisition body dynamically imports the term plane for the
 * Command Center route cut and dials the Remote lease through
 * TermControlClient. Both are mocked at the module seam so the real
 * ordering (route cut, then home lookup, then token, then forward, then the
 * direct socket-bound lease, then the fence) executes in-process.
 */
const liveMocks = vi.hoisted(() => {
  const state = {
    events: [] as string[],
    routerAcquire: undefined as undefined | (() => Promise<unknown>),
    clientAcquire: undefined as undefined | (() => Promise<unknown>),
  };
  return state;
});

vi.mock("../src/main/junto/term/plane", () => ({
  termPlane: {
    router: {
      acquireRemoteHostMaintenance: async (hostId: string) => {
        liveMocks.events.push(`router-acquire:${hostId}`);
        if (liveMocks.routerAcquire === undefined) {
          throw new Error("router acquire not configured");
        }
        return liveMocks.routerAcquire();
      },
    },
  },
}));

vi.mock("../src/main/junto/term/control-client", () => ({
  TermControlClient: {
    connect: async () => {
      liveMocks.events.push("connect");
      return {
        acquireMaintenance: async () => {
          liveMocks.events.push("direct-acquire");
          if (liveMocks.clientAcquire === undefined) {
            throw new Error("client acquire not configured");
          }
          return liveMocks.clientAcquire();
        },
        close: () => {
          liveMocks.events.push("client-close");
        },
      };
    },
  },
}));
import { REMOTE_UPDATE_IDLE_PRODUCT_COPY } from "../src/shared/remote-update-status";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  HostMaintenanceAuthority,
  maintenanceRefusedDeployResult,
  makeLiveHostMaintenanceAuthority,
  withIncumbentMaintenance,
  type HostMaintenanceAcquireInput,
} from "../src/main/junto/hosts/maintenance";
import type { ConfiguredRemoteDeployResult } from "../src/main/junto/hosts/deploy-configured-remote";
import { HostRuntime, HostRuntimeLive } from "../src/main/junto/hosts/host-runtime";
import { HostsService } from "../src/main/junto/hosts/service";
import { SshTransport } from "../src/main/junto/ssh/service";
import { SshExitError } from "../src/main/junto/ssh/domain";
import { StationFleetTargetRepository } from "../src/main/junto/station/fleet-target-repository";
import { parseSshEndpoint } from "../src/main/junto/ssh/domain";

const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio-box",
  capabilities: ["terminal"],
};

const sshTarget = Effect.runSync(parseSshEndpoint("studio-box"));

const acquireInput: HostMaintenanceAcquireInput = {
  host,
  sshTarget,
  workAttach: "up",
  platform: "darwin",
};

const readyResult: ConfiguredRemoteDeployResult = {
  ok: true,
  detail: "updated",
  stages: [],
  disposition: "ready",
  outcome: "ready",
  packageState: "present",
  role: "remote",
  configuration: { ok: true, detail: "configure skipped" },
};

const stub = <Tag extends Context.Service<any, any>>(
  tag: Tag,
): Context.Service.Shape<Tag> => ({}) as Context.Service.Shape<Tag>;

describe("withIncumbentMaintenance", () => {
  it("refuses typed on active sessions without running apply", async () => {
    const apply = vi.fn(() => Effect.succeed(readyResult));
    const result = await Effect.runPromise(
      withIncumbentMaintenance(
        {
          acquire: () =>
            Effect.succeed({
              acquired: false as const,
              reason: "active-terminal-sessions" as const,
              detail: "busy",
              activeTerminalSessions: 2,
            }),
        },
        acquireInput,
        () => undefined,
        Effect.suspend(apply),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("conflict");
    expect(result.detail).toContain(REMOTE_UPDATE_IDLE_PRODUCT_COPY);
    expect(result.recoveryAction).toEqual({
      kind: "close-active-junto-terminals",
      activeTerminalSessions: 2,
    });
    // Incumbent untouched: mutation never started.
    expect(result.disposition).toBe("not-started");
    expect(result.packageState).toBe("previous");
    expect(apply).not.toHaveBeenCalled();
  });

  it("holds the lease across apply and releases on success", async () => {
    const events: string[] = [];
    const stages: string[] = [];
    const authority = {
      acquire: (_input: HostMaintenanceAcquireInput) =>
        Effect.gen(function* () {
          events.push("acquired");
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              events.push("released");
            }),
          );
          return {
            acquired: true as const,
            stages: ["Paused new terminal sessions for this update"],
          };
        }),
    };
    const result = await Effect.runPromise(
      withIncumbentMaintenance(
        authority,
        acquireInput,
        (stage) => stages.push(stage),
        Effect.sync(() => {
          events.push("apply");
          return readyResult;
        }),
      ),
    );
    expect(result.ok).toBe(true);
    expect(events).toEqual(["acquired", "apply", "released"]);
    expect(stages).toEqual(["Paused new terminal sessions for this update"]);
  });

  it("releases the lease when apply fails", async () => {
    const events: string[] = [];
    const authority = {
      acquire: (_input: HostMaintenanceAcquireInput) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              events.push("released");
            }),
          );
          return { acquired: true as const, stages: [] };
        }),
    };
    await expect(
      Effect.runPromise(
        withIncumbentMaintenance(
          authority,
          acquireInput,
          () => undefined,
          Effect.die(new Error("apply exploded")),
        ),
      ),
    ).rejects.toThrow(/apply exploded/u);
    expect(events).toEqual(["released"]);
  });

  it("releases the lease when the maintained apply refuses", async () => {
    const events: string[] = [];
    const authority = {
      acquire: (_input: HostMaintenanceAcquireInput) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              events.push("released");
            }),
          );
          return { acquired: true as const, stages: [] };
        }),
    };
    const result = await Effect.runPromise(
      withIncumbentMaintenance(
        authority,
        acquireInput,
        () => undefined,
        Effect.succeed({
          ...readyResult,
          ok: false,
          outcome: "failed" as const,
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(events).toEqual(["released"]);
  });
});

describe("maintenanceRefusedDeployResult", () => {
  it("maps held and shutdown refusals to conflict without a recovery action", () => {
    const held = maintenanceRefusedDeployResult(host, {
      acquired: false,
      reason: "maintenance-held",
      detail: "held",
    });
    expect(held.code).toBe("conflict");
    expect(held.detail).toContain("another update is already holding");
    expect(held.recoveryAction).toBeUndefined();

    const shutdown = maintenanceRefusedDeployResult(host, {
      acquired: false,
      reason: "shutting-down",
      detail: "stopping",
    });
    expect(shutdown.detail).toContain("shutting down");
    expect(shutdown.recoveryAction).toBeUndefined();

    const unavailable = maintenanceRefusedDeployResult(host, {
      acquired: false,
      reason: "unavailable",
      detail: "Studio: could not acquire Remote terminal maintenance",
    });
    expect(unavailable.detail).toContain("could not acquire");
  });
});

describe("live maintenance authority observation shortcuts", () => {
  const deadSsh = {
    run: () => Effect.die("no ssh expected"),
    forward: () => Effect.die("no forward expected"),
  } as never;

  it("proceeds lease-free when the Remote terminal plane is down", async () => {
    const authority = makeLiveHostMaintenanceAuthority(deadSsh);
    const admission = await Effect.runPromise(
      Effect.scoped(authority.acquire({ ...acquireInput, workAttach: "down" })),
    );
    expect(admission.acquired).toBe(true);
    if (!admission.acquired) return;
    expect(admission.stages.join(" ")).toContain("no live terminal to pause");
  });

  it("fails closed when the terminal plane state is unknown", async () => {
    const authority = makeLiveHostMaintenanceAuthority(deadSsh);
    const admission = await Effect.runPromise(
      Effect.scoped(
        authority.acquire({ ...acquireInput, workAttach: "unknown" }),
      ),
    );
    expect(admission.acquired).toBe(false);
    if (admission.acquired) return;
    expect(admission.reason).toBe("unavailable");
    expect(admission.detail).toContain("could not determine");
  });
});

describe("live maintenance acquisition body", () => {
  const routeCutLease = () => ({
    release: () => {
      liveMocks.events.push("router-release");
    },
  });

  const liveSsh = () => {
    // Programs are opaque handles; the body runs exactly two one-shots in a
    // fixed order: home lookup, then the term control token read.
    let runs = 0;
    return {
    run: () =>
      Effect.sync(() => {
        runs += 1;
        if (runs === 1) {
          liveMocks.events.push("home-lookup");
          return { stdout: "/Users/op\n", stderr: "" };
        }
        liveMocks.events.push("token-read");
        return { stdout: "term-token\n", stderr: "" };
      }),
    forward: () =>
      Effect.sync(() => {
        liveMocks.events.push("forward");
        return { localSocket: "/tmp/vt-maint.sock", close: () => undefined };
      }),
    };
  };

  const directLease = () => ({
    release: async () => {
      liveMocks.events.push("direct-release");
    },
    acknowledgeFence: async () => {
      liveMocks.events.push("fence");
      return { state: "released" };
    },
  });

  const configure = (over: {
    readonly routerAcquire?: () => Promise<unknown>;
    readonly clientAcquire?: () => Promise<unknown>;
  }) => {
    liveMocks.events.length = 0;
    liveMocks.routerAcquire =
      over.routerAcquire ??
      (async () => ({
        acquired: true,
        evidence: { activeTerminalSessions: 0, observationId: "tm_route" },
        lease: routeCutLease(),
      }));
    liveMocks.clientAcquire =
      over.clientAcquire ??
      (async () => ({
        acquired: true,
        evidence: { activeTerminalSessions: 0, observationId: "tm_direct" },
        lease: directLease(),
      }));
  };

  it("cuts the route before the direct lease and releases everything in reverse", async () => {
    configure({});
    const authority = makeLiveHostMaintenanceAuthority(liveSsh() as never);

    const admission = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* authority.acquire(acquireInput);
          liveMocks.events.push("held");
          return acquired;
        }),
      ),
    );

    expect(admission.acquired).toBe(true);
    if (!admission.acquired) return;
    expect(admission.stages).toEqual([
      "Paused new terminal sessions for this update",
      "Holding terminal sessions closed while Junto updates",
      "Locked the installed Junto for replacement",
    ]);
    // The Command Center route cut must land before the direct socket-bound
    // lease is dialed, and every hold releases when the scope closes.
    expect(liveMocks.events).toEqual([
      "router-acquire:studio",
      "home-lookup",
      "token-read",
      "forward",
      "connect",
      "direct-acquire",
      "held",
      "direct-release",
      "client-close",
      "router-release",
    ]);
  });

  it("acknowledges the release fence through the held lease on Linux", async () => {
    configure({});
    const authority = makeLiveHostMaintenanceAuthority(liveSsh() as never);

    const admission = await Effect.runPromise(
      Effect.scoped(
        authority.acquire({ ...acquireInput, platform: "linux" }),
      ),
    );

    expect(admission.acquired).toBe(true);
    expect(liveMocks.events).toContain("fence");
    expect(
      liveMocks.events.indexOf("fence"),
    ).toBeGreaterThan(liveMocks.events.indexOf("direct-acquire"));
  });

  it("maps a direct-lease active-sessions refusal typed and releases the route cut", async () => {
    configure({
      clientAcquire: async () => ({
        acquired: false,
        reason: "active_sessions",
        evidence: { activeTerminalSessions: 2 },
      }),
    });
    const authority = makeLiveHostMaintenanceAuthority(liveSsh() as never);

    const admission = await Effect.runPromise(
      Effect.scoped(authority.acquire(acquireInput)),
    );

    expect(admission.acquired).toBe(false);
    if (admission.acquired) return;
    expect(admission.reason).toBe("active-terminal-sessions");
    expect(admission.activeTerminalSessions).toBe(2);
    expect(liveMocks.events).toContain("router-release");
  });

  it("refuses unavailable when the route cut itself cannot be acquired", async () => {
    configure({
      routerAcquire: async () => {
        throw new Error("no route to studio");
      },
    });
    const authority = makeLiveHostMaintenanceAuthority(liveSsh() as never);

    const admission = await Effect.runPromise(
      Effect.scoped(authority.acquire(acquireInput)),
    );

    expect(admission.acquired).toBe(false);
    if (admission.acquired) return;
    expect(admission.reason).toBe("unavailable");
    expect(admission.detail).toContain("no route to studio");
    // The direct lease is never dialed when the route cut fails.
    expect(liveMocks.events).not.toContain("connect");
  });
});

describe("reconcile injects maintenance for an incumbent update", () => {
  const hostPlatform = process.platform;

  beforeEach(() => {
    // A Darwin Remote is only admitted when the Command Center itself runs on
    // macOS (local .app source). This Linux test sandbox stubs the platform so
    // the reconcile flow reaches the maintenance authority under test.
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: hostPlatform });
  });

  it("refuses the update typed and leaves the incumbent untouched", async () => {
    let runs = 0;
    const acquire = vi.fn((_input: HostMaintenanceAcquireInput) =>
      Effect.succeed({
        acquired: false as const,
        reason: "active-terminal-sessions" as const,
        detail: "busy",
        activeTerminalSessions: 3,
      }),
    );
    const ssh = {
      warm: () => Effect.void,
      run: () => {
        runs += 1;
        if (runs === 1) {
          return Effect.succeed({ stdout: "Darwin\n", stderr: "" });
        }
        if (runs === 2) {
          return Effect.succeed({ stdout: "/Users/op\n", stderr: "" });
        }
        if (runs === 9) {
          // term control token read: missing file
          return Effect.fail(
            new SshExitError({
              endpoint: "studio-box",
              operation: "cat",
              code: 1,
            }),
          );
        }
        return Effect.succeed({ stdout: "", stderr: "" });
      },
      forward: () => Effect.die("observe must not forward"),
      transfer: () => Effect.die("refused update must not copy"),
    };
    const layer = Layer.provideMerge(
      HostRuntimeLive,
      Layer.mergeAll(
        Layer.succeed(HostsService, {
          ...stub(HostsService),
          get: () => Effect.succeed(host),
        }),
        Layer.succeed(SshTransport, ssh as never),
        Layer.succeed(StationFleetTargetRepository, {
          ...stub(StationFleetTargetRepository),
          get: () =>
            Effect.succeed({
              hostId: host.id,
              stationInstallationId: "station-prior",
              boundAt: "2026-01-01T00:00:00.000Z",
            } as never),
        }),
        Layer.succeed(
          HostMaintenanceAuthority,
          HostMaintenanceAuthority.of({ acquire }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* HostRuntime;
        return yield* runtime.reconcile("studio", {
          intent: "deploy",
          configure: {
            commandCenterInstallationId: "command-center" as never,
            appVersion: "0.0.0",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(acquire).toHaveBeenCalledOnce();
    const input = acquire.mock.calls[0]?.[0];
    expect(input?.host.id).toBe("studio");
    expect(input?.platform).toBe("darwin");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("conflict");
    expect(result.detail).toContain(REMOTE_UPDATE_IDLE_PRODUCT_COPY);
    expect(result.recoveryAction).toEqual({
      kind: "close-active-junto-terminals",
      activeTerminalSessions: 3,
    });
    expect(result.disposition).toBe("not-started");
    expect(result.packageState).toBe("previous");
    // Observation probes only; the incumbent mutation never started.
    expect(runs).toBeLessThanOrEqual(9);
  });

  it("acquires the lease for every installed incumbent, never bare first installs", () => {
    const runtime = readFileSync(
      new URL("../src/main/junto/hosts/host-runtime.ts", import.meta.url),
      "utf8",
    );
    // needRestart = enrolled update; needConfigure = installed-but-unenrolled
    // incumbent replacement. Both quit the running package, so both hold the
    // lease. Only needInstall (package absent) has no incumbent to protect.
    expect(runtime).toMatch(
      /gap === "needRestart" \|\| gap === "needConfigure"\s*\?\s*yield\* withIncumbentMaintenance/u,
    );
    expect(runtime).not.toMatch(
      /gap === "needInstall"[^\n]*withIncumbentMaintenance/u,
    );
  });

  it("refuses an installed-but-unenrolled incumbent replacement while terminals are active", async () => {
    // Same reconcile flow as above, but with no fleet-target binding: the gap
    // resolves to needConfigure, and the replacement of the running incumbent
    // must still pass through the maintenance authority.
    let runs = 0;
    const acquire = vi.fn((_input: HostMaintenanceAcquireInput) =>
      Effect.succeed({
        acquired: false as const,
        reason: "active-terminal-sessions" as const,
        detail: "busy",
        activeTerminalSessions: 1,
      }),
    );
    const ssh = {
      warm: () => Effect.void,
      run: () => {
        runs += 1;
        if (runs === 1) {
          return Effect.succeed({ stdout: "Darwin\n", stderr: "" });
        }
        if (runs === 2) {
          return Effect.succeed({ stdout: "/Users/op\n", stderr: "" });
        }
        if (runs === 9) {
          return Effect.fail(
            new SshExitError({
              endpoint: "studio-box",
              operation: "cat",
              code: 1,
            }),
          );
        }
        return Effect.succeed({ stdout: "", stderr: "" });
      },
      forward: () => Effect.die("observe must not forward"),
      transfer: () => Effect.die("refused update must not copy"),
    };
    const layer = Layer.provideMerge(
      HostRuntimeLive,
      Layer.mergeAll(
        Layer.succeed(HostsService, {
          ...stub(HostsService),
          get: () => Effect.succeed(host),
        }),
        Layer.succeed(SshTransport, ssh as never),
        Layer.succeed(StationFleetTargetRepository, {
          ...stub(StationFleetTargetRepository),
          get: () => Effect.succeed(undefined),
        }),
        Layer.succeed(
          HostMaintenanceAuthority,
          HostMaintenanceAuthority.of({ acquire }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* HostRuntime;
        return yield* runtime.reconcile("studio", {
          intent: "deploy",
          configure: {
            commandCenterInstallationId: "command-center" as never,
            appVersion: "0.0.0",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(acquire).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("conflict");
    expect(result.recoveryAction).toEqual({
      kind: "close-active-junto-terminals",
      activeTerminalSessions: 1,
    });
    expect(result.disposition).toBe("not-started");
  });
});
