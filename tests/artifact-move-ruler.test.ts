/**
 * The ruler judges where a move goes (0.11.1, 10): only to an Artifacts node,
 * whatever machine proposed it. A queued move from a machine that skipped
 * the window's check is refused at ruling, and the store is never asked.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { artifactRuler } from "../src/main/junto/work/resource-ruler";
import type { QueuedCommand } from "../src/shared/command-row";
import { InstallationId } from "../src/shared/installation-id";
import { OpId } from "../src/shared/work-ids";
import { artifacts, canvasOf, region, seat, taskBoard } from "./support/model-nodes";

const MINI = InstallationId.make("01M62AA00000000000000MINI0");
const board = canvasOf([
  region("R", { x: 0, y: 0, width: 1000, height: 1000 }),
  seat("S", { x: 10, y: 10 }),
  taskBoard("T", { x: 300, y: 10 }),
  artifacts("A", { x: 600, y: 10 }),
  artifacts("B", { x: 800, y: 10 }),
]);

const move = (to: string) =>
  ({
    opId: OpId.make("01M62AA0000000000000000009"),
    canvasName: "factory",
    actor: { kind: "operator" },
    target: { kind: "artifact", nodeId: "A", itemId: "01M62AA0000000000000000001" },
    basis: null,
    after: [],
    op: { op: "move", to },
  }) as unknown as QueuedCommand;

describe("the artifact ruler, on a move", () => {
  const asked: Array<unknown> = [];
  const repo = {
    submit: (_writer: unknown, command: unknown) =>
      Effect.sync(() => {
        asked.push(command);
        return { kind: "applied", opId: move("B").opId, artifactId: "x", version: 1, facts: [] };
      }),
  } as unknown as ArtifactRepository["Service"];
  const rule = artifactRuler(repo);

  it("refuses a queued move to a task node, a seat or a node not on the canvas, before the store", async () => {
    for (const to of ["T", "S", "gone"]) {
      expect(await Effect.runPromise(rule(MINI, move(to), board))).toEqual({
        kind: "refuse",
        refusal: { reason: "unknown_target", message: "An artifact moves only to an Artifacts node on this canvas" },
      });
    }
    expect(asked).toEqual([]);
  });

  it("rules a move to an Artifacts node in the store", async () => {
    expect(await Effect.runPromise(rule(MINI, move("B"), board))).toEqual({ kind: "ruled" });
    expect(asked).toHaveLength(1);
  });
});
