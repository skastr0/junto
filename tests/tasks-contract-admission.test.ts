/**
 * Admission is deleted (plan 04), but task nodes stored before 0.10 may
 * still carry `incoming.admission`. Node decoding is strict, so the contract
 * keeps the key decode only: such a node still decodes, and nothing reads it.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { decodeNode } from "../src/shared/model/kinds";

describe("a stored task node with incoming.admission", () => {
  it("still decodes under the strict node decoder", () => {
    const stored = {
      kind: "task",
      id: "tasks-build",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      z: 1,
      contract: { incoming: { admission: "operator", handling: "triage first" } },
    };
    expect(Exit.isSuccess(Effect.runSyncExit(decodeNode(stored)))).toBe(true);
    const unknown = { ...stored, contract: { incoming: { admitted: "operator" } } };
    expect(Exit.isFailure(Effect.runSyncExit(decodeNode(unknown)))).toBe(true);
  });
});
