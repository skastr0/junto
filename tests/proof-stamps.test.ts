import { describe, expect, it } from "vitest";
import type { Artifact } from "../src/shared/canvas";
import {
  StampRuntime,
  artifactPublishAuthority,
  extractProofStamp,
  findMatchingStamp,
  operatorHumanAuthority,
} from "../src/shared/proof-stamps";

const artifact = (meta: Record<string, unknown> | undefined, id = "art-1"): Artifact => ({
  artifactId: id,
  parts: [{ kind: "text", text: "evidence" }],
  ...(meta ? { metadata: meta } : {}),
});

describe("extractProofStamp", () => {
  const auth = artifactPublishAuthority({
    canvasName: "board",
    seat: "agent-1",
    occupant: "proc:42",
    sinkNodeId: "sink-1",
  });

  it("returns null for plain artifacts without proof metadata", () => {
    expect(extractProofStamp(auth, artifact(undefined))).toBeNull();
    expect(extractProofStamp(auth, artifact({ name: "x" }))).toBeNull();
  });

  it("builds a stamp only with step + inputsHash under admitted authority", () => {
    const stamp = extractProofStamp(
      auth,
      artifact({ step: "build", inputsHash: "abc", evidenceRefs: ["ref-a"] }),
      99,
    );
    expect(stamp).toEqual({
      step: "build",
      seat: "agent-1",
      occupant: "proc:42",
      inputsHash: "abc",
      evidenceRefs: ["ref-a", "art-1"],
      ts: 99,
    });
  });

  it("accepts proofStep alias and requires non-empty inputsHash", () => {
    expect(
      extractProofStamp(auth, artifact({ proofStep: "x", inputsHash: "" })),
    ).toBeNull();
    const stamp = extractProofStamp(
      auth,
      artifact({ proofStep: " ship ", inputsHash: " h2 " }),
    );
    expect(stamp?.step).toBe("ship");
    expect(stamp?.inputsHash).toBe("h2");
  });
});

describe("StampRuntime — I16 only-writer", () => {
  it("records stamp only via admitted-artifact-publish authority", () => {
    const runtime = new StampRuntime();
    const auth = artifactPublishAuthority({
      canvasName: "c1",
      seat: "agent-1",
      occupant: "proc:7",
      sinkNodeId: "sink",
    });
    const stamp = extractProofStamp(
      auth,
      artifact({ step: "build", inputsHash: "h1" }),
      1,
    )!;
    runtime.recordStamp(auth, stamp);
    const view = runtime.stampView("c1");
    expect(findMatchingStamp(view.get("sink"), "build", "h1")).toEqual(stamp);
  });

  it("rejects seat/occupant mismatch (forged stamp body under real authority)", () => {
    const runtime = new StampRuntime();
    const auth = artifactPublishAuthority({
      canvasName: "c1",
      seat: "agent-1",
      occupant: "proc:7",
      sinkNodeId: "sink",
    });
    expect(() =>
      runtime.recordStamp(auth, {
        step: "build",
        seat: "forged-seat",
        occupant: "proc:7",
        inputsHash: "h1",
        evidenceRefs: [],
        ts: 1,
      }),
    ).toThrow(/seat\/occupant/);
  });

  it("human approval requires operator authority and principal human", () => {
    const runtime = new StampRuntime();
    runtime.recordApproval(operatorHumanAuthority(), "c1", {
      step: "ship",
      principal: "human",
      ts: 2,
    });
    expect(runtime.approvalView("c1").get("ship")?.principal).toBe("human");

    // Agent-shaped principal is unrepresentable at the type level; runtime also rejects.
    expect(() =>
      runtime.recordApproval(operatorHumanAuthority(), "c1", {
        step: "ship",
        // @ts-expect-error — only human is legal
        principal: "agent-1",
        ts: 3,
      }),
    ).toThrow(/human/);
  });

  it("inputsHash replay: old stamp remains but does not match new hash", () => {
    const runtime = new StampRuntime();
    const auth = artifactPublishAuthority({
      canvasName: "c1",
      seat: "a",
      occupant: "o",
      sinkNodeId: "sink",
    });
    runtime.recordStamp(auth, {
      step: "build",
      seat: "a",
      occupant: "o",
      inputsHash: "old",
      evidenceRefs: ["e1"],
      ts: 1,
    });
    // New inputs — separate stamp entry
    runtime.recordStamp(auth, {
      step: "build",
      seat: "a",
      occupant: "o",
      inputsHash: "new",
      evidenceRefs: ["e2"],
      ts: 2,
    });
    const list = runtime.stampView("c1").get("sink")!;
    expect(findMatchingStamp(list, "build", "old")?.evidenceRefs).toEqual(["e1"]);
    expect(findMatchingStamp(list, "build", "new")?.evidenceRefs).toEqual(["e2"]);
    expect(findMatchingStamp(list, "build", "other")).toBeUndefined();
  });
});
