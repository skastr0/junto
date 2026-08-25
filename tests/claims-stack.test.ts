import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type {
  ClaimDef,
  CompletionEvidence,
  Task,
  TaskClaim,
  TasksSinkContract,
} from "../src/shared/work-model";
import {
  PIPELINE_ADMITTED_METADATA_KEY,
  computeHoldUntil,
  effectiveClaimsStack,
  evaluateBoarding,
  evaluateClaimCompletion,
  evaluateForkWaivers,
  evaluateTerminalClose,
  requiredBoardingChecks,
  respondedAtStation,
  stationReceipts,
  taskAdmissionState,
  taskEpoch,
} from "../src/shared/claims";
import { HOLD_FOR_MAX_MS } from "../src/shared/work-control";

const claim = (id: string, severity: "hard" | "soft" = "hard"): ClaimDef => ({
  id,
  text: `claim ${id}`,
  severity,
});

const taskClaim = (
  id: string,
  station: string,
  severity: "hard" | "soft" = "hard",
): TaskClaim => ({ ...claim(id, severity), station });

const sink = (
  id: string,
  contract?: TasksSinkContract,
  items: ReadonlyArray<Task> = [],
): CanvasNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 300,
  y: 300,
  width: 100,
  height: 60,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [...items],
      ...(contract !== undefined ? { contract } : {}),
    },
  },
});

const region = (
  id: string,
  rect: { x: number; y: number; width: number; height: number },
  claims?: ReadonlyArray<ClaimDef>,
  label?: string,
): CanvasNode => ({
  id,
  type: "group",
  ...rect,
  ...(label !== undefined ? { label } : {}),
  ether: {
    region: {
      ...(claims !== undefined ? { contract: { claims: [...claims] } } : {}),
    },
  },
});

const flowEdge = (id: string, source: string, destination: string) => ({
  id,
  fromNode: source,
  toNode: destination,
  ether: { flow: { source, destination } },
});

const baseTask = (id: string, extra?: Partial<Task>): Task => ({
  id,
  state: "working",
  history: [],
  ...extra,
});

describe("effectiveClaimsStack", () => {
  it("stacks region claims outer to inner, then sink claims, then task claims for this station", () => {
    const doc: CanvasDoc = {
      nodes: [
        region("outer", { x: 0, y: 0, width: 1000, height: 1000 }, [claim("r-outer")], "Outer"),
        region("inner", { x: 200, y: 200, width: 400, height: 400 }, [claim("r-inner")]),
        sink("s1", { claims: [claim("s-local", "soft")] }),
      ],
      edges: [],
    };
    const task = baseTask("t1", { claims: [taskClaim("t-here", "s1"), taskClaim("t-there", "s2")] });
    const stack = effectiveClaimsStack(doc, "s1", task);
    expect(stack.map((entry) => entry.claim.id)).toEqual([
      "r-outer",
      "r-inner",
      "s-local",
      "t-here",
    ]);
    expect(stack[0]!.provenance).toEqual({ kind: "region", regionId: "outer", label: "Outer" });
    expect(stack[1]!.provenance).toEqual({ kind: "region", regionId: "inner", label: "inner" });
    expect(stack[2]!.provenance).toEqual({ kind: "sink", nodeId: "s1" });
    expect(stack[3]!.provenance).toEqual({ kind: "task", station: "s1" });
  });

  it("is empty for a sink with no surrounding law", () => {
    const doc: CanvasDoc = { nodes: [sink("s1")], edges: [] };
    expect(effectiveClaimsStack(doc, "s1", baseTask("t1"))).toEqual([]);
  });
});

