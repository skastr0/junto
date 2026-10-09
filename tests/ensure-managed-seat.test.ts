import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Node, type Seat } from "../src/shared/model";
import { InstallationId } from "../src/shared/installation-id";
import { deriveActorSeatId } from "../src/main/junto/actor-seat-id";
import {
  ActorSeatOccupy,
  type ActorOccupySpec,
} from "../src/main/junto/term/actor-seat-occupy";
import * as seatSessionBeforeStart from "../src/main/junto/term/seat-session-before-start";
import { termPlane } from "../src/main/junto/term/plane";
import {
  AUTO_RESTART_BACKOFF_MS,
  AUTO_RESTART_MAX,
  ensureManagedSeatRunning,
  managedSeatWakeDecision,
  resetAutoRestartBudgetsForTest,
} from "../src/main/junto/term/ensure-managed-seat";

const base = {
  stopping: false,
  exitReason: undefined,
  budget: undefined,
  nowMs: 1_000_000,
} as const;

describe("managed-seat wake decision", () => {
  it("spawns the initial generation for a binding the host has never seen", () => {
    expect(managedSeatWakeDecision({ ...base, status: undefined })).toEqual({
      kind: "spawn",
      restart: false,
    });
  });

  it("reuses a live generation", () => {
    expect(managedSeatWakeDecision({ ...base, status: "starting" })).toEqual({
      kind: "reuse",
    });
    expect(managedSeatWakeDecision({ ...base, status: "running" })).toEqual({
      kind: "reuse",
    });
  });

  it("a stopped seat revives on demand once its process is gone — one rule, mail wakes seats", () => {
    expect(
      managedSeatWakeDecision({ ...base, status: "exited", stopping: true }),
    ).toEqual({ kind: "spawn", restart: true });
  });

  it("mid-exit refuses transiently — never two processes on one binding", () => {
    expect(
      managedSeatWakeDecision({ ...base, status: "running", stopping: true }).kind,
    ).toBe("refuse");
    expect(
      managedSeatWakeDecision({ ...base, status: "starting", stopping: true }).kind,
    ).toBe("refuse");
  });

  it("a pre-ownership spawn failure is not respawned", () => {
    for (const exitReason of ["cli-missing", "spawn_failed"] as const) {
      const decision = managedSeatWakeDecision({
        ...base,
        status: "exited",
        exitReason,
      });
      expect(decision.kind).toBe("refuse");
    }
  });

  it("an exited generation restarts automatically — mail is a demand signal", () => {
    expect(managedSeatWakeDecision({ ...base, status: "exited" })).toEqual({
      kind: "spawn",
      restart: true,
    });
  });

  it("restarts back off between attempts", () => {
    const afterFirst = {
      ...base,
      status: "exited" as const,
      budget: { restarts: 1, lastRestartAtMs: base.nowMs - 1_000 },
    };
    expect(managedSeatWakeDecision(afterFirst).kind).toBe("refuse");
    const pastBackoff = {
      ...afterFirst,
      budget: {
        restarts: 1,
        lastRestartAtMs: base.nowMs - AUTO_RESTART_BACKOFF_MS[1] - 1,
      },
    };
    expect(managedSeatWakeDecision(pastBackoff)).toEqual({
      kind: "spawn",
      restart: true,
    });
  });

  it("the budget converges: after the cap, only an operator restart remains", () => {
    const decision = managedSeatWakeDecision({
      ...base,
      status: "exited",
      budget: { restarts: AUTO_RESTART_MAX, lastRestartAtMs: 0 },
    });
    expect(decision.kind).toBe("refuse");
  });

  it("unknown remote generation state is not spawned", () => {
    expect(
      managedSeatWakeDecision({ ...base, status: "missing" }).kind,
    ).toBe("refuse");
  });
});

const managedNode = (): Seat => Schema.decodeUnknownSync(Node)({
  id: "actor", kind: "agent", x: 0, y: 0, width: 240, height: 100, z: 0,
  label: "actor", agentKey: "box-a:codex", host: "box-a", bindingId: "binding-alpha", harness: "codex",
  overseer: false, onRemove: "detach",
}) as Seat;

const managedFixture = () => {
  const node = managedNode();
  const installationId = Schema.decodeUnknownSync(InstallationId)("install-a");
  return {
    node,
    authority: {
      actor: {
        seatId: deriveActorSeatId(installationId, "binding-alpha"),
        canvasName: "factory",
        nodeId: node.id,
      },
      installationId,
      hostId: "box-a",
    },
  };
};

