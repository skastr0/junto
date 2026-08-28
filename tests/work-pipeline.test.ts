import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type {
  ClaimDef,
  Task,
  TasksSinkContract,
  Ticket,
} from "../src/shared/work-model";
import {
  PIPELINE_ADMITTED_METADATA_KEY,
  sinkContractOf,
  taskAdmissionState,
  taskPromoted,
} from "../src/shared/claims";
import {
  WorkError,
  workTaskClaim,
  workTaskCreate,
  workTaskTransition,
} from "../src/shared/work";
import { Schema } from "effect";
import { ActorRef } from "../src/shared/work-protocol";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

const ids = (() => {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    messageId: () => `msg-${++n}`,
  };
})();

const actorRef = (digit: string, nodeId: string, canvasName = "alpha") =>
  Schema.decodeUnknownSync(ActorRef)({
    seatId: `seat_${digit.repeat(64)}`,
    canvasName,
    nodeId,
  });

const claim = (id: string, severity: "hard" | "soft" = "hard"): ClaimDef => ({
  id,
  text: `claim ${id}`,
  severity,
});

const sinkNode = (
  id: string,
  contract?: TasksSinkContract,
): CanvasNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 2000,
  y: 2000,
  width: 100,
  height: 60,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [],
      ...(contract !== undefined ? { contract } : {}),
    },
  },
});

const flowEdge = (id: string, source: string, destination: string) => ({
  id,
  fromNode: source,
  toNode: destination,
  ether: { verb: "feeds" as const },
});

const docWith = (
  nodes: ReadonlyArray<CanvasNode>,
  edges: CanvasDoc["edges"] = [],
): CanvasDoc => ({ nodes: [...nodes], edges: [...edges] });

const createTask = (doc: CanvasDoc, nodeId: string, brief = "ship it") =>
  workTaskCreate(doc, "alpha", nodeId, brief, { details: brief }, ids);

const itemsAt = (doc: CanvasDoc, nodeId: string): ReadonlyArray<Task> =>
  doc.nodes.find((node) => node.id === nodeId)?.ether?.tasks?.items ?? [];

describe("claims gate on completion", () => {
  it("refuses completion while a hard effective claim has no response", () => {
    const doc = docWith([sinkNode("s1", { claims: [claim("c1")] })]);
    const created = createTask(doc, "s1");
    expect(() =>
      workTaskTransition(
        created.doc,
        "alpha",
        "s1",
        created.task.id,
        "completed",
        undefined,
        ids,
      ),
    ).toThrow(/claims unsatisfied \[claims\].*c1/s);
  });

  it("completes once responses and soft waivers are on the evidence", () => {
    const doc = docWith([
      sinkNode("s1", { claims: [claim("c1"), claim("c2", "soft")] }),
    ]);
    const created = createTask(doc, "s1");
    const done = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      {
        artifacts: [],
        responses: [{ claimId: "c1", response: "verified by rerun" }],
        claimWaivers: [{ claimId: "c2", reason: "not relevant this pass" }],
      },
    );
    expect(done.task.state).toBe("completed");
    // Receipts survive into the stored evidence (passage record accounting).
    expect(done.task.completionEvidence?.responses?.[0]?.claimId).toBe("c1");
    expect(done.task.completionEvidence?.claimWaivers?.[0]?.claimId).toBe("c2");
  });
});