describe("evaluateClaimCompletion", () => {
  const stack = (claims: ReadonlyArray<ClaimDef>) =>
    claims.map((entry) => ({
      claim: entry,
      provenance: { kind: "sink", nodeId: "s1" } as const,
    }));

  it("passes when every hard claim has a response and every soft claim a response or waiver", () => {
    const evidence: CompletionEvidence = {
      artifacts: [],
      responses: [{ claimId: "h1", response: "verified against the doc" }],
      claimWaivers: [{ claimId: "w1", reason: "not applicable this pass" }],
    };
    expect(
      evaluateClaimCompletion({
        stack: stack([claim("h1", "hard"), claim("w1", "soft")]),
        evidence,
      }),
    ).toBeUndefined();
  });

  it("rejects a waiver standing in for a hard claim", () => {
    const evidence: CompletionEvidence = {
      artifacts: [],
      claimWaivers: [{ claimId: "h1", reason: "trying to skip" }],
    };
    const failure = evaluateClaimCompletion({
      stack: stack([claim("h1", "hard")]),
      evidence,
    });
    expect(failure?.missing).toBe("claims");
    expect(failure?.claimId).toBe("h1");
  });

  it("names the innermost unmet claim when several are missing", () => {
    const failure = evaluateClaimCompletion({
      stack: stack([claim("outer-most"), claim("inner-most")]),
      evidence: undefined,
    });
    expect(failure?.claimId).toBe("inner-most");
  });

  it("requires a response or waiver for soft claims", () => {
    const failure = evaluateClaimCompletion({
      stack: stack([claim("soft-1", "soft")]),
      evidence: { artifacts: [] },
    });
    expect(failure?.missing).toBe("claims");
    expect(failure?.next_step).toContain("claimWaivers");
  });
});