const runningSummary = {
  bindingId: "binding-alpha",
  epoch: "generation-1",
  hostId: "box-a",
  status: "running",
  detached: false,
  createdAt: 1,
} as const;

describe("managed-seat occupation", () => {
  beforeEach(() => {
    vi.spyOn(seatSessionBeforeStart, "ensureSeatSessionId").mockResolvedValue({ ok: true, sessionId: "", minted: false });
  });
  afterEach(() => vi.restoreAllMocks());
  it("routes a vacant spawn through ActorSeatOccupy", async () => {
    resetAutoRestartBudgetsForTest();
    const fixture = managedFixture();
    const get = vi.spyOn(termPlane.host, "get").mockReturnValue(undefined);
    const occupy = vi.fn((_spec: ActorOccupySpec) =>
      Effect.succeed({
        ...runningSummary,
        harness: "codex",
        agentKey: "box-a:codex",
      }),
    );
    const actorSeatOccupy = ActorSeatOccupy.of({
      occupy,
      occupancy: () => Effect.die(new Error("unexpected occupancy call")),
    });

    try {
      expect(
        await Effect.runPromise(
          ensureManagedSeatRunning(
            "factory",
            fixture.node,
            fixture.authority,
            actorSeatOccupy,
          ),
        ),
      ).toBe(true);
      expect(occupy).toHaveBeenCalledOnce();
      expect(occupy).toHaveBeenCalledWith(
        expect.objectContaining({
          bindingId: "binding-alpha",
          hostId: "box-a",
          harness: "codex",
          agentKey: "box-a:codex",
        }),
      );
    } finally {
      get.mockRestore();
    }
  });

  it("routes a live geography occupant through ActorSeatOccupy for validation", async () => {
    resetAutoRestartBudgetsForTest();
    const fixture = managedFixture();
    const get = vi
      .spyOn(termPlane.host, "get")
      .mockReturnValue(runningSummary);
    const occupy = vi.fn((_spec: ActorOccupySpec) =>
      Effect.succeed({
        ...runningSummary,
        harness: "codex",
        agentKey: "box-a:codex",
      }),
    );
    const actorSeatOccupy = ActorSeatOccupy.of({
      occupy,
      occupancy: () => Effect.die(new Error("unexpected occupancy call")),
    });

    try {
      expect(
        await Effect.runPromise(
          ensureManagedSeatRunning(
            "factory",
            fixture.node,
            fixture.authority,
            actorSeatOccupy,
          ),
        ),
      ).toBe(true);
      expect(occupy).toHaveBeenCalledOnce();
      expect(occupy.mock.calls[0]?.[0]).toMatchObject({
        bindingId: "binding-alpha",
        harness: "codex",
        agentKey: "box-a:codex",
      });
    } finally {
      get.mockRestore();
    }
  });

  it("forwards the selected Amp launch to provisioning on an automatic first wake", async () => {
    resetAutoRestartBudgetsForTest();
    const fixture = managedFixture();
    const launch = { kind: "harness" as const, argv: ["amp", "--no-ide", "-m", "low"], cwd: "/work" };
    const node: Seat = { ...fixture.node, agentKey: "box-a:amp" as Seat["agentKey"], harness: "amp", launch };
    const provision = vi.spyOn(seatSessionBeforeStart, "ensureSeatSessionId").mockResolvedValue({
      ok: true,
      sessionId: "T-00000000-0000-4000-8000-000000000001",
      minted: true,
    });
    const get = vi.spyOn(termPlane.host, "get").mockReturnValue(undefined);
    const occupy = vi.fn((_spec: ActorOccupySpec) => Effect.succeed(runningSummary));
    const actorSeatOccupy = ActorSeatOccupy.of({
      occupy,
      occupancy: () => Effect.die(new Error("unexpected occupancy call")),
    });
    try {
      expect(await Effect.runPromise(ensureManagedSeatRunning(
        "factory",
        node,
        fixture.authority,
        actorSeatOccupy,
      ))).toBe(true);
      expect(provision).toHaveBeenCalledExactlyOnceWith({
        canvasName: "factory",
        nodeId: "actor",
        bindingId: "binding-alpha",
        harness: "amp",
        cwd: "/work",
        documentLaunch: launch,
      });
      expect(occupy).toHaveBeenCalledOnce();
    } finally {
      provision.mockRestore();
      get.mockRestore();
    }
  });
});
