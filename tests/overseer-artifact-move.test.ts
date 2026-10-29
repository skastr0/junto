/**
 * `junto overseer artifact move` (docs/plans/0.11/10 M3): the args, the
 * overseer handler over main's one entry point, and the exit rule. The run,
 * its rows and their sentences are M1's (`shared/artifact-move.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import { Result } from "effect";
import { decodeOverseerArgs, isOverseerMutation, OVERSEER_CATALOG } from "../src/shared/overseer-control";
import {
  ARTIFACT_MOVE_MAX,
  ARTIFACT_MOVE_REFUSAL_REASON,
  summarizeArtifactMoveRun,
  type ArtifactMoveRun,
  type ArtifactMoveRunRow,
} from "../src/shared/artifact-move";
import type { ItemId } from "../src/shared/work-ids";
import type { NodeId } from "../src/shared/physics/schema";
import {
  ARTIFACT_MOVE_FAILED,
  ARTIFACT_MOVE_MISSING,
  executeOverseerArtifactMove,
} from "../src/main/junto/overseer/artifact-move";
import { offboardRefusedAny, overseerExamples } from "../src/cli/commands/overseer";
import { OVERSEER_SKILL_MARKDOWN } from "../src/cli/commands/overseer-skill";

const caller = { canvasName: "factory", nodeId: "boss" };
const actor = { seatId: "seat-boss" } as never;
const A = "01M5ESMQ2ZT55QZ073EWPH10SG";
const B = "01M5ESMQ2ZT55QZ073EWPH10SH";
const GONE = "01M5ESMQ2ZT55QZ073EWPH10SJ";
const ids = (...list: string[]) => list as ItemId[];

const ok = (args: unknown) => Result.isSuccess(decodeOverseerArgs("artifact.move", args));

/** A stand-in for main's run: A moves, B is already there, anything else is not found. */
const fakeRun = () =>
  vi.fn<ArtifactMoveRun>(async ({ artifactIds, toNode }) => {
    if (toNode !== "release") return { ok: false, code: "not_found", message: "no Artifacts node release-2 on this canvas" };
    return {
      ok: true,
      ...summarizeArtifactMoveRun(artifactIds.map((artifactId): ArtifactMoveRunRow =>
        artifactId === A
          ? { artifactId, title: "Plan", ok: true, outcome: "moved", from: "specs" as NodeId, to: toNode }
          : artifactId === B
            ? { artifactId, title: "Notes", ok: true, outcome: "unchanged", from: toNode, to: toNode }
            : { artifactId, ok: false, code: "not-found", reason: ARTIFACT_MOVE_REFUSAL_REASON["not-found"] })),
    };
  });

describe("artifact.move args", () => {
  it("takes 1 to 100 distinct artifact ids, a target node and a canvas", () => {
    expect(ok({ artifactIds: [A], to: "release" })).toBe(true);
    expect(ok({ canvas: "work", artifactIds: [A, B], to: "release" })).toBe(true);
    const many = (count: number) => Array.from({ length: count }, (_, index) => `01M5ESMQ2ZT55QZ073EW${String(index).padStart(6, "0")}`);
    expect(ARTIFACT_MOVE_MAX).toBe(100);
    expect(ok({ artifactIds: many(100), to: "release" })).toBe(true);
    expect(ok({ artifactIds: many(101), to: "release" })).toBe(false);
  });

  it("refuses no ids, a repeated id, an id that is not an artifact id, no target, and stray keys", () => {
    expect(ok({ artifactIds: [], to: "release" })).toBe(false);
    expect(ok({ artifactIds: [A, A], to: "release" })).toBe(false);
    const repeated = decodeOverseerArgs("artifact.move", { artifactIds: [A, B, A], to: "release" });
    expect(Result.isFailure(repeated) && repeated.failure.message).toContain("name each artifact once");
    expect(ok({ artifactIds: ["plan"], to: "release" })).toBe(false);
    expect(ok({ artifactIds: [A] })).toBe(false);
    expect(ok({ artifactIds: [A], to: "" })).toBe(false);
    expect(ok({ artifactIds: [A], to: "release", from: "specs" })).toBe(false);
  });

  it("is an overseer mutation in the catalog, family artifact, verb move", () => {
    expect(isOverseerMutation("artifact.move")).toBe(true);
    expect(OVERSEER_CATALOG).toContainEqual({ operation: "artifact.move", family: "artifact", verb: "move", mutation: true });
  });
});

