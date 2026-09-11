import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc, type Task } from "../src/shared/canvas";
import {
  formatBoardNames,
  formatWaitCountdown,
  groupOutgoingVisits,
  hasPendingWait,
  incomingGlance,
  localVisit,
  admissionLaneHint,
  taskNeedsApproval,
  taskPathLaneCopy,
  taskPathShape,
} from "../src/renderer/components/work/task-path";

// Pure column derivation for the task board (Incoming / Outgoing).

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
  ether: { verb: "feeds" as const },
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

describe("taskPathShape", () => {
  it("reports incoming and outgoing sides from flow edges", () => {
    const d = doc(
      ["intake", "build", "review", "ship"],
      [
        flowEdge("e1", "intake", "build"),
        flowEdge("e2", "build", "review"),
        flowEdge("e3", "build", "ship"),
      ],
    );
    expect(taskPathShape(d, "intake")).toEqual({
      sources: [],
      destinations: ["build"],
      hasIncoming: false,
      hasOutgoing: true,
    });
    expect(taskPathShape(d, "build")).toEqual({
      sources: ["intake"],
      destinations: ["review", "ship"],
      hasIncoming: true,
      hasOutgoing: true,
    });
    expect(taskPathShape(d, "ship")).toEqual({
      sources: ["build"],
      destinations: [],
      hasIncoming: true,
      hasOutgoing: false,
    });
  });

  it("leaves a sink with no flow edges on the plain board", () => {
    const d = doc(["solo"], []);
    expect(taskPathShape(d, "solo")).toEqual({
      sources: [],
      destinations: [],
      hasIncoming: false,
      hasOutgoing: false,
    });
  });
});

describe("task path lane copy", () => {
  it("names real upstream and destination boards", () => {
    const shape = {
      sources: ["intake", "triage"],
      destinations: ["review", "ship"],
      hasIncoming: true,
      hasOutgoing: true,
    };
    const label = (id: string) => ({
      intake: "Intake",
      triage: "Triage",
      review: "Review",
      ship: "Ship",
    })[id] ?? id;
    expect(taskPathLaneCopy(shape, label)).toEqual({
      incomingHint: "From Intake and Triage",
      incomingEmpty: "Tasks from Intake and Triage land here.",
      outgoingHint: "Sent on to Review and Ship",
      outgoingEmpty: "Completed tasks move to Review and Ship.",
    });
  });

  it("formats one, two, and several board names without unstable locale output", () => {
    expect(formatBoardNames(["Review"])).toBe("Review");
    expect(formatBoardNames(["Review", "Ship"])).toBe("Review and Ship");
    expect(formatBoardNames(["Intake", "Review", "Ship"])).toBe(
      "Intake, Review, and Ship",
    );
  });
});

describe("formatWaitCountdown", () => {
  it("scales the unit with the time left", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(formatWaitCountdown(at(8_000), NOW)).toBe("8s");
    expect(formatWaitCountdown(at(260_000), NOW)).toBe("4m 20s");
    expect(formatWaitCountdown(at(3_900_000), NOW)).toBe("1h 05m");
    expect(formatWaitCountdown(at(2 * 86_400_000 + 3 * 3_600_000), NOW)).toBe("2d 3h");
  });

  it("goes quiet with no wait, an elapsed wait, or an unparseable stamp", () => {
    expect(formatWaitCountdown(undefined, NOW)).toBeUndefined();
    expect(formatWaitCountdown(new Date(NOW - 1000).toISOString(), NOW)).toBeUndefined();
    expect(formatWaitCountdown("not-a-time", NOW)).toBeUndefined();
  });
});

describe("incomingGlance", () => {
  it("counts down a waiting task", () => {
    const glance = incomingGlance(
      task("t1", { waitUntil: new Date(NOW + 90_000).toISOString() }),
      undefined,
      NOW,
    );
    expect(glance.admission).toBe("waiting");
    expect(glance.countdown).toBe("1m 30s");
    expect(glance.promotable).toBe(false);
  });

  it("inherits approval from the board floor when the task has no stamp", () => {
    const contract = { incoming: { admission: "approval" as const } };
    const pending = incomingGlance(task("t2"), contract, NOW);
    expect(pending.admission).toBe("approval");
    expect(pending.promotable).toBe(true);
    expect(taskNeedsApproval(task("t2"), contract, NOW)).toBe(true);
  });

  it("holds a stamped auto task in waiting until waitUntil", () => {
    const glance = incomingGlance(
      task("t2b", {
        admission: "auto",
        waitUntil: new Date(NOW + 45_000).toISOString(),
      }),
      undefined,
      NOW,
    );
    expect(glance.admission).toBe("waiting");
    expect(glance.promotable).toBe(false);
    expect(
      taskNeedsApproval(
        task("t2b", {
          admission: "auto",
          waitUntil: new Date(NOW + 45_000).toISOString(),
        }),
        undefined,
        NOW,
      ),
    ).toBe(false);
  });

  it("never offers promotion on a Me board", () => {
    const glance = incomingGlance(
      task("t3"),
      { incoming: { admission: "operator" } },
      NOW,
    );
    expect(glance.admission).toBe("operator");
    expect(glance.promotable).toBe(false);
  });

  it("reports claimable on a plain board", () => {
    expect(incomingGlance(task("t4"), undefined, NOW).admission).toBe("claimable");
  });
});

