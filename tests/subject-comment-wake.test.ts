/**
 * A comment wakes the change triggers of its task or artifact as soon as its
 * row commits (07): a notice that fails after it still leaves the comment
 * standing, and its wake told.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { onResourceChanged } from "../src/main/junto/work/resource-changes";
import { WorkService, type WorkServiceShape } from "../src/main/junto/work/service";
import { postSubjectComment } from "../src/main/junto/work/subject-comment";
import { asNodeId, type Canvas, type Node } from "../src/shared/model";
import { ItemId, OpId } from "../src/shared/work-ids";
import { seat } from "./support/model-nodes";

const ARTIFACTS = asNodeId("artifacts-1");
const SEAT = asNodeId("agent-a");
const canvas = {
  name: "factory",
  nodes: new Map([
    [ARTIFACTS, { id: ARTIFACTS, kind: "artifacts", x: 0, y: 0, width: 240, height: 160 } as unknown as Node],
    // On the canvas, so its notice is attempted: a seat whose node is gone is skipped before any notice.
    [SEAT, seat(SEAT, { x: 300, y: 0 })],
  ]),
  wires: new Map(),
} as unknown as Canvas;

const comment = (work: Partial<WorkServiceShape>) =>
  postSubjectComment(
    {
      subject: { kind: "artifact", nodeId: ARTIFACTS, artifactId: ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ70") },
      text: "Looks good",
      actor: { kind: "operator" },
      opId: OpId.make("01M5ESKJFC1A88R1MH1NEZWJ71"),
    },
    { canvas, canvasName: "factory", people: [SEAT] },
  ).pipe(
    Effect.provideService(WorkService, work as WorkServiceShape),
    Effect.provideService(MachineRepository, { installationId: Effect.succeed("mini") } as unknown as MachineRepository["Service"]),
  );

describe("a comment's wake", () => {
  it("is told once the row commits, even when a notice after it fails", async () => {
    const woken: Array<[string, string]> = [];
    let tried = 0;
    const stop = onResourceChanged((domain, canvasName) => woken.push([domain, canvasName]));
    try {
      const exit = await Effect.runPromiseExit(comment({
        readMailbox: () => Effect.succeed([]),
        workSubjectRow: () => Effect.succeed({ ok: true }) as never,
        workSubjectNotice: () => Effect.sync(() => (tried += 1)).pipe(Effect.as({ ok: false, message: "the seat's mailbox is down" })) as never,
      }));
      // The comment stands and its wake is told; the seat whose notice failed is not counted as told.
      expect(tried).toBe(1);
      expect(Exit.isSuccess(exit) && exit.value.notified).toEqual([]);
      expect(woken).toEqual([["artifact", "factory"]]);
    } finally {
      stop();
    }
  });

  it("is not told when the comment is refused before any row: empty text, a mention out of reach", async () => {
    // The artifacts node in one region, the far seat in a sibling one: out of its reach.
    const far = asNodeId("agent-far");
    const region = (id: string, x: number) =>
      [asNodeId(id), { id, kind: "region", label: id, x, y: -100, width: 800, height: 800, z: 0, defaults: {}, hold: false } as unknown as Node] as const;
    const withFar = {
      ...canvas,
      nodes: new Map([...canvas.nodes, region("region-here", -100), region("region-there", 2000), [far, seat(far, { x: 2200, y: 0 })]]),
    } as unknown as Canvas;
    const rows: string[] = [];
    const work = {
      readMailbox: () => Effect.succeed([]),
      workSubjectRow: () => Effect.sync(() => rows.push("row")).pipe(Effect.as({ ok: true })) as never,
      workSubjectNotice: () => Effect.succeed({ ok: true }) as never,
    } as unknown as WorkServiceShape;
    const post = (text: string) =>
      postSubjectComment(
        {
          subject: { kind: "artifact", nodeId: ARTIFACTS, artifactId: ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ70") },
          text,
          actor: { kind: "operator" },
          opId: OpId.make("01M5ESKJFC1A88R1MH1NEZWJ72"),
        },
        { canvas: withFar, canvasName: "factory", people: [] },
      ).pipe(
        Effect.provideService(WorkService, work),
        Effect.provideService(MachineRepository, { installationId: Effect.succeed("mini") } as unknown as MachineRepository["Service"]),
      );
    const woken: Array<[string, string]> = [];
    const stop = onResourceChanged((domain, canvasName) => woken.push([domain, canvasName]));
    try {
      const empty = await Effect.runPromiseExit(post("   "));
      const outOfReach = await Effect.runPromiseExit(post("ask [@far](junto://canvas/factory?node=agent-far)"));
      expect([empty, outOfReach].map((exit) => (Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "ok"))).toEqual([
        expect.stringContaining("InputError"),
        expect.stringContaining("not_in_reach"),
      ]);
      expect(rows).toEqual([]);
      expect(woken).toEqual([]);
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
