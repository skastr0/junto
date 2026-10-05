/**
 * A stop reason says when the stop began: the kernel cycle projects it from
 * the work items' stateSince, so the operator's "blocked since" is the true
 * time and not when a window first saw it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { deriveExecutionGraph, earliestStateSince } from "../src/shared/execution-graph";
import {
  __resetKernelMemoryForTest,
  __setDocsForTest,
  getExecutionByCanvas,
  runEvaluationCycle,
  setActorRefResolver,
} from "../src/main/junto/kernel/cycle";
import { actorRefFixture, executionContextForDoc } from "./helpers/actor-ref-fixtures";

const CANVAS = "stops";
const FIRST = "2026-08-12T12:03:00.000Z";
const LATER = "2026-08-12T12:40:00.000Z";
const seatId = actorRefFixture("atlas", CANVAS).seatId;

const waiting = (id: string, stateSince?: string) => ({
  id,
  state: "input-required",
  claimedBy: seatId,
  history: [],
  ...(stateSince === undefined ? {} : { stateSince }),
});

const docWith = (items: ReadonlyArray<unknown>): CanvasDoc =>
  ({
    nodes: [
      {
        id: "atlas",
        type: "text",
        text: "Atlas",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        ether: { entity: { kind: "agent", name: "local:atlas" }, terminal: { harness: "claude" } },
      },
      {
        id: "board",
        type: "text",
        text: "tasks",
        x: 400,
        y: 0,
        width: 240,
        height: 120,
        ether: { entity: { kind: "task" }, host: "local", tasks: { items } },
      },
    ],
    edges: [{ id: "e1", fromNode: "atlas", toNode: "board", ether: { verb: "contributes" } }],
  }) as unknown as CanvasDoc;

describe("stop reasons carry when the stop began", () => {
  beforeEach(() => __resetKernelMemoryForTest());
  afterEach(() => __resetKernelMemoryForTest());

  it("the kernel cycle projects the earliest waiting item's time onto the blocked seat", async () => {
    const doc = docWith([waiting("t-later", LATER), waiting("t-first", FIRST)]);
    setActorRefResolver(executionContextForDoc(doc, CANVAS).resolveActorRef);
    __setDocsForTest(new Map([[CANVAS, doc]]));
    await runEvaluationCycle();
    const execution = getExecutionByCanvas().get(CANVAS);
    expect(execution?.blocked).toEqual(["atlas"]);
    expect(execution?.reasonsByNodeId.atlas).toEqual([
      expect.objectContaining({ kind: "edge", edgeId: "e1", fromNodeId: "board", since: Date.parse(FIRST) }),
    ]);
  });

  it("a document whose items are not the work projection yields a reason with no time", () => {
    const doc = docWith([waiting("t-unstamped")]);
    const graph = deriveExecutionGraph(doc, executionContextForDoc(doc, CANVAS));
    const [reason] = graph.reasonsByNodeId.get("atlas") ?? [];
    expect(reason).toMatchObject({ kind: "edge", edgeId: "e1" });
    expect(reason && "since" in reason).toBe(false);
  });

  it("earliestStateSince ignores items with no readable time", () => {
    expect(earliestStateSince([{ stateSince: LATER }, {}, { stateSince: "not a date" }, { stateSince: FIRST }])).toBe(Date.parse(FIRST));
    expect(earliestStateSince([{}])).toBeUndefined();
  });
});
