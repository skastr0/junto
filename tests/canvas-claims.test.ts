import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  containsWorkProjection,
  decodeCanvasDoc,
  resolveSinkAdmission,
  serializeCanvas,
} from "../src/shared/canvas";

// Region + sink contracts and the task pipeline hop: authorial ether additions.
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
  claims: [
    { id: "01CLAIM", text: "No secrets in the diff", severity: "hard" },
    { id: "01SOFT", text: "Screenshots attached", severity: "soft" },
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

const sinkContract = {
  instruction: "Review stage: verify before forwarding.",
  claims: [{ id: "01SINK", text: "Diff read end to end", severity: "hard" }],
  inbound: {
    instruction: "Triage arrivals by severity.",
    description: "Code review station",
    admission: "operator-gated",
    claimableAfterMs: 60_000,
    checklist: [{ id: "01IN", label: "typecheck", command: "bun run typecheck" }],
  },
  outbound: {
    emission: "Publishes a reviewed diff.",
    description: "Reviewed work",
    checklist: [{ id: "01OUT", label: "tests", command: "bun run test" }],
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
        tasks: { items: [], contract: sinkContract },
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

describe("pipeline claims canvas contract", () => {
  it("decodes region contract, sink contract and edge verb and round-trips", () => {
    const decoded = Result.getOrThrow(decodeCanvasDoc(rawDoc));

    const region = decoded.nodes.find((n) => n.id === "region-1");
    expect(region?.ether?.region?.contract?.claims?.[0]?.severity).toBe("hard");
    expect(region?.ether?.region?.contract?.rulings?.[0]?.pinnedAt).toBe(
      "2026-08-20T12:00:00.000Z",
    );

    const sink = decoded.nodes.find((n) => n.id === "sink-a");
    expect(sink?.ether?.tasks?.contract?.inbound?.admission).toBe("operator-gated");
    expect(sink?.ether?.tasks?.contract?.inbound?.claimableAfterMs).toBe(60_000);
    expect(sink?.ether?.tasks?.contract?.outbound?.checklist?.[0]?.command).toBe(
      "bun run test",
    );

    const again = Result.getOrThrow(
      decodeCanvasDoc(JSON.parse(serializeCanvas(decoded))),
    );
    expect(again).toEqual(decoded);
  });

  it("the pipeline hop survives the input scrub as its verb", () => {
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
    ["claim severity", { claims: [{ id: "x", text: "t", severity: "urgent" }] }],
    ["empty claim text", { claims: [{ id: "x", text: "", severity: "hard" }] }],
    ["excess contract key", { claims: [], taxonomy: ["never"] }],
  ] as const)("rejects invalid region contract: %s", (_label, contract) => {
    const doc = {
      nodes: [{ ...group("region-1"), ether: { region: { contract } } }],
      edges: [],
    };
    expect(Result.isFailure(decodeCanvasDoc(doc))).toBe(true);
  });

  it.each([
    ["admission word", { inbound: { admission: "seat-gated" } }],
    ["negative bake time", { inbound: { claimableAfterMs: -1 } }],
    ["fractional bake time", { inbound: { claimableAfterMs: 1.5 } }],
    ["empty check command", { inbound: { checklist: [{ id: "c", label: "l", command: "" }] } }],
  ] as const)("rejects invalid sink contract: %s", (_label, contract) => {
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

  it("resolveSinkAdmission defaults to auto", () => {
    expect(resolveSinkAdmission(undefined)).toBe("auto");
    expect(resolveSinkAdmission({})).toBe("auto");
    expect(resolveSinkAdmission({ inbound: {} })).toBe("auto");
    expect(resolveSinkAdmission({ inbound: { admission: "operator-owned" } })).toBe(
      "operator-owned",
    );
  });
});

describe("containsWorkProjection with sink contracts", () => {
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

  it("keeps flagging every non-tasks work lane by presence", () => {
    for (const key of ["requests", "messages", "artifacts", "board", "pad"]) {
      const doc = {
        nodes: [{ ...node("n"), ether: { [key]: { items: [] } } }],
        edges: [],
      };
      expect(containsWorkProjection(doc)).toBe(true);
    }
  });

  it("does not flag an authorial contract-only tasks bag", () => {
    const authorial = {
      nodes: [
        {
          ...node("sink-a"),
          ether: {
            entity: { kind: "task" },
            tasks: { items: [], contract: sinkContract },
          },
        },
      ],
      edges: [],
    };
    expect(containsWorkProjection(authorial)).toBe(false);
  });
});
