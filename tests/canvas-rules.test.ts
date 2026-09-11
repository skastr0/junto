import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  containsWorkProjection,
  decodeCanvasDoc,
  serializeCanvas,
} from "../src/shared/canvas";
import { resolveTaskAdmission } from "../src/shared/work-model";

// Region + board contracts and the task path hop: authorial ether additions.
// The JSON Canvas invariant must hold — stripping ether leaves a valid doc.

const node = (id: string) => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
});

const group = (id: string) => ({
  id,
  type: "group",
  label: id,
  x: -50,
  y: -50,
  width: 900,
  height: 600,
});

const regionContract = {
  rules: [
    { id: "01RULE", text: "No secrets in the diff" },
    { id: "01SECOND", text: "Screenshots attached" },
  ],
  rulings: [
    {
      id: "01RULING",
      text: "Feature flags default off",
      pinnedAt: "2026-08-20T12:00:00.000Z",
      sourceRequestId: "req-1",
    },
  ],
};

const boardContract = {
  instructions: "Review board: verify before sending on.",
  rules: [{ id: "01BOARD", text: "Diff read end to end" }],
  incoming: {
    handling: "Triage new tasks.",
    description: "Code review board",
    admission: "operator",
    waitMs: 60_000,
    checks: [{ id: "01IN", label: "typecheck", command: "bun run typecheck" }],
  },
  outgoing: {
    handoff: "Publishes a reviewed diff.",
    description: "Reviewed work",
    checks: [{ id: "01OUT", label: "tests", command: "bun run test" }],
  },
};

const rawDoc = {
  nodes: [
    {
      ...group("region-1"),
      ether: {
        region: {
          instruction: "Work in this repo",
          contract: regionContract,
        },
      },
    },
    {
      ...node("sink-a"),
      ether: {
        entity: { kind: "task" },
        tasks: { items: [], contract: boardContract },
      },
    },
    { ...node("sink-b"), ether: { entity: { kind: "task" } } },
  ],
  edges: [
    {
      id: "flow-1",
      fromNode: "sink-a",
      toNode: "sink-b",
      ether: { verb: "feeds" },
    },
  ],
};

describe("board rules canvas contract", () => {
  it("decodes region contract, board contract and edge verb and round-trips", () => {
    const decoded = Result.getOrThrow(decodeCanvasDoc(rawDoc));

    const region = decoded.nodes.find((n) => n.id === "region-1");
    expect(region?.ether?.region?.contract?.rules?.[0]?.text).toBe(
      "No secrets in the diff",
    );
    expect(region?.ether?.region?.contract?.rulings?.[0]?.pinnedAt).toBe(
      "2026-08-20T12:00:00.000Z",
    );

    const board = decoded.nodes.find((n) => n.id === "sink-a");
    expect(board?.ether?.tasks?.contract?.incoming?.admission).toBe("operator");
    expect(board?.ether?.tasks?.contract?.incoming?.waitMs).toBe(60_000);
    expect(board?.ether?.tasks?.contract?.outgoing?.checks?.[0]?.command).toBe(
      "bun run test",
    );

    const again = Result.getOrThrow(
      decodeCanvasDoc(JSON.parse(serializeCanvas(decoded))),
    );
    expect(again).toEqual(decoded);
  });

  it("the task path hop survives the input scrub as its verb", () => {
    const decoded = Result.getOrThrow(decodeCanvasDoc(rawDoc));
    expect(decoded.edges[0]?.ether?.verb).toBe("feeds");
    // The verb is the whole edge ether — nothing else rides along.
    expect(decoded.edges[0]?.ether).toEqual({ verb: "feeds" });
  });

  it("still decodes once every ether key is stripped (JSON Canvas invariant)", () => {
    const stripped = {
      nodes: rawDoc.nodes.map(({ ether: _e, ...rest }) => rest),
      edges: rawDoc.edges.map(({ ether: _e, ...rest }) => rest),
    };
    expect(Result.isSuccess(decodeCanvasDoc(stripped))).toBe(true);
  });

  it.each([
    ["retired rule severity", { rules: [{ id: "x", text: "t", severity: "urgent" }] }],
    ["empty rule text", { rules: [{ id: "x", text: "" }] }],
    ["excess contract key", { rules: [], taxonomy: ["never"] }],
  ] as const)("rejects invalid region contract: %s", (_label, contract) => {
    const doc = {
      nodes: [{ ...group("region-1"), ether: { region: { contract } } }],
      edges: [],
    };
    expect(Result.isFailure(decodeCanvasDoc(doc))).toBe(true);
  });

  it.each([
    ["admission word", { incoming: { admission: "seat-gated" } }],
    ["negative wait", { incoming: { waitMs: -1 } }],
    ["fractional wait", { incoming: { waitMs: 1.5 } }],
    ["empty check command", { incoming: { checks: [{ id: "c", label: "l", command: "" }] } }],
  ] as const)("rejects invalid board contract: %s", (_label, contract) => {
    const doc = {
      nodes: [
        {
          ...node("sink-a"),
          ether: { entity: { kind: "task" }, tasks: { items: [], contract } },
        },
      ],
      edges: [],
    };
    expect(Result.isFailure(decodeCanvasDoc(doc))).toBe(true);
  });

  it("resolveTaskAdmission defaults to auto", () => {
    expect(resolveTaskAdmission(undefined)).toBe("auto");
    expect(resolveTaskAdmission({})).toBe("auto");
    expect(resolveTaskAdmission({ incoming: {} })).toBe("auto");
    expect(
      resolveTaskAdmission({ incoming: { admission: "operator" as const } }),
    ).toBe("operator");
  });
});

describe("containsWorkProjection with board contracts", () => {
  it("keeps flagging projected work rows", () => {
    const projected = {
      nodes: [
        {
          ...node("sink-a"),
          ether: {
            tasks: { items: [{ id: "t1", state: "submitted", history: [] }] },
          },
        },
      ],
      edges: [],
    };
    expect(containsWorkProjection(projected)).toBe(true);
  });

  it("keeps flagging presence-only lanes by presence; row lanes need rows", () => {
    // messages / artifacts / board / pad are pure runtime projections — any
    // presence counts. tasks / requests carry operator-authored document
    // truth (tasks contract + name; requests name), so only projected rows
    // make them a work projection.
    for (const key of ["messages", "artifacts", "board", "pad"]) {
      const doc = {
        nodes: [{ ...node("n"), ether: { [key]: { items: [] } } }],
        edges: [],
      };
      expect(containsWorkProjection(doc)).toBe(true);
    }
    for (const key of ["tasks", "requests"]) {
      const doc = {
        nodes: [{ ...node("n"), ether: { [key]: { items: [] } } }],
        edges: [],
      };
      expect(containsWorkProjection(doc)).toBe(false);
    }
  });

  it("flags a requests lane with projected rows", () => {
    const projected = {
      nodes: [
        {
          ...node("n"),
          ether: {
            requests: { items: [{ id: "q1", state: "input-required", history: [] }] },
          },
        },
      ],
      edges: [],
    };
    expect(containsWorkProjection(projected)).toBe(true);
  });

  it("does not flag an authorial contract-only tasks bag", () => {
    const authorial = {
      nodes: [
        {
          ...node("sink-a"),
          ether: {
            entity: { kind: "task" },
            tasks: { items: [], contract: boardContract },
          },
        },
      ],
      edges: [],
    };
    expect(containsWorkProjection(authorial)).toBe(false);
  });
});
