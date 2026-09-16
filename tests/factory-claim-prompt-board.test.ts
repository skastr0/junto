import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { Task, TasksContract } from "../src/shared/work-model";
import { buildFactoryClaimPrompt } from "../src/shared/factory-claim-prompt";

const board = (id: string, contract?: TasksContract): CanvasNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 10,
  y: 10,
  width: 100,
  height: 60,
  ether: {
    entity: { kind: "task" },
    tasks: { items: [], ...(contract !== undefined ? { contract } : {}) },
  },
});

const region = (id: string): CanvasNode => ({
  id,
  type: "group",
  label: "Delivery",
  x: 0,
  y: 0,
  width: 1000,
  height: 1000,
  ether: {
    region: {
      instruction: "ship only what the operator asked for",
      contract: {
        rules: [{ id: "r-region", text: "no middle dots in copy" }],
        rulings: [
          { id: "r1", text: "prices stay in BRL", pinnedAt: "2026-08-01T00:00:00.000Z" },
        ],
      },
    },
  },
});

const flowEdge = (id: string, source: string, destination: string) => ({
  id,
  fromNode: source,
  toNode: destination,
  ether: { verb: "feeds" as const },
});

const task = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "01TASKTEST0000000000000000",
    state: "working",
    history: [
      {
        messageId: "01MSGTEST00000000000000000",
        role: "user",
        parts: [{ kind: "text", text: "Ship the briefing" }],
      },
    ],
    ...overrides,
  }) as Task;

const boardDoc: CanvasDoc = {
  nodes: [
    region("reg-delivery"),
    board("build", {
      instructions: "implement and gate the change",
      rules: [{ id: "r-sink", text: "typecheck is clean" }],
      incoming: { handling: "reproduce the defect before touching code" },
      outgoing: {
        handoff: "name the verified fix and cite the failing test it closes",
        checks: [{ id: "k1", label: "typecheck", command: "bun run typecheck" }],
      },
    }),
    board("review"),
  ],
  edges: [flowEdge("e1", "build", "review")],
};

describe("claim briefing board rules", () => {
  it("carries the board purpose, rules with provenance, rulings, and the next board", () => {
    const text = buildFactoryClaimPrompt({
      boardId: "build",
      task: task(),
      doc: boardDoc,
    });

    expect(text).toContain("What this board is for:");
    expect(text).toContain("implement and gate the change");
    expect(text).toContain("How work arriving here is handled:");
    expect(text).toContain("reproduce the defect before touching code");
    expect(text).toContain(
      "Write this in the handoff note when you send the task on (completion update \"handoffNote\"): name the verified fix and cite the failing test it closes",
    );
    expect(text).toContain("ship only what the operator asked for");
    expect(text).toContain("- no middle dots in copy  (id r-region, from region Delivery)");
    expect(text).toContain("- typecheck is clean  (id r-sink, from this board)");
    expect(text).toContain("prices stay in BRL");
    expect(text).toContain('sends the task to Tasks review (next: "review")');
    expect(text).toContain("outgoing: typecheck");
    expect(text).toContain("junto tasks check");
    expect(text).toContain("junto tasks rules");
    expect(text).toContain("completionEvidence.claims");
    expect(text).toContain("completionEvidence.waivers");
  });

  it("names the prior boards and the send-back when the task returns", () => {
    const text = buildFactoryClaimPrompt({
      boardId: "build",
      task: task({
        epoch: 1,
        visits: [
          {
            board: "review",
            enteredAt: "2026-08-02T00:00:00.000Z",
            epoch: 0,
            exitedAt: "2026-08-03T00:00:00.000Z",
            exit: "sent-back",
            next: "build",
            handoffNote: "the endpoint does not exist",
          },
        ],
      }),
      doc: boardDoc,
    });

    expect(text).toContain("Where this task has already been:");
    expect(text).toContain("- Tasks review (sent-back): the endpoint does not exist");
    expect(text).toContain("sent back to you (epoch 1)");
  });

  it("stays at the base contract without a document", () => {
    const text = buildFactoryClaimPrompt({ boardId: "build", task: task() });
    expect(text).not.toContain("Rules in force here");
    expect(text).toContain("[factory claim] task");
  });

  it("mirrors the board guidance into the JSON briefing", () => {
    const text = buildFactoryClaimPrompt({
      boardId: "build",
      task: task(),
      doc: boardDoc,
    });
    const briefing = JSON.parse(text.split("--- task briefing (JSON) ---")[1]!);
    expect(briefing.guidance).toEqual({
      instructions: "implement and gate the change",
      handling: "reproduce the defect before touching code",
      handoff: "name the verified fix and cite the failing test it closes",
    });
    // The shared Tasks-node projection uses instructions as the display
    // fallback, and they also travel first-class in guidance.
    expect(briefing.board).toEqual({ name: "implement and gate the change" });
    expect(briefing.rules).toEqual([
      { id: "r-region", text: "no middle dots in copy", from: "region Delivery" },
      { id: "r-sink", text: "typecheck is clean", from: "this board" },
    ]);
    expect(briefing.next).toEqual([
      { nodeId: "review", name: "Tasks review" },
    ]);
  });

  it("never surfaces blank handling, and drops handoff at a terminal board", () => {
    const terminalBoard: CanvasDoc = {
      nodes: [
        board("terminal", {
          instructions: "close the work",
          incoming: { handling: "   " },
          outgoing: { handoff: "hand off cleanly" },
        }),
      ],
      edges: [],
    };
    const text = buildFactoryClaimPrompt({
      boardId: "terminal",
      task: task(),
      doc: terminalBoard,
    });
    expect(text).not.toContain("How work arriving here is handled:");
    expect(text).not.toContain("handoff note");
    const briefing = JSON.parse(text.split("--- task briefing (JSON) ---")[1]!);
    expect(briefing.guidance).toEqual({ instructions: "close the work" });
  });
});
