/**
 * A comment wakes the change triggers of its task or artifact as soon as its
 * row commits (07): a notice that fails after it still leaves the comment
 * standing, and its wake told.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { onResourceChanged } from "../src/main/junto/work/resource-changes";
import { WorkService } from "../src/main/junto/work/service";
import { postSubjectComment } from "../src/main/junto/work/subject-comment";
import { asNodeId, type Canvas, type Node } from "../src/shared/model";
import { ItemId, OpId } from "../src/shared/work-ids";

const ARTIFACTS = asNodeId("artifacts-1");
const SEAT = asNodeId("agent-a");
const canvas = {
  name: "factory",
  nodes: new Map([[ARTIFACTS, { id: ARTIFACTS, kind: "artifacts", x: 0, y: 0, width: 240, height: 160 } as unknown as Node]]),
  wires: new Map(),
} as unknown as Canvas;

const comment = (work: Partial<WorkService["Service"]>) =>
  postSubjectComment(
    {
      subject: { kind: "artifact", nodeId: ARTIFACTS, artifactId: ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ70") },
      text: "Looks good",
      actor: { kind: "operator" },
      opId: OpId.make("01M5ESKJFC1A88R1MH1NEZWJ71"),
    },
    { canvas, canvasName: "factory", people: [SEAT] },
  ).pipe(
    Effect.provideService(WorkService, work as WorkService["Service"]),
    Effect.provideService(MachineRepository, { installationId: Effect.succeed("mini") } as unknown as MachineRepository["Service"]),
  );

describe("a comment's wake", () => {
  it("is told once the row commits, even when a notice after it fails", async () => {
    const woken: Array<[string, string]> = [];
    const stop = onResourceChanged((domain, canvasName) => woken.push([domain, canvasName]));
    try {
      const exit = await Effect.runPromiseExit(comment({
        readMailbox: () => Effect.succeed([]),
        workSubjectRow: () => Effect.succeed({ ok: true }) as never,
        workSubjectNotice: () => Effect.succeed({ ok: false, message: "the seat's mailbox is down" }) as never,
      }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(woken).toEqual([["artifact", "factory"]]);
    } finally {
      stop();
    }
  });

  it("is not told when the row does not commit", async () => {
    const woken: Array<[string, string]> = [];
    const stop = onResourceChanged((domain, canvasName) => woken.push([domain, canvasName]));
    try {
      await Effect.runPromiseExit(comment({
        readMailbox: () => Effect.succeed([]),
        workSubjectRow: () => Effect.succeed({ ok: false, message: "refused" }) as never,
        workSubjectNotice: () => Effect.succeed({ ok: true }) as never,
      }));
      expect(woken).toEqual([]);
    } finally {
      stop();
    }
  });
});
