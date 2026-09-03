import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { Task, TasksSinkContract } from "../src/shared/work-model";
import { buildFactoryClaimPrompt } from "../src/shared/factory-claim-prompt";

const sink = (id: string, contract?: TasksSinkContract): CanvasNode => ({
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
        claims: [{ id: "c-region", text: "no middle dots in copy", severity: "hard" }],
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
        parts: [{ kind: "text", text: "Ship the packet" }],
      },
    ],
    ...overrides,
  }) as Task;

const board: CanvasDoc = {
  nodes: [
    region("reg-delivery"),
    sink("build", {
      instruction: "implement and gate the change",
      claims: [{ id: "c-sink", text: "typecheck is clean", severity: "soft" }],
      inbound: { instruction: "reproduce the defect before touching code" },
      outbound: {
        emission: "name the verified fix and cite the failing test it closes",
        checklist: [{ id: "k1", label: "typecheck", command: "bun run typecheck" }],
      },
    }),
    sink("review"),
  ],
  edges: [flowEdge("e1", "build", "review")],
};

describe("claim packet station law", () => {
  it("carries the station purpose, claims with provenance, rulings, and the forward move", () => {
    const text = buildFactoryClaimPrompt({
      sinkNodeId: "build",
      task: task(),
      doc: board,
    });

    expect(text).toContain("What this station is for:");
    expect(text).toContain("implement and gate the change");
    expect(text).toContain("How work arriving here is handled:");
    expect(text).toContain("reproduce the defect before touching code");
    expect(text).toContain(
      "What this station publishes forward (put this in your completion note): name the verified fix and cite the failing test it closes",
    );
    expect(text).toContain("ship only what the operator asked for");
    expect(text).toContain("[hard] no middle dots in copy");
    expect(text).toContain("from region Delivery");
    expect(text).toContain("[soft] typecheck is clean");
    expect(text).toContain("from this station");
    expect(text).toContain("prices stay in BRL");
    expect(text).toContain('sends the task to Tasks review (next: "review")');
    expect(text).toContain("outbound: typecheck");
    expect(text).toContain("vellum-command tasks board");
  });

  it("names the prior stations and the send-back when the task returns", () => {
    const text = buildFactoryClaimPrompt({
      sinkNodeId: "build",
      task: task({
        epoch: 1,
        journey: [
          {
            nodeId: "review",
            enteredAt: "2026-08-02T00:00:00.000Z",
            epoch: 0,
            exitedAt: "2026-08-03T00:00:00.000Z",
            exit: "rejected-back",
            emissionNote: "the endpoint does not exist",
          },
        ],
      }),
      doc: board,
    });

    expect(text).toContain("Where this task has already been:");
    expect(text).toContain("- Tasks review (rejected-back): the endpoint does not exist");
    expect(text).toContain("sent back to you (epoch 1)");
  });

  it("stays at the base contract without a document", () => {
    const text = buildFactoryClaimPrompt({ sinkNodeId: "build", task: task() });
    expect(text).not.toContain("Claims in force here");
    expect(text).toContain("[factory claim] task");
  });

  it("mirrors the station guidance into the JSON packet", () => {
    const text = buildFactoryClaimPrompt({
      sinkNodeId: "build",
      task: task(),
      doc: board,
    });
    const packet = JSON.parse(text.split("--- task packet (JSON) ---")[1]!);
    expect(packet.guidance).toEqual({
      instruction: "implement and gate the change",
      triage: "reproduce the defect before touching code",
      emission: "name the verified fix and cite the failing test it closes",
    });
    expect(packet.station).toEqual({
      name: "implement and gate the change",
      role: "implement and gate the change",
    });
    expect(packet.forwardStations).toEqual([
      { nodeId: "review", name: "Tasks review" },
    ]);
  });

  it("never surfaces blank triage, and drops emission at a terminal station", () => {
    const terminalBoard: CanvasDoc = {
      nodes: [
        sink("terminal", {
          instruction: "close the journey",
          inbound: { instruction: "   " },
          outbound: { emission: "hand off cleanly" },
        }),
      ],
      edges: [],
    };
    const text = buildFactoryClaimPrompt({
      sinkNodeId: "terminal",
      task: task(),
      doc: terminalBoard,
    });
    expect(text).not.toContain("How work arriving here is handled:");
    expect(text).not.toContain("publishes forward");
    const packet = JSON.parse(text.split("--- task packet (JSON) ---")[1]!);
    expect(packet.guidance).toEqual({ instruction: "close the journey" });
  });
});
