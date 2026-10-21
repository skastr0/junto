import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { OpListArgs, OpShowArgs, opViewOf, unknownOpError, type OpView } from "../src/shared/op-control";
import { OpId } from "../src/shared/work-ids";

const opId = OpId.make("01M5EW2K9M5CN3Z3VP1J5EFB0Y");
const root = OpId.make("01M5EVZDWM5MH030RRNPAANP29");

describe("op show: what became of a write", () => {
  it("is queued with a queued row and no ruling, and unknown with neither", () => {
    expect(opViewOf(opId, undefined, true)).toEqual(Result.succeed({ state: "queued", opId }));
    expect(opViewOf(opId, undefined, false)).toEqual(Result.succeed(undefined));
  });

  it("reads an applied ruling with what the domain made", () => {
    const task = opViewOf(opId, { kind: "applied", rulingJson: JSON.stringify({ kind: "applied", taskId: root }) }, true);
    expect(task).toEqual(Result.succeed({ state: "applied", opId, made: { taskId: root } }));
    const artifact = opViewOf(opId, { kind: "applied", rulingJson: JSON.stringify({ kind: "applied", artifactId: root, version: 3 }) }, false);
    expect(artifact).toEqual(Result.succeed({ state: "applied", opId, made: { artifactId: root, version: 3 } }));
  });

  it("reads a refused ruling with its typed error and root, over a queued row", () => {
    const error = { type: "Stale", message: "moved", details: { reason: "stale", retryable: true, expected: "4" } } as const;
    const view = opViewOf(opId, { kind: "refused", rulingJson: JSON.stringify({ kind: "refused", error, root }) }, true);
    expect(view).toEqual(Result.succeed({ state: "refused", opId, error, root }));
  });

  it("fails on a ruling it cannot read rather than guess", () => {
    for (const row of [
      { kind: "applied", rulingJson: "{" },
      { kind: "applied", rulingJson: JSON.stringify({ kind: "refused" }) },
      { kind: "refused", rulingJson: JSON.stringify({ kind: "refused", error: { type: "Nope", message: "x" }, root }) },
      { kind: "refused", rulingJson: JSON.stringify({ kind: "refused", error: { type: "Stale", message: "x" }, root: "op-1" }) },
      { kind: "held", rulingJson: JSON.stringify({ kind: "held" }) },
    ]) {
      expect(Result.isFailure(opViewOf(opId, row, false))).toBe(true);
    }
  });

  it("refuses an unknown opId as UnknownTarget naming it", () => {
    expect(unknownOpError(opId)).toMatchObject({ type: "UnknownTarget", details: { opId, retryable: false } });
  });
});

describe("op args", () => {
  it("show takes one opId and nothing else", () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(OpShowArgs)({ opId }))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(OpShowArgs)({ opId: "op-1" }))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(OpShowArgs)({ opId, seat: "x" }))).toBe(true);
  });

  it("list filters on queued or refused, never applied, with a bounded limit", () => {
    const decode = Schema.decodeUnknownResult(OpListArgs);
    for (const ok of [{}, { state: "queued" }, { state: "refused", limit: 200 }, { before: opId }]) expect(Result.isSuccess(decode(ok))).toBe(true);
    for (const bad of [{ state: "applied" }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { before: "op-1" }]) expect(Result.isFailure(decode(bad))).toBe(true);
  });

  it("an op view's state is closed", () => {
    const states: ReadonlyArray<OpView["state"]> = ["queued", "applied", "refused"];
    // @ts-expect-error a write is never pending in a ruling's view
    const pending: OpView["state"] = "pending";
    expect(states).not.toContain(pending);
  });
});