describe("artifact.move", () => {
  it("makes one call on the caller's canvas as the overseer seat, and returns main's rows unchanged", async () => {
    const run = fakeRun();
    const outcome = await executeOverseerArtifactMove(caller, { artifactIds: ids(A, B, GONE), to: "release" }, actor, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      { canvasName: "factory", artifactIds: [A, B, GONE], toNode: "release" },
      { kind: "seat", seatId: "seat-boss", nodeId: "boss" },
    );
    expect(outcome).toEqual({
      ok: true,
      data: {
        results: [
          { artifactId: A, title: "Plan", ok: true, outcome: "moved", from: "specs", to: "release" },
          { artifactId: B, title: "Notes", ok: true, outcome: "unchanged", from: "release", to: "release" },
          { artifactId: GONE, ok: false, code: "not-found", reason: ARTIFACT_MOVE_REFUSAL_REASON["not-found"] },
        ],
        moved: 1,
        refused: 1,
      },
    });
    expect(offboardRefusedAny(outcome.ok ? outcome.data : undefined)).toBe(true);
  });

  it("moves on the canvas named", async () => {
    const run = fakeRun();
    await executeOverseerArtifactMove(caller, { canvas: "work", artifactIds: ids(A), to: "release" }, actor, run);
    expect(run.mock.calls[0]![0]).toMatchObject({ canvasName: "work" });
  });

  it("fails the whole call for a target that is not an Artifacts node, with main's message", async () => {
    expect(await executeOverseerArtifactMove(caller, { artifactIds: ids(A), to: "release-2" }, actor, fakeRun())).toEqual({
      ok: false,
      error: { type: "NotFound", message: "no Artifacts node release-2 on this canvas" },
    });
    const notAShelf: ArtifactMoveRun = async () => ({ ok: false, code: "invalid_input", message: "planner is a seat, not an Artifacts node" });
    expect(await executeOverseerArtifactMove(caller, { artifactIds: ids(A), to: "planner" }, actor, notAShelf)).toEqual({
      ok: false,
      error: { type: "InvalidArguments", message: "planner is a seat, not an Artifacts node" },
    });
  });

  it("says so when this build has no move, and never repeats main's own failure", async () => {
    expect(await executeOverseerArtifactMove(caller, { artifactIds: ids(A), to: "release" }, actor, undefined)).toEqual({
      ok: false,
      error: { type: "Unsupported", message: ARTIFACT_MOVE_MISSING },
    });
    const broken: ArtifactMoveRun = async () => {
      throw new Error("SQLITE_BUSY at /Users/x/.junto/junto.db");
    };
    expect(await executeOverseerArtifactMove(caller, { artifactIds: ids(A), to: "release" }, actor, broken)).toEqual({
      ok: false,
      error: { type: "InternalError", message: ARTIFACT_MOVE_FAILED },
    });
  });
});

describe("artifact move in the CLI", () => {
  it("exits non-zero only when an artifact was refused", () => {
    expect(offboardRefusedAny({ results: [], moved: 2, refused: 0 })).toBe(false);
    expect(offboardRefusedAny({ results: [], moved: 1, refused: 1 })).toBe(true);
  });

  it("has an example whose input decodes, and the skill says the rows and the exit rule", () => {
    const examples = overseerExamples.filter((example) => example.command_id === "overseer.artifact.move");
    expect(examples).toHaveLength(1);
    expect(ok(examples[0]!.input)).toBe(true);
    expect(OVERSEER_SKILL_MARKDOWN).toContain("artifact move {artifactIds, to, canvas?}");
    expect(OVERSEER_SKILL_MARKDOWN).toContain("`unchanged` when it was already on `to` (a retry is not a refusal)");
  });
});
