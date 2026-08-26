import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { CheckDef, TasksSinkContract } from "../src/shared/work-model";
import { TICKET_OUTPUT_TAIL_MAX_BYTES } from "../src/shared/work-model";
import {
  type BoardingPlan,
  type BoardingRun,
  boardingReport,
  capOutputTail,
  planFromReadiness,
  renderBoardingTable,
  resolveBoardingPlan,
  shapeBoardingResults,
} from "../src/shared/boarding";

const check = (id: string, label: string, command: string): CheckDef => ({
  id,
  label,
  command,
});

const sink = (id: string, contract?: TasksSinkContract): CanvasNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ether: {
    entity: { kind: "task" },
    tasks: { items: [], ...(contract !== undefined ? { contract } : {}) },
  },
});

const flowEdge = (id: string, source: string, destination: string) => ({
  id,
  fromNode: source,
  toNode: destination,
  ether: { verb: "feeds" as const },
});

const doc = (
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<ReturnType<typeof flowEdge>> = [],
): CanvasDoc => ({ nodes: [...nodes], edges: [...edges] });

describe("resolveBoardingPlan", () => {
  it("orders source outbound checks before destination inbound checks", () => {
    const board = doc(
      [
        sink("build", {
          outbound: { checklist: [check("c1", "typecheck", "bun run typecheck")] },
        }),
        sink("review", {
          inbound: { checklist: [check("c2", "tests", "bun run test")] },
        }),
      ],
      [flowEdge("e1", "build", "review")],
    );
    const resolved = resolveBoardingPlan(board, "build");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.plan).toEqual({
      from: "build",
      next: "review",
      checks: [
        { checkId: "c1", side: "outbound", label: "typecheck", command: "bun run typecheck" },
        { checkId: "c2", side: "inbound", label: "tests", command: "bun run test" },
      ],
    });
  });

  it("auto-picks the only destination and yields an empty plan without checklists", () => {
    const board = doc([sink("build"), sink("review")], [flowEdge("e1", "build", "review")]);
    const resolved = resolveBoardingPlan(board, "build");
    expect(resolved.ok && resolved.plan.checks).toEqual([]);
  });

  it("requires next when the sink forwards to more than one station", () => {
    const board = doc(
      [sink("build"), sink("review"), sink("ship")],
      [flowEdge("e1", "build", "review"), flowEdge("e2", "build", "ship")],
    );
    const resolved = resolveBoardingPlan(board, "build");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.rejection.code).toBe("ambiguous-next");
    expect(resolved.rejection.destinations).toEqual(["review", "ship"]);
  });

  it("rejects a destination that is not on a live flow edge", () => {
    const board = doc(
      [sink("build"), sink("review"), sink("ship")],
      [flowEdge("e1", "build", "review")],
    );
    const resolved = resolveBoardingPlan(board, "build", "ship");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.rejection.code).toBe("unknown-destination");
  });

  it("rejects a sink with no flow destinations", () => {
    const resolved = resolveBoardingPlan(doc([sink("build")]), "build");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.rejection.code).toBe("no-destinations");
  });
});

describe("planFromReadiness", () => {
  const readiness = {
    from: "build",
    boarding: [
      {
        destination: "review",
        checks: [
          { checkId: "c1", side: "outbound" as const, label: "typecheck", command: "bun run typecheck" },
        ],
      },
      { destination: "ship", checks: [] },
    ],
  };

  it("selects the named destination's checks", () => {
    const resolved = planFromReadiness({ ...readiness, next: "ship" });
    expect(resolved.ok && resolved.plan).toEqual({ from: "build", next: "ship", checks: [] });
  });

  it("stays ambiguous when several destinations are offered", () => {
    const resolved = planFromReadiness(readiness);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.rejection.code).toBe("ambiguous-next");
  });
});

describe("capOutputTail", () => {
  it("keeps short output whole", () => {
    expect(capOutputTail("ok\n")).toBe("ok\n");
  });

  it("keeps the tail within the ticket byte cap", () => {
    const capped = capOutputTail("x".repeat(TICKET_OUTPUT_TAIL_MAX_BYTES + 500));
    expect(new TextEncoder().encode(capped).byteLength).toBe(TICKET_OUTPUT_TAIL_MAX_BYTES);
    expect(capped.endsWith("x")).toBe(true);
  });

  it("starts the tail on a character boundary", () => {
    const capped = capOutputTail("é".repeat(TICKET_OUTPUT_TAIL_MAX_BYTES));
    expect(capped.includes("�")).toBe(false);
    expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(
      TICKET_OUTPUT_TAIL_MAX_BYTES,
    );
  });
});

const plan: BoardingPlan = {
  from: "build",
  next: "review",
  checks: [
    { checkId: "c1", side: "outbound", label: "typecheck", command: "bun run typecheck" },
    { checkId: "c2", side: "inbound", label: "tests", command: "bun run test" },
  ],
};

describe("shapeBoardingResults", () => {
  it("submits runs in plan order with capped tails", () => {
    const runs: ReadonlyArray<BoardingRun> = [
      { checkId: "c2", side: "inbound", exitCode: 1, output: "y".repeat(TICKET_OUTPUT_TAIL_MAX_BYTES + 10) },
      { checkId: "c1", side: "outbound", exitCode: 0, output: "clean" },
    ];
    const results = shapeBoardingResults(plan, runs);
    expect(results.map((result) => result.checkId)).toEqual(["c1", "c2"]);
    expect(results[1]!.outputTail.length).toBe(TICKET_OUTPUT_TAIL_MAX_BYTES);
  });

  it("drops runs the plan does not name", () => {
    const results = shapeBoardingResults(plan, [
      { checkId: "stray", side: "outbound", exitCode: 0, output: "" },
    ]);
    expect(results).toEqual([]);
  });
});

describe("boardingReport", () => {
  it("names what still stands between the task and the forward move", () => {
    const report = boardingReport(plan, [
      { checkId: "c1", side: "outbound", exitCode: 0, output: "" },
      { checkId: "c2", side: "inbound", exitCode: 2, output: "" },
    ]);
    expect(report.ready).toBe(false);
    expect(report.missing).toEqual(["inbound tests"]);
    expect(report.rows.map((row) => row.status)).toEqual(["green", "red"]);
  });

  it("marks an unrun check as not run, never as green", () => {
    const report = boardingReport(plan, [
      { checkId: "c1", side: "outbound", exitCode: 0, output: "" },
    ]);
    expect(report.rows[1]!.status).toBe("not-run");
    expect(report.ready).toBe(false);
  });

  it("is ready when every applicable check is green", () => {
    const report = boardingReport(plan, [
      { checkId: "c1", side: "outbound", exitCode: 0, output: "" },
      { checkId: "c2", side: "inbound", exitCode: 0, output: "" },
    ]);
    expect(report.ready).toBe(true);
    expect(report.missing).toEqual([]);
  });
});

describe("renderBoardingTable", () => {
  it("renders one row per check plus the forward verdict", () => {
    const table = renderBoardingTable(
      boardingReport(plan, [
        { checkId: "c1", side: "outbound", exitCode: 0, output: "" },
        { checkId: "c2", side: "inbound", exitCode: 1, output: "" },
      ]),
    );
    expect(table.split("\n")).toHaveLength(4);
    expect(table).toContain("build -> review");
    expect(table).toContain("still missing: inbound tests");
  });

  it("says so when no checks are authored for the move", () => {
    const table = renderBoardingTable(
      boardingReport({ from: "build", next: "review", checks: [] }, []),
    );
    expect(table).toContain("no boarding checks are authored");
    expect(table).toContain("ready to forward");
  });
});