describe("forward", () => {
  const pipelineDoc = () =>
    docWith(
      [
        sinkNode("s1"),
        sinkNode("s2", { inbound: { claimableAfterMs: 60_000 } }),
      ],
      [flowEdge("e1", "s1", "s2")],
    );

  it("auto-forwards to the single destination, stamps the passage, and re-homes submitted", () => {
    const created = createTask(pipelineDoc(), "s1");
    const result = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      "reviewed and packaged",
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    expect(result.forwarded?.nodeId).toBe("s2");
    // Old row: completed passage record with exit=forwarded and the emission.
    expect(result.task.state).toBe("completed");
    const exited = result.task.journey?.at(-1);
    expect(exited?.nodeId).toBe("s1");
    expect(exited?.exit).toBe("forwarded");
    expect(exited?.next).toBe("s2");
    expect(exited?.emissionNote).toBe("reviewed and packaged");
    // Successor: same id, submitted, unclaimed, baked by claimableAfterMs.
    const successor = itemsAt(result.doc, "s2")[0]!;
    expect(successor.id).toBe(created.task.id);
    expect(successor.state).toBe("submitted");
    expect(successor.claimedBy).toBeUndefined();
    expect(successor.holdUntil).toBe("2026-08-20T12:01:00.000Z");
    expect(successor.journey?.at(-1)).toEqual({
      nodeId: "s2",
      enteredAt: "2026-08-20T12:00:00.000Z",
      epoch: 0,
    });
    // Onion by construction: the successor thread is brief + arrival marker,
    // never the prior passage's interior messages.
    expect(successor.history).toHaveLength(2);
    expect(successor.history[1]?.parts[0]).toEqual({
      kind: "text",
      text: 'forwarded from "s1" — reviewed and packaged',
    });
  });

  it("prefers the per-task holdFor stamp over the station default", () => {
    const created = createTask(pipelineDoc(), "s1");
    const result = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW, holdForMs: 5 * 60_000 },
    );
    expect(itemsAt(result.doc, "s2")[0]?.holdUntil).toBe(
      "2026-08-20T12:05:00.000Z",
    );
  });

  it("requires an explicit next when the sink has several destinations", () => {
    const doc = docWith(
      [sinkNode("s1"), sinkNode("s2"), sinkNode("s3")],
      [flowEdge("e1", "s1", "s2"), flowEdge("e2", "s1", "s3")],
    );
    const created = createTask(doc, "s1");
    expect(() =>
      workTaskTransition(
        created.doc,
        "alpha",
        "s1",
        created.task.id,
        "completed",
        undefined,
        ids,
        { artifacts: [] },
      ),
    ).toThrow(/pick next from \[s2, s3\]/);
    expect(() =>
      workTaskTransition(
        created.doc,
        "alpha",
        "s1",
        created.task.id,
        "completed",
        undefined,
        ids,
        { artifacts: [] },
        { next: "elsewhere" },
      ),
    ).toThrow(/not a live flow destination/);
    const result = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { next: "s3", nowMs: NOW },
    );
    expect(result.forwarded?.nodeId).toBe("s3");
  });

  it("demands green current-epoch tickets for outbound and inbound checklists", () => {
    const doc = docWith(
      [
        sinkNode("s1", {
          outbound: { checklist: [{ id: "out-1", label: "build", command: "true" }] },
        }),
        sinkNode("s2", {
          inbound: { checklist: [{ id: "in-1", label: "lint", command: "true" }] },
        }),
      ],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s1");
    expect(() =>
      workTaskTransition(
        created.doc,
        "alpha",
        "s1",
        created.task.id,
        "completed",
        undefined,
        ids,
        { artifacts: [] },
      ),
    ).toThrow(/claims unsatisfied \[boarding\]/);

    const ticket = (checkId: string, side: "outbound" | "inbound"): Ticket => ({
      checkId,
      side,
      label: checkId,
      command: "true",
      exitCode: 0,
      outputTail: "",
      at: "2026-08-20T11:59:00.000Z",
      epoch: 0,
    });
    const boarded: CanvasDoc = {
      ...created.doc,
      nodes: created.doc.nodes.map((node) =>
        node.id === "s1"
          ? ({
              ...node,
              ether: {
                ...node.ether,
                tasks: {
                  ...node.ether!.tasks!,
                  items: node.ether!.tasks!.items.map((item) => ({
                    ...item,
                    boarding: [ticket("out-1", "outbound"), ticket("in-1", "inbound")],
                  })),
                },
              },
            } as CanvasNode)
          : node,
      ),
    };
    const result = workTaskTransition(
      boarded,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    expect(result.forwarded?.nodeId).toBe("s2");
    // Tickets are per-station stamps and stay behind on the passage record.
    expect(itemsAt(result.doc, "s2")[0]?.boarding).toBeUndefined();
  });

  it("drops the promotion marker so an operator-gated destination re-gates the arrival", () => {
    const doc = docWith(
      [
        sinkNode("s1", { inbound: { admission: "operator-gated" } }),
        sinkNode("s2", { inbound: { admission: "operator-gated" } }),
      ],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s1");
    // The operator promoted this arrival at s1. Promotion is per-station and
    // epoch-scoped, so the marker must not ride the forward to s2.
    const promoted: CanvasDoc = {
      ...created.doc,
      nodes: created.doc.nodes.map((node) =>
        node.id === "s1"
          ? ({
              ...node,
              ether: {
                ...node.ether,
                tasks: {
                  ...node.ether!.tasks!,
                  items: node.ether!.tasks!.items.map((item) => ({
                    ...item,
                    metadata: {
                      ...(item.metadata ?? {}),
                      [PIPELINE_ADMITTED_METADATA_KEY]: 0,
                    },
                  })),
                },
              },
            } as CanvasNode)
          : node,
      ),
    };
    const result = workTaskTransition(
      promoted,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    const successor = itemsAt(result.doc, "s2")[0]!;
    expect(successor.metadata?.[PIPELINE_ADMITTED_METADATA_KEY]).toBeUndefined();
    // Only the marker is stripped — the rest of the bag travels.
    expect(successor.metadata?.details).toBe("ship it");
    expect(taskPromoted(successor)).toBe(false);
    expect(
      taskAdmissionState(
        successor,
        sinkContractOf(result.doc.nodes.find((node) => node.id === "s2")),
        NOW,
      ),
    ).toBe("operator-gated");
    // The gate is the point: no seat inherits s1's promotion at s2.
    expect(() =>
      workTaskClaim(
        result.doc,
        "alpha",
        "s2",
        created.task.id,
        actorRef("1", "worker-1"),
        ids,
      ),
    ).toThrow(/awaits operator approval/);
  });

  it("leaves dependsOn and the admission overlay behind, carrying id, epoch, and claims", () => {
    const doc = docWith(
      [sinkNode("s1"), sinkNode("s2")],
      [flowEdge("e1", "s1", "s2")],
    );
    const prereq = createTask(doc, "s1", "land the migration");
    const created = workTaskCreate(
      prereq.doc,
      "alpha",
      "s1",
      "ship it",
      { details: "ship it" },
      ids,
      undefined,
      undefined,
      [prereq.task.id],
      undefined,
      [{ ...claim("c-s2"), station: "s2" }],
      { admission: "operator-owned" },
    );
    expect(created.task.dependsOn).toEqual([prereq.task.id]);
    expect(created.task.admission).toBe("operator-owned");

    const result = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    const successor = itemsAt(result.doc, "s2")[0]!;
    // Prereqs gate the first claim at the origin and the overlay is the
    // origin operator's call — neither speaks for the next station.
    expect(successor.dependsOn).toBeUndefined();
    expect(successor.admission).toBeUndefined();
    expect(taskAdmissionState(successor, undefined, NOW)).toBe("claimable");
    // Identity, epoch, and the authored station-addressed law do travel.
    expect(successor.id).toBe(created.task.id);
    expect(successor.epoch).toBe(0);
    expect(successor.claims).toEqual([{ ...claim("c-s2"), station: "s2" }]);
  });

  it("requires a fork waiver for station-addressed claims off the chosen branch", () => {
    const doc = docWith(
      [sinkNode("s1"), sinkNode("s2"), sinkNode("s3")],
      [flowEdge("e1", "s1", "s2"), flowEdge("e2", "s1", "s3")],
    );
    const created = workTaskCreate(
      doc,
      "alpha",
      "s1",
      "audit trail",
      { details: "audit trail" },
      ids,
    );
    const withClaim: CanvasDoc = {
      ...created.doc,
      nodes: created.doc.nodes.map((node) =>
        node.id === "s1"
          ? ({
              ...node,
              ether: {
                ...node.ether,
                tasks: {
                  ...node.ether!.tasks!,
                  items: node.ether!.tasks!.items.map((item) => ({
                    ...item,
                    claims: [{ ...claim("c-s3"), station: "s3" }],
                  })),
                },
              },
            } as CanvasNode)
          : node,
      ),
    };
    expect(() =>
      workTaskTransition(
        withClaim,
        "alpha",
        "s1",
        created.task.id,
        "completed",
        undefined,
        ids,
        { artifacts: [] },
        { next: "s2" },
      ),
    ).toThrow(/claims unsatisfied \[claims.forkWaiver\]/);
    const waivedResult = workTaskTransition(
      withClaim,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      {
        artifacts: [],
        claimWaivers: [{ claimId: "c-s3", reason: "s3 branch dropped" }],
      },
      { next: "s2", nowMs: NOW },
    );
    expect(waivedResult.forwarded?.nodeId).toBe("s2");
  });
});

describe("terminal close", () => {
  it("refuses closing while an upstream station claim was never checked this epoch", () => {
    // s1 -> s2; the task skipped answering the s1-addressed claim (no receipt
    // at s1 in the current epoch), so terminal close at s2 must refuse.
    const doc = docWith(
      [sinkNode("s1"), sinkNode("s2")],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s2");
    const withClaim: CanvasDoc = {
      ...created.doc,
      nodes: created.doc.nodes.map((node) =>
        node.id === "s2"
          ? ({
              ...node,
              ether: {
                ...node.ether,
                tasks: {
                  ...node.ether!.tasks!,
                  items: node.ether!.tasks!.items.map((item) => ({
                    ...item,
                    claims: [{ ...claim("c-s1"), station: "s1" }],
                  })),
                },
              },
            } as CanvasNode)
          : node,
      ),
    };
    expect(() =>
      workTaskTransition(
        withClaim,
        "alpha",
        "s2",
        created.task.id,
        "completed",
        undefined,
        ids,
        { artifacts: [] },
      ),
    ).toThrow(/claims unsatisfied \[claims.terminal\]/);
    const done = workTaskTransition(
      withClaim,
      "alpha",
      "s2",
      created.task.id,
      "completed",
      undefined,
      ids,
      {
        artifacts: [],
        claimWaivers: [{ claimId: "c-s1", reason: "s1 pass not needed" }],
      },
    );
    expect(done.task.state).toBe("completed");
    expect(done.forwarded).toBeUndefined();
  });
});

describe("defect-back", () => {
  it("re-homes to the previous journey sink with an epoch bump and the defect on record", () => {
    const doc = docWith(
      [sinkNode("s1"), sinkNode("s2")],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s1");
    const forwardedResult = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      "first pass done",
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    const rejectedResult = workTaskTransition(
      forwardedResult.doc,
      "alpha",
      "s2",
      created.task.id,
      "rejected",
      undefined,
      ids,
      undefined,
      {
        defect: { summary: "misses the edge case", refs: ["tests/edge.test.ts"] },
        nowMs: NOW + 60_000,
      },
    );
    expect(rejectedResult.defectBack?.nodeId).toBe("s1");
    // Current station's passage exits rejected-back.
    expect(rejectedResult.task.state).toBe("rejected");
    expect(rejectedResult.task.journey?.at(-1)?.exit).toBe("rejected-back");
    expect(rejectedResult.task.journey?.at(-1)?.next).toBe("s1");
    // Previous station's row becomes the live submitted task at epoch 1.
    const returned = itemsAt(rejectedResult.doc, "s1")[0]!;
    expect(returned.id).toBe(created.task.id);
    expect(returned.state).toBe("submitted");
    expect(returned.epoch).toBe(1);
    expect(returned.claimedBy).toBeUndefined();
    expect(returned.completionEvidence).toBeUndefined();
    expect(returned.journey?.at(-1)).toEqual({
      nodeId: "s1",
      enteredAt: new Date(NOW + 60_000).toISOString(),
      epoch: 1,
    });
    expect(returned.history.at(-1)?.parts[0]).toEqual({
      kind: "text",
      text: 'defect from "s2": misses the edge case\nref: tests/edge.test.ts',
    });
  });

  it("stays a terminal reject at the pipeline head (no previous passage)", () => {
    const doc = docWith([sinkNode("s1"), sinkNode("s2")], [flowEdge("e1", "s1", "s2")]);
    const created = createTask(doc, "s1");
    const rejected = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "rejected",
      undefined,
      ids,
      undefined,
      { defect: { summary: "not viable" } },
    );
    expect(rejected.defectBack).toBeUndefined();
    expect(rejected.task.state).toBe("rejected");
  });

  it("records the previous station as the defect target when none is named", () => {
    const doc = docWith(
      [sinkNode("s1"), sinkNode("s2")],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s1");
    const forwarded = workTaskTransition(
      created.doc, "alpha", "s1", created.task.id,
      "completed", "done", ids, { artifacts: [] }, { nowMs: NOW },
    );
    const rejected = workTaskTransition(
      forwarded.doc, "alpha", "s2", created.task.id,
      "rejected", undefined, ids, undefined,
      { defect: { summary: "misses the edge case" }, nowMs: NOW + 60_000 },
    );
    const returned = itemsAt(rejected.doc, "s1")[0]!;
    expect(returned.defects).toEqual([
      { epoch: 1, target: "s1", at: new Date(NOW + 60_000).toISOString() },
    ]);
    expect(rejected.task.defects).toEqual(returned.defects);
  });
});

describe("defect to a visited target", () => {
  const line = () =>
    docWith(
      [sinkNode("s1"), sinkNode("s2"), sinkNode("s3")],
      [flowEdge("e1", "s1", "s2"), flowEdge("e2", "s2", "s3")],
    );

  const travelToS3 = () => {
    const doc = line();
    const created = createTask(doc, "s1");
    const atS2 = workTaskTransition(
      created.doc, "alpha", "s1", created.task.id,
      "completed", "explored", ids, { artifacts: [] }, { nowMs: NOW },
    );
    const atS3 = workTaskTransition(
      atS2.doc, "alpha", "s2", created.task.id,
      "completed", "implemented", ids, { artifacts: [] }, { nowMs: NOW + 1_000 },
    );
    return { doc: atS3.doc, taskId: created.task.id };
  };

  it("re-homes to any visited station, skipping stations between", () => {
    const { doc, taskId } = travelToS3();
    const rejected = workTaskTransition(
      doc, "alpha", "s3", taskId,
      "rejected", undefined, ids, undefined,
      {
        defect: { summary: "the exploration itself was wrong", target: "s1" },
        nowMs: NOW + 60_000,
      },
    );
    expect(rejected.defectBack?.nodeId).toBe("s1");
    expect(rejected.task.journey?.at(-1)?.exit).toBe("rejected-back");
    expect(rejected.task.journey?.at(-1)?.next).toBe("s1");
    const returned = itemsAt(rejected.doc, "s1")[0]!;
    expect(returned.state).toBe("submitted");
    expect(returned.epoch).toBe(1);
    expect(returned.defects).toEqual([
      { epoch: 1, target: "s1", at: new Date(NOW + 60_000).toISOString() },
    ]);
    // The record of the whole line travels with the re-homed task.
    expect(returned.journey?.map((p) => p.nodeId)).toEqual([
      "s1", "s2", "s3", "s1",
    ]);
    // s2's passage row is untouched by the deep defect.
    const s2Row = itemsAt(rejected.doc, "s2")[0]!;
    expect(s2Row.state).toBe("completed");
    expect(s2Row.journey?.at(-1)?.exit).toBe("forwarded");
  });

  it("refuses a target the journey never visited, naming the visited stations", () => {
    const { doc, taskId } = travelToS3();
    expect(() =>
      workTaskTransition(
        doc, "alpha", "s3", taskId,
        "rejected", undefined, ids, undefined,
        { defect: { summary: "bad", target: "s9" }, nowMs: NOW + 60_000 },
      ),
    ).toThrow(/not a station this task has visited.*s1.*s2/);
  });

  it("refuses the current station as a target", () => {
    const { doc, taskId } = travelToS3();
    expect(() =>
      workTaskTransition(
        doc, "alpha", "s3", taskId,
        "rejected", undefined, ids, undefined,
        { defect: { summary: "bad", target: "s3" }, nowMs: NOW + 60_000 },
      ),
    ).toThrow(/is this station/);
  });
});

describe("exited passage rows stay closed", () => {
  it("refuses to re-open a forwarded row via the generic QA requeue", () => {
    const doc = docWith([sinkNode("s1"), sinkNode("s2")], [flowEdge("e1", "s1", "s2")]);
    const created = createTask(doc, "s1");
    const forwarded = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      "first pass done",
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    expect(() =>
      workTaskTransition(
        forwarded.doc,
        "alpha",
        "s1",
        created.task.id,
        "submitted",
        "requeue anyway",
        ids,
      ),
    ).toThrow(/closed passage record/);
    // The live successor at s2 stays untouched — no second live row minted.
    expect(itemsAt(forwarded.doc, "s2")[0]?.state).toBe("submitted");
  });

  it("refuses to re-open a defect-back source row via a plain rejected -> submitted transition", () => {
    const doc = docWith([sinkNode("s1"), sinkNode("s2")], [flowEdge("e1", "s1", "s2")]);
    const created = createTask(doc, "s1");
    const forwarded = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      "first pass done",
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    const rejected = workTaskTransition(
      forwarded.doc,
      "alpha",
      "s2",
      created.task.id,
      "rejected",
      undefined,
      ids,
      undefined,
      { defect: { summary: "misses the edge case" }, nowMs: NOW + 60_000 },
    );
    // Whether blocked by the closed-passage guard or by the transition table,
    // the source row must never re-open into a second live copy of the task.
    expect(() =>
      workTaskTransition(
        rejected.doc,
        "alpha",
        "s2",
        created.task.id,
        "submitted",
        undefined,
        ids,
      ),
    ).toThrow(WorkError);
    // The live successor at s1 (re-homed by defect-back) stays untouched.
    expect(itemsAt(rejected.doc, "s1")[0]?.state).toBe("submitted");
  });
});

describe("claim admission", () => {
  const worker = actorRef("1", "worker-1");

  const withEdge = (doc: CanvasDoc): CanvasDoc => ({
    ...doc,
    edges: [...doc.edges, { id: "w1", fromNode: "worker-1", toNode: "s1" }],
  });

  it("rejects seat claims at operator-owned sinks with a claim conflict", () => {
    const doc = withEdge(
      docWith([sinkNode("s1", { inbound: { admission: "operator-owned" } })]),
    );
    const created = createTask(doc, "s1");
    expect(() =>
      workTaskClaim(created.doc, "alpha", "s1", created.task.id, worker, ids),
    ).toThrow(WorkError);
    try {
      workTaskClaim(created.doc, "alpha", "s1", created.task.id, worker, ids);
    } catch (error) {
      expect((error as WorkError).code).toBe("claim_contention");
      expect((error as WorkError).message).toContain("operator-owned");
    }
  });

  it("holds baking arrivals and unpromoted operator-gated arrivals", () => {
    const gatedDoc = withEdge(
      docWith([sinkNode("s1", { inbound: { admission: "operator-gated" } })]),
    );
    const gated = createTask(gatedDoc, "s1");
    expect(() =>
      workTaskClaim(gated.doc, "alpha", "s1", gated.task.id, worker, ids),
    ).toThrow(/awaits operator approval/);

    const promotedDoc: CanvasDoc = {
      ...gated.doc,
      nodes: gated.doc.nodes.map((node) =>
        node.id === "s1"
          ? ({
              ...node,
              ether: {
                ...node.ether,
                tasks: {
                  ...node.ether!.tasks!,
                  items: node.ether!.tasks!.items.map((item) => ({
                    ...item,
                    metadata: {
                      ...(item.metadata ?? {}),
                      [PIPELINE_ADMITTED_METADATA_KEY]: 0,
                    },
                  })),
                },
              },
            } as CanvasNode)
          : node,
      ),
    };
    const claimed = workTaskClaim(
      promotedDoc,
      "alpha",
      "s1",
      gated.task.id,
      worker,
      ids,
    );
    expect(claimed.task.state).toBe("working");
  });

  it("keeps a held task unclaimable until holdUntil passes", () => {
    const doc = withEdge(docWith([sinkNode("s1")]));
    const created = createTask(doc, "s1");
    const heldDoc: CanvasDoc = {
      ...created.doc,
      nodes: created.doc.nodes.map((node) =>
        node.id === "s1"
          ? ({
              ...node,
              ether: {
                ...node.ether,
                tasks: {
                  ...node.ether!.tasks!,
                  items: node.ether!.tasks!.items.map((item) => ({
                    ...item,
                    holdUntil: new Date(Date.now() + 3_600_000).toISOString(),
                  })),
                },
              },
            } as CanvasNode)
          : node,
      ),
    };
    expect(() =>
      workTaskClaim(heldDoc, "alpha", "s1", created.task.id, worker, ids),
    ).toThrow(/not assignable before/);
  });
});
