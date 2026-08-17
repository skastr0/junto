import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import { deriveActorSeatId } from "../src/main/vellum/station/actor-seat-compiler";
import {
  ActorSeatOccupy,
  type ActorOccupySpec,
} from "../src/main/vellum/term/actor-seat-occupy";
import { termPlane } from "../src/main/vellum/term/plane";
import {
  AUTO_RESTART_BACKOFF_MS,
  AUTO_RESTART_MAX,
  ensureManagedSeatRunning,
  managedSeatWakeDecision,
  resetAutoRestartBudgetsForTest,
} from "../src/main/vellum/term/ensure-managed-seat";

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

const managedNode = (): CanvasNode => ({
  id: "actor",
  type: "text",
  x: 0,
  y: 0,
  width: 240,
  height: 100,
  text: "actor",
  ether: {
    entity: { kind: "agent", name: "box-a:codex" },
    host: "box-a",
    terminal: {
      bindingId: "binding-alpha",
      harness: "codex",
    },
  },
});

const managedFixture = () => {
  const node = managedNode();
  const doc: CanvasDoc = { nodes: [node], edges: [] };
  const installationId = Schema.decodeUnknownSync(InstallationId)("install-a");
  return {
    node,
    doc,
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
            fixture.doc,
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

  it("routes a live geography occupant through ActorSeatOccupy for adoption", async () => {
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
            fixture.doc,
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
});