describe("station receipts and fork waivers", () => {
  // s1 -> s2 -> s3 with a side branch s2 -> s4.
  const journeyDoc = (
    s1Task: Task | undefined,
    contractByNode?: Record<string, TasksSinkContract>,
  ): CanvasDoc => ({
    nodes: [
      sink("s1", contractByNode?.s1, s1Task === undefined ? [] : [s1Task]),
      sink("s2", contractByNode?.s2),
      sink("s3", contractByNode?.s3),
      sink("s4", contractByNode?.s4),
    ],
    edges: [
      flowEdge("e1", "s1", "s2"),
      flowEdge("e2", "s2", "s3"),
      flowEdge("e3", "s2", "s4"),
    ],
  });

  it("collects current-epoch receipts from passage-station rows and ignores stale epochs", () => {
    const passedTask = baseTask("t1", {
      state: "completed",
      completionEvidence: {
        artifacts: [],
        responses: [{ claimId: "c-s1", response: "checked at s1" }],
        claimWaivers: [{ claimId: "c-waived", reason: "out of scope" }],
      },
    });
    const live = baseTask("t1", {
      epoch: 0,
      journey: [
        { nodeId: "s1", enteredAt: "2026-08-20T00:00:00.000Z", epoch: 0, exit: "forwarded", next: "s2" },
        { nodeId: "s2", enteredAt: "2026-08-20T01:00:00.000Z", epoch: 0 },
      ],
    });
    const receipts = stationReceipts(journeyDoc(passedTask), live);
    expect([...receipts.responded.keys()]).toEqual(["c-s1"]);
    expect([...receipts.responded.get("c-s1") ?? []]).toEqual(["s1"]);
    expect([...receipts.waived]).toEqual(["c-waived"]);

    const bumped = { ...live, epoch: 1 };
    const stale = stationReceipts(journeyDoc(passedTask), bumped);
    expect(stale.responded.size).toBe(0);
    expect(stale.waived.size).toBe(0);
  });

  it("keeps upstream receipts live after a targeted defect and always kills waivers", () => {
    const passedTask = baseTask("t1", {
      state: "completed",
      completionEvidence: {
        artifacts: [],
        responses: [{ claimId: "c-s1", response: "checked at s1" }],
        claimWaivers: [{ claimId: "c-waived", reason: "out of scope" }],
      },
    });
    const journey = [
      { nodeId: "s1", enteredAt: "2026-08-20T00:00:00.000Z", epoch: 0, exit: "forwarded", next: "s2" },
      { nodeId: "s2", enteredAt: "2026-08-20T01:00:00.000Z", epoch: 0, exit: "forwarded", next: "s3" },
      { nodeId: "s3", enteredAt: "2026-08-20T02:00:00.000Z", epoch: 0, exit: "rejected-back", next: "s2" },
      { nodeId: "s2", enteredAt: "2026-08-20T03:00:00.000Z", epoch: 1 },
    ] as const;

    // Defect aimed at s2: s1 sits strictly upstream, so its receipt survives.
    // The waiver dies regardless — no waiver survives any defect.
    const backToS2 = baseTask("t1", {
      epoch: 1,
      journey: [...journey],
      defects: [{ epoch: 1, target: "s2", at: "2026-08-20T02:00:00.000Z" }],
    });
    const receipts = stationReceipts(journeyDoc(passedTask), backToS2);
    expect([...receipts.responded.keys()]).toEqual(["c-s1"]);
    expect([...receipts.responded.get("c-s1") ?? []]).toEqual(["s1"]);
    expect(receipts.waived.size).toBe(0);

    // Defect aimed at s1 shadows s1 itself — even though the old evidence is
    // still physically on the row, the accounting must not read it.
    const backToS1 = baseTask("t1", {
      epoch: 1,
      journey: [
        ...journey.slice(0, 3),
        { nodeId: "s1", enteredAt: "2026-08-20T03:00:00.000Z", epoch: 1 },
      ],
      defects: [{ epoch: 1, target: "s1", at: "2026-08-20T02:00:00.000Z" }],
    });
    const shadowed = stationReceipts(journeyDoc(passedTask), backToS1);
    expect(shadowed.responded.size).toBe(0);
    expect(shadowed.waived.size).toBe(0);
  });

  it("shadows re-earned receipts only from the later defect target onward", () => {
    // Epoch 1 re-earned a receipt at s1 (after a defect to s1); a second
    // defect aimed at s2 must keep that s1 receipt live: only stations at or
    // downstream of s2 lose their receipts.
    const passedTask = baseTask("t1", {
      state: "completed",
      completionEvidence: {
        artifacts: [],
        responses: [{ claimId: "c-s1", response: "re-checked at s1 in epoch 1" }],
      },
    });
    const task = baseTask("t1", {
      epoch: 2,
      journey: [
        { nodeId: "s1", enteredAt: "2026-08-20T00:00:00.000Z", epoch: 0, exit: "rejected-back", next: "s1" },
        { nodeId: "s1", enteredAt: "2026-08-20T01:00:00.000Z", epoch: 1, exit: "forwarded", next: "s2" },
        { nodeId: "s2", enteredAt: "2026-08-20T02:00:00.000Z", epoch: 1, exit: "rejected-back", next: "s2" },
        { nodeId: "s2", enteredAt: "2026-08-20T03:00:00.000Z", epoch: 2 },
      ],
      defects: [
        { epoch: 1, target: "s1", at: "2026-08-20T00:30:00.000Z" },
        { epoch: 2, target: "s2", at: "2026-08-20T02:30:00.000Z" },
      ],
    });
    const receipts = stationReceipts(journeyDoc(passedTask), task);
    expect([...receipts.responded.keys()]).toEqual(["c-s1"]);
  });

  it("never lets a response recorded at one station satisfy a claim addressed to another", () => {
    // A claim addressed to s4 is answered (illegitimately) at s1's own
    // completion row, then the task travels s1 -> s2. Forwarding from s2
    // down a branch that abandons s4 must still demand a waiver — the s1
    // response must not leak across the station boundary.
    const leakedAtS1 = baseTask("t1", {
      state: "completed",
      completionEvidence: {
        artifacts: [],
        responses: [{ claimId: "c-s4", response: "answered at the wrong station" }],
      },
    });
    const task = baseTask("t1", {
      claims: [taskClaim("c-s4", "s4")],
      journey: [
        { nodeId: "s1", enteredAt: "2026-08-20T00:00:00.000Z", epoch: 0, exit: "forwarded", next: "s2" },
        { nodeId: "s2", enteredAt: "2026-08-20T01:00:00.000Z", epoch: 0 },
      ],
    });
    const receipts = stationReceipts(journeyDoc(leakedAtS1), task);
    expect(respondedAtStation(receipts.responded, "s4", "c-s4")).toBe(false);
    expect(respondedAtStation(receipts.responded, "s1", "c-s4")).toBe(true);

    const failure = evaluateForkWaivers({
      doc: journeyDoc(leakedAtS1),
      sinkNodeId: "s2",
      task,
      next: "s3",
      evidence: { artifacts: [] },
    });
    expect(failure?.missing).toBe("claims.forkWaiver");
    expect(failure?.claimId).toBe("c-s4");
  });

  it("requires a waiver for claims addressed off the chosen branch", () => {
    const task = baseTask("t1", {
      claims: [taskClaim("c-s4", "s4")],
      journey: [{ nodeId: "s2", enteredAt: "2026-08-20T01:00:00.000Z", epoch: 0 }],
    });
    const failure = evaluateForkWaivers({
      doc: journeyDoc(undefined),
      sinkNodeId: "s2",
      task,
      next: "s3",
      evidence: { artifacts: [] },
    });
    expect(failure?.missing).toBe("claims.forkWaiver");
    expect(failure?.claimId).toBe("c-s4");

    const waived = evaluateForkWaivers({
      doc: journeyDoc(undefined),
      sinkNodeId: "s2",
      task,
      next: "s3",
      evidence: {
        artifacts: [],
        claimWaivers: [{ claimId: "c-s4", reason: "branch abandoned deliberately" }],
      },
    });
    expect(waived).toBeUndefined();
  });

  it("lets still-reachable stations pass without a waiver", () => {
    const task = baseTask("t1", { claims: [taskClaim("c-s4", "s4")] });
    expect(
      evaluateForkWaivers({
        doc: journeyDoc(undefined),
        sinkNodeId: "s2",
        task,
        next: "s4",
        evidence: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("evaluateTerminalClose", () => {
  const doc = (s1Task?: Task): CanvasDoc => ({
    nodes: [
      sink("s1", undefined, s1Task === undefined ? [] : [s1Task]),
      sink("s2"),
    ],
    edges: [flowEdge("e1", "s1", "s2")],
  });

  it("closes only when every station-addressed claim is checked in the current epoch or waived", () => {
    const task = baseTask("t1", {
      claims: [taskClaim("c-s1", "s1"), taskClaim("c-s2", "s2")],
      journey: [
        { nodeId: "s1", enteredAt: "2026-08-20T00:00:00.000Z", epoch: 0, exit: "forwarded", next: "s2" },
        { nodeId: "s2", enteredAt: "2026-08-20T01:00:00.000Z", epoch: 0 },
      ],
    });
    const upstreamRow = baseTask("t1", {
      state: "completed",
      completionEvidence: {
        artifacts: [],
        responses: [{ claimId: "c-s1", response: "checked at s1" }],
      },
    });
    const missing = evaluateTerminalClose({
      doc: doc(upstreamRow),
      sinkNodeId: "s2",
      task,
      evidence: { artifacts: [] },
    });
    expect(missing?.missing).toBe("claims.terminal");
    expect(missing?.claimId).toBe("c-s2");

    const answered = evaluateTerminalClose({
      doc: doc(upstreamRow),
      sinkNodeId: "s2",
      task,
      evidence: {
        artifacts: [],
        responses: [{ claimId: "c-s2", response: "checked here" }],
      },
    });
    expect(answered).toBeUndefined();
  });

  it("treats a current-station response as valid only for claims addressed here", () => {
    const task = baseTask("t1", { claims: [taskClaim("c-s1", "s1")] });
    const failure = evaluateTerminalClose({
      doc: doc(),
      sinkNodeId: "s2",
      task,
      evidence: {
        artifacts: [],
        responses: [{ claimId: "c-s1", response: "answered at the wrong station" }],
      },
    });
    expect(failure?.claimId).toBe("c-s1");
  });

  it("refuses to close on a receipt recorded at a station other than the one the claim addresses", () => {
    // c-s1 is addressed to s1, but the response landed on s2's own passage
    // row (e.g. a stray entry from an earlier evidence submission there).
    // Terminal close at s2 must still demand it be checked at s1.
    const task = baseTask("t1", {
      claims: [taskClaim("c-s1", "s1")],
      journey: [
        { nodeId: "s1", enteredAt: "2026-08-20T00:00:00.000Z", epoch: 0, exit: "forwarded", next: "s2" },
        { nodeId: "s2", enteredAt: "2026-08-20T01:00:00.000Z", epoch: 0 },
      ],
    });
    const leakedDoc: CanvasDoc = {
      nodes: [
        sink("s1"),
        sink("s2", undefined, [
          {
            ...task,
            state: "completed",
            completionEvidence: {
              artifacts: [],
              responses: [{ claimId: "c-s1", response: "leaked from s2's own row" }],
            },
          },
        ]),
      ],
      edges: [flowEdge("e1", "s1", "s2")],
    };
    const failure = evaluateTerminalClose({
      doc: leakedDoc,
      sinkNodeId: "s2",
      task,
      evidence: { artifacts: [] },
    });
    expect(failure?.missing).toBe("claims.terminal");
    expect(failure?.claimId).toBe("c-s1");
  });
});

describe("boarding", () => {
  const check = (id: string) => ({ id, label: `check ${id}`, command: "true" });
  const doc: CanvasDoc = {
    nodes: [
      sink("s1", { outbound: { checklist: [check("out-1")] } }),
      sink("s2", { inbound: { checklist: [check("in-1")] } }),
    ],
    edges: [flowEdge("e1", "s1", "s2")],
  };

  it("requires outbound checks of the source and inbound checks of the destination", () => {
    const checks = requiredBoardingChecks(doc, "s1", "s2");
    expect(checks.map((entry) => `${entry.side}:${entry.check.id}`)).toEqual([
      "outbound:out-1",
      "inbound:in-1",
    ]);
  });

  it("demands a green current-epoch ticket per required check", () => {
    const checks = requiredBoardingChecks(doc, "s1", "s2");
    const ticket = (checkId: string, side: "outbound" | "inbound", exitCode: number, epoch = 0) => ({
      checkId,
      side,
      label: checkId,
      command: "true",
      exitCode,
      outputTail: "",
      at: "2026-08-20T02:00:00.000Z",
      epoch,
    });

    expect(
      evaluateBoarding({ task: baseTask("t1"), checks })?.missing,
    ).toBe("boarding");
    expect(
      evaluateBoarding({
        task: baseTask("t1", {
          boarding: [ticket("out-1", "outbound", 1), ticket("in-1", "inbound", 0)],
        }),
        checks,
      })?.missing,
    ).toBe("boarding.red");
    // Stale-epoch tickets never satisfy the current epoch.
    expect(
      evaluateBoarding({
        task: baseTask("t1", {
          epoch: 1,
          boarding: [ticket("out-1", "outbound", 0), ticket("in-1", "inbound", 0)],
        }),
        checks,
      })?.missing,
    ).toBe("boarding");
    expect(
      evaluateBoarding({
        task: baseTask("t1", {
          boarding: [ticket("out-1", "outbound", 0), ticket("in-1", "inbound", 0)],
        }),
        checks,
      }),
    ).toBeUndefined();
  });

  it("flags a ticket as stale when the check's authored command changed since it was stamped", () => {
    const checks = requiredBoardingChecks(doc, "s1", "s2");
    const ticket = (checkId: string, side: "outbound" | "inbound", command: string) => ({
      checkId,
      side,
      label: checkId,
      command,
      exitCode: 0,
      outputTail: "",
      at: "2026-08-20T02:00:00.000Z",
      epoch: 0,
    });

    // Both tickets green, but the outbound one was stamped against a command
    // the operator has since edited — the doc's check now reads "true --edited".
    const editedDoc: CanvasDoc = {
      nodes: [
        sink("s1", { outbound: { checklist: [{ id: "out-1", label: "check out-1", command: "true --edited" }] } }),
        sink("s2", { inbound: { checklist: [check("in-1")] } }),
      ],
      edges: [flowEdge("e1", "s1", "s2")],
    };
    const editedChecks = requiredBoardingChecks(editedDoc, "s1", "s2");
    const failure = evaluateBoarding({
      task: baseTask("t1", {
        boarding: [ticket("out-1", "outbound", "true"), ticket("in-1", "inbound", "true")],
      }),
      checks: editedChecks,
    });
    expect(failure?.missing).toBe("boarding.stale");
    expect(failure?.next_step).toContain("re-run the boarding checks");

    // Unedited commands stay green.
    expect(
      evaluateBoarding({
        task: baseTask("t1", {
          boarding: [ticket("out-1", "outbound", "true"), ticket("in-1", "inbound", "true")],
        }),
        checks,
      }),
    ).toBeUndefined();
  });
});

describe("admission", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");

  it("operator-owned dominates every other admission state", () => {
    const task = baseTask("t1", { holdUntil: "2026-08-20T13:00:00.000Z" });
    expect(
      taskAdmissionState(task, { inbound: { admission: "operator-owned" } }, now),
    ).toBe("operator-owned");
  });

  it("holds a baking arrival, then gates unpromoted operator-gated ones", () => {
    const held = baseTask("t1", { holdUntil: "2026-08-20T13:00:00.000Z" });
    expect(
      taskAdmissionState(held, { inbound: { admission: "operator-gated" } }, now),
    ).toBe("held");

    const baked = baseTask("t1", { holdUntil: "2026-08-20T11:00:00.000Z" });
    expect(
      taskAdmissionState(baked, { inbound: { admission: "operator-gated" } }, now),
    ).toBe("operator-gated");

    const promoted = baseTask("t1", {
      metadata: { [PIPELINE_ADMITTED_METADATA_KEY]: 0 },
    });
    expect(
      taskAdmissionState(promoted, { inbound: { admission: "operator-gated" } }, now),
    ).toBe("claimable");
  });

  it("epoch-scopes the promotion marker", () => {
    const promotedStale = baseTask("t1", {
      epoch: 1,
      metadata: { [PIPELINE_ADMITTED_METADATA_KEY]: 0 },
    });
    expect(
      taskAdmissionState(promotedStale, { inbound: { admission: "operator-gated" } }, now),
    ).toBe("operator-gated");
    expect(taskEpoch(promotedStale)).toBe(1);
  });

  it("defaults to claimable with no contract", () => {
    expect(taskAdmissionState(baseTask("t1"), undefined, now)).toBe("claimable");
  });
});

describe("computeHoldUntil", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");

  it("prefers the per-task holdFor stamp over the station default", () => {
    expect(computeHoldUntil(now, 60_000, 120_000)).toBe(
      "2026-08-20T12:02:00.000Z",
    );
    expect(computeHoldUntil(now, 60_000, undefined)).toBe(
      "2026-08-20T12:01:00.000Z",
    );
    expect(computeHoldUntil(now, undefined, undefined)).toBeUndefined();
    expect(computeHoldUntil(now, 0, undefined)).toBeUndefined();
  });

  it("clamps any delay to HOLD_FOR_MAX_MS, whichever source supplied it", () => {
    const overMaxHoldFor = HOLD_FOR_MAX_MS + 24 * 60 * 60 * 1000;
    expect(computeHoldUntil(now, undefined, overMaxHoldFor)).toBe(
      new Date(now + HOLD_FOR_MAX_MS).toISOString(),
    );
    const overMaxStationDefault = HOLD_FOR_MAX_MS * 10;
    expect(computeHoldUntil(now, overMaxStationDefault, undefined)).toBe(
      new Date(now + HOLD_FOR_MAX_MS).toISOString(),
    );
    // Within bound stays untouched.
    expect(computeHoldUntil(now, undefined, 60_000)).toBe(
      "2026-08-20T12:01:00.000Z",
    );
  });
});
