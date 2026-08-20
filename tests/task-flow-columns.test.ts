import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc, type Task } from "../src/shared/canvas";
import {
  arrivalGlance,
  formatHoldCountdown,
  groupOutboundPassages,
  hasPendingHold,
  localPassage,
  pipelineShape,
} from "../src/renderer/components/work/task-flow-columns";

// Pure column derivation for the task flow modal (Inbound / Outbound).

const sink = (id: string) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "task", name: id } },
});

const flowEdge = (id: string, fromNode: string, toNode: string) => ({
  id,
  fromNode,
  toNode,
  ether: { flow: { source: fromNode, destination: toNode } },
});

const doc = (nodes: string[], edges: unknown[]): CanvasDoc =>
  Result.getOrThrow(decodeCanvasDoc({ nodes: nodes.map(sink), edges }));

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

const task = (id: string, fields: Partial<Task> = {}): Task => ({
  id,
  state: "submitted",
  history: [
    {
      messageId: `m-${id}`,
      role: "agent",
      parts: [{ kind: "text", text: id }],
    },
  ],
  ...fields,
}) as Task;

describe("pipelineShape", () => {
  it("reports inbound and outbound sides from flow edges", () => {
    const d = doc(
      ["intake", "build", "review", "ship"],
      [
        flowEdge("e1", "intake", "build"),
        flowEdge("e2", "build", "review"),
        flowEdge("e3", "build", "ship"),
      ],
    );
    expect(pipelineShape(d, "intake")).toEqual({
      sources: [],
      destinations: ["build"],
      hasInbound: false,
      hasOutbound: true,
    });
    expect(pipelineShape(d, "build")).toEqual({
      sources: ["intake"],
      destinations: ["review", "ship"],
      hasInbound: true,
      hasOutbound: true,
    });
    expect(pipelineShape(d, "ship")).toEqual({
      sources: ["build"],
      destinations: [],
      hasInbound: true,
      hasOutbound: false,
    });
  });

  it("leaves a sink with no flow edges on the plain board", () => {
    const d = doc(["solo"], []);
    expect(pipelineShape(d, "solo")).toEqual({
      sources: [],
      destinations: [],
      hasInbound: false,
      hasOutbound: false,
    });
  });
});

describe("formatHoldCountdown", () => {
  it("scales the unit with the time left", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(formatHoldCountdown(at(8_000), NOW)).toBe("8s");
    expect(formatHoldCountdown(at(260_000), NOW)).toBe("4m 20s");
    expect(formatHoldCountdown(at(3_900_000), NOW)).toBe("1h 05m");
    expect(formatHoldCountdown(at(2 * 86_400_000 + 3 * 3_600_000), NOW)).toBe("2d 3h");
  });

  it("goes quiet with no hold, an elapsed hold, or an unparseable stamp", () => {
    expect(formatHoldCountdown(undefined, NOW)).toBeUndefined();
    expect(formatHoldCountdown(new Date(NOW - 1000).toISOString(), NOW)).toBeUndefined();
    expect(formatHoldCountdown("not-a-time", NOW)).toBeUndefined();
  });
});

describe("arrivalGlance", () => {
  it("counts down a held arrival", () => {
    const glance = arrivalGlance(
      task("t1", { holdUntil: new Date(NOW + 90_000).toISOString() }),
      undefined,
      NOW,
    );
    expect(glance.admission).toBe("held");
    expect(glance.countdown).toBe("1m 30s");
    expect(glance.promotable).toBe(false);
  });

  it("marks an operator-gated arrival promotable until it is promoted", () => {
    const contract = { inbound: { admission: "operator-gated" as const } };
    const pending = arrivalGlance(task("t2"), contract, NOW);
    expect(pending.admission).toBe("operator-gated");
    expect(pending.promotable).toBe(true);
    const promoted = arrivalGlance(
      task("t2", { metadata: { "vellum.pipeline.admittedEpoch": 0 } }),
      contract,
      NOW,
    );
    expect(promoted.admission).toBe("claimable");
    expect(promoted.promotable).toBe(false);
  });

  it("never offers promotion on an operator-owned station", () => {
    const glance = arrivalGlance(
      task("t3"),
      { inbound: { admission: "operator-owned" } },
      NOW,
    );
    expect(glance.admission).toBe("operator-owned");
    expect(glance.promotable).toBe(false);
  });

  it("reports a claimable arrival on a plain station", () => {
    expect(arrivalGlance(task("t4"), undefined, NOW).admission).toBe("claimable");
  });
});

describe("hasPendingHold", () => {
  it("is true only while some arrival still bakes", () => {
    const held = task("t1", { holdUntil: new Date(NOW + 5_000).toISOString() });
    const elapsed = task("t2", { holdUntil: new Date(NOW - 5_000).toISOString() });
    expect(hasPendingHold([elapsed, held], NOW)).toBe(true);
    expect(hasPendingHold([elapsed], NOW)).toBe(false);
    expect(hasPendingHold([], NOW)).toBe(false);
  });
});

describe("groupOutboundPassages", () => {
  const passage = (
    nodeId: string,
    exit: "forwarded" | "closed" | "rejected-back",
    next?: string,
  ) => ({
    nodeId,
    enteredAt: new Date(NOW).toISOString(),
    epoch: 0,
    exitedAt: new Date(NOW).toISOString(),
    exit,
    ...(next !== undefined ? { next } : {}),
  });

  it("groups by destination in flow-edge order, then returns, then closed", () => {
    const forwardedShip = task("a", {
      journey: [passage("build", "forwarded", "ship")],
    });
    const closedHere = task("b", { journey: [passage("build", "closed")] });
    const forwardedReview = task("c", {
      journey: [passage("build", "forwarded", "review")],
    });
    const returned = task("d", {
      journey: [passage("build", "rejected-back", "intake")],
    });
    const groups = groupOutboundPassages(
      [forwardedShip, closedHere, forwardedReview, returned],
      "build",
      ["review", "ship"],
    );
    expect(groups.map((group) => group.key)).toEqual([
      "forwarded:review",
      "forwarded:ship",
      "returned:intake",
      "closed",
    ]);
    expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(["c"]);
    expect(groups[3]?.kind).toBe("closed");
  });

  it("keeps work with no passage record in the closed group", () => {
    const groups = groupOutboundPassages([task("a")], "build", ["review"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("closed");
    expect(groups[0]?.stationId).toBeUndefined();
  });

  it("preserves task order inside a group", () => {
    const first = task("a", { journey: [passage("build", "forwarded", "review")] });
    const second = task("b", { journey: [passage("build", "forwarded", "review")] });
    const groups = groupOutboundPassages([first, second], "build", ["review"]);
    expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("localPassage", () => {
  it("reads the last exited passage at this station", () => {
    const journey = [
      {
        nodeId: "build",
        enteredAt: new Date(NOW).toISOString(),
        epoch: 0,
        exitedAt: new Date(NOW).toISOString(),
        exit: "forwarded" as const,
        next: "review",
      },
      {
        nodeId: "review",
        enteredAt: new Date(NOW).toISOString(),
        epoch: 0,
      },
    ];
    expect(localPassage(task("a", { journey }), "build")?.next).toBe("review");
    expect(localPassage(task("a", { journey }), "review")).toBeUndefined();
  });
});
