/**
 * Maintenance authority on the live update path: an update of an incumbent
 * Remote acquires the terminal maintenance lease before any incumbent
 * mutation, refuses typed on active sessions with the fixed recovery action,
 * and releases the lease on every outcome.
 */
import { readFileSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { REMOTE_UPDATE_IDLE_PRODUCT_COPY } from "../src/shared/remote-update-status";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  HostMaintenanceAuthority,
  maintenanceRefusedDeployResult,
  makeLiveHostMaintenanceAuthority,
  withIncumbentMaintenance,
  type HostMaintenanceAcquireInput,
} from "../src/main/vellum/hosts/maintenance";
import type { ConfiguredRemoteDeployResult } from "../src/main/vellum/hosts/deploy-configured-remote";
import { HostRuntime, HostRuntimeLive } from "../src/main/vellum/hosts/host-runtime";
import { HostsService } from "../src/main/vellum/hosts/service";
import { SshTransport } from "../src/main/vellum/ssh/service";
import { SshExitError } from "../src/main/vellum/ssh/domain";
import { StationFleetTargetRepository } from "../src/main/vellum/station/fleet-target-repository";
import { parseSshEndpoint } from "../src/main/vellum/ssh/domain";

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
      kind: "close-active-vellum-terminals",
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
            stages: ["terminal route cut held observation=tm_test"],
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
    expect(stages).toEqual(["terminal route cut held observation=tm_test"]);
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
    expect(held.detail).toContain("terminal route cut");
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

describe("reconcile injects maintenance for an incumbent update", () => {
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
      kind: "close-active-vellum-terminals",
      activeTerminalSessions: 3,
    });
    expect(result.disposition).toBe("not-started");
    expect(result.packageState).toBe("previous");
    // Observation probes only; the incumbent mutation never started.
    expect(runs).toBeLessThanOrEqual(9);
  });

  it("acquires the lease only for incumbent updates, never first installs", () => {
    const runtime = readFileSync(
      new URL("../src/main/vellum/hosts/host-runtime.ts", import.meta.url),
      "utf8",
    );
    expect(runtime).toMatch(
      /gap === "needRestart"\s*\?\s*yield\* withIncumbentMaintenance/u,
    );
  });
});
