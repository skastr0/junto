import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { pageLoadMapKey } from "../src/shared/scheduler-effects";
import { resetWatcherMemory } from "../src/main/vellum/kernel/evaluate";
import {
  __resetKernelMemoryForTest,
  __setAutomationGateForTest,
  __setPageLoadForTest,
  __setStationScopeForTest,
  getWatchers,
  runEvaluationCycle,
  setDocs,
} from "../src/main/vellum/kernel/cycle";

const pageRelayDoc = (): CanvasDoc =>
  ({
    nodes: [
      {
        id: "page-1",
        type: "link",
        url: "https://example.com",
        x: 0,
        y: 0,
        width: 220,
        height: 84,
        ether: { entity: { kind: "page" } },
      },
      {
        id: "relay-1",
        type: "text",
        text: "on load",
        x: 300,
        y: 0,
        width: 160,
        height: 60,
        ether: { entity: { kind: "relay" } },
      },
    ],
    edges: [
      {
        id: "e-watch",
        fromNode: "page-1",
        toNode: "relay-1",
        ether: {
          slot: "input",
          when: { word: "completes", equals: "ready" },
        },
      },
    ],
  }) as CanvasDoc;

beforeEach(() => {
  __resetKernelMemoryForTest();
  resetWatcherMemory();
  __setStationScopeForTest({ hostId: "local", role: "command-center" });
  __setAutomationGateForTest({
    canAutomateCanvas: () => true,
    canApplyFlagEffects: () => true,
  });
});

afterEach(() => {
  __setPageLoadForTest(undefined);
  __setAutomationGateForTest(undefined);
  __resetKernelMemoryForTest();
  resetWatcherMemory();
});

describe("page→relay watch sensor", () => {
  it("stays unknown when no browser load map is bound", async () => {
    setDocs(new Map([["board", pageRelayDoc()]]));
    await runEvaluationCycle();
    expect(getWatchers().get("board::relay-1")).toMatchObject({
      status: "unknown",
    });
    expect(getWatchers().get("board::relay-1")?.detail).toMatch(/page load/);
  });

  it("goes pending while the page session is loading", async () => {
    setDocs(new Map([["board", pageRelayDoc()]]));
    __setPageLoadForTest({
      snapshot: () =>
        new Map([[pageLoadMapKey("board", "page-1"), "loading" as const]]),
    });
    await runEvaluationCycle();
    expect(getWatchers().get("board::relay-1")).toMatchObject({
      status: "pending",
      detail: "page loading",
    });
  });

  it("satisfies on load ok (ready) and rising-edges on second pass", async () => {
    setDocs(new Map([["board", pageRelayDoc()]]));
    const loads = new Map<string, "loading" | "ready" | "failed">([
      [pageLoadMapKey("board", "page-1"), "loading"],
    ]);
    __setPageLoadForTest({ snapshot: () => loads });

    await runEvaluationCycle();
    expect(getWatchers().get("board::relay-1")?.status).toBe("pending");

    loads.set(pageLoadMapKey("board", "page-1"), "ready");
    await runEvaluationCycle();
    // Rising edge into satisfied — runtime records status; fire is side-effect.
    expect(getWatchers().get("board::relay-1")).toMatchObject({
      status: "satisfied",
      detail: "page ready",
    });
    expect(getWatchers().get("board::relay-1")?.lastFiredAt).toBeTypeOf("number");
  });

  it("satisfies page failed watch when load fails", async () => {
    const base = pageRelayDoc();
    const edge = base.edges[0]!;
    const doc: CanvasDoc = {
      ...base,
      edges: [
        {
          ...edge,
          ether: {
            ...edge.ether,
            when: { word: "completes", equals: "failed" },
          },
        },
      ],
    };
    setDocs(new Map([["board", doc]]));
    __setPageLoadForTest({
      snapshot: () =>
        new Map([[pageLoadMapKey("board", "page-1"), "failed" as const]]),
    });
    await runEvaluationCycle();
    // Baseline pass does not fire; status is still satisfied for projection.
    expect(getWatchers().get("board::relay-1")).toMatchObject({
      status: "satisfied",
      detail: "page failed",
    });
  });
});