describe("admissionLaneHint", () => {
  const ready = "Ready to claim";
  const incoming = "Tasks from earlier boards, waiting here";

  it("says waiting for approval when any submitted task is gated", () => {
    const contract = { incoming: { admission: "approval" as const } };
    expect(admissionLaneHint([task("a")], contract, NOW, ready)).toBe(
      "Waiting for approval",
    );
    expect(admissionLaneHint([task("a")], contract, NOW, incoming)).toBe(
      "Waiting for approval",
    );
  });

  it("says waiting to start when a wait is still running", () => {
    const held = task("a", {
      admission: "auto",
      waitUntil: new Date(NOW + 8_000).toISOString(),
    });
    expect(admissionLaneHint([held], undefined, NOW, ready)).toBe(
      "Waiting to start",
    );
  });

  it("keeps the ready copy when nothing is held", () => {
    expect(admissionLaneHint([task("a")], undefined, NOW, ready)).toBe(ready);
    expect(admissionLaneHint([], undefined, NOW, incoming)).toBe(incoming);
  });

  it("prefers approval over a concurrent wait", () => {
    const held = task("wait", {
      admission: "auto",
      waitUntil: new Date(NOW + 8_000).toISOString(),
    });
    const gated = task("gate", { admission: "approval" });
    expect(admissionLaneHint([held, gated], undefined, NOW, ready)).toBe(
      "Waiting for approval",
    );
  });
});

describe("hasPendingWait", () => {
  it("is true only while some task still waits", () => {
    const held = task("t1", { waitUntil: new Date(NOW + 5_000).toISOString() });
    const elapsed = task("t2", { waitUntil: new Date(NOW - 5_000).toISOString() });
    expect(hasPendingWait([elapsed, held], NOW)).toBe(true);
    expect(hasPendingWait([elapsed], NOW)).toBe(false);
    expect(hasPendingWait([], NOW)).toBe(false);
  });
});

describe("groupOutgoingVisits", () => {
  const visit = (
    board: string,
    exit: "sent-on" | "completed" | "sent-back",
    next?: string,
  ) => ({
    board,
    enteredAt: new Date(NOW).toISOString(),
    epoch: 0,
    exitedAt: new Date(NOW).toISOString(),
    exit,
    ...(next !== undefined ? { next } : {}),
  });

  it("groups by next board in path order, then send-backs, then completed", () => {
    const sentOnShip = task("a", {
      visits: [visit("build", "sent-on", "ship")],
    });
    const closedHere = task("b", { visits: [visit("build", "completed")] });
    const sentOnReview = task("c", {
      visits: [visit("build", "sent-on", "review")],
    });
    const sentBack = task("d", {
      visits: [visit("build", "sent-back", "intake")],
    });
    const groups = groupOutgoingVisits(
      [sentOnShip, closedHere, sentOnReview, sentBack],
      "build",
      ["review", "ship"],
    );
    expect(groups.map((group) => group.key)).toEqual([
      "sent-on:review",
      "sent-on:ship",
      "sent-back:intake",
      "completed",
    ]);
    expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(["c"]);
    expect(groups[3]?.kind).toBe("completed");
  });

  it("keeps work with no visit record in the completed group", () => {
    const groups = groupOutgoingVisits([task("a")], "build", ["review"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("completed");
    expect(groups[0]?.boardId).toBeUndefined();
  });

  it("preserves task order inside a group", () => {
    const first = task("a", { visits: [visit("build", "sent-on", "review")] });
    const second = task("b", { visits: [visit("build", "sent-on", "review")] });
    const groups = groupOutgoingVisits([first, second], "build", ["review"]);
    expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("localVisit", () => {
  it("reads the last exited visit at this board", () => {
    const visits = [
      {
        board: "build",
        enteredAt: new Date(NOW).toISOString(),
        epoch: 0,
        exitedAt: new Date(NOW).toISOString(),
        exit: "sent-on" as const,
        next: "review",
      },
      {
        board: "review",
        enteredAt: new Date(NOW).toISOString(),
        epoch: 0,
      },
    ];
    expect(localVisit(task("a", { visits }), "build")?.next).toBe("review");
    expect(localVisit(task("a", { visits }), "review")).toBeUndefined();
  });
});
