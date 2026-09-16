/**
 * Verb edges — rendered evidence for the semantic-verb cut.
 *
 * Four canvases, each seeded through the same SQLite path the app boots from,
 * captured out of a real Electron render:
 *   - the task trio: manages, contributes, and works around one tasks node
 *   - a feeds path: three Tasks boards in a row
 *   - a board read two ways: the quiet verb beside the participating one
 *   - a relay: what announces into it, and what it enqueues out
 *
 * Every frame also carries its own DOM receipts, so the visual claims are not
 * eyeballed off a PNG: each wire is one solid hairline (no dash array, one
 * stroke width), and within a frame each verb paints its own colour.
 */
import type { CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import {
  agentTextNode,
  canvasDoc,
  taskItem,
  tasksNode,
} from "../harness/sandbox";
import type { Task } from "../../src/shared/work-model";
import { expect, launchJunto, test } from "../harness/launch";

const WIRE_WIDTH = "1.2px";

type WireFacts = {
  readonly dashArrays: ReadonlyArray<string>;
  readonly widths: ReadonlyArray<string>;
  readonly strokes: ReadonlyArray<string>;
};

/**
 * Read every rendered wire's computed paint. `stroke-dasharray: none` on all
 * of them is the "solid strokes only" claim; a single width is the hairline
 * claim; the stroke list is what proves two verbs are told apart by colour.
 */
const readWires = async (page: {
  evaluate: <T>(fn: () => T) => Promise<T>;
}): Promise<WireFacts> =>
  page.evaluate(() => {
    const paths = Array.from(
      document.querySelectorAll<SVGPathElement>("path.junto-edge"),
    );
    const read = (path: SVGPathElement) => window.getComputedStyle(path);
    return {
      dashArrays: paths.map((path) => read(path).strokeDasharray),
      widths: paths.map((path) => read(path).strokeWidth),
      strokes: paths.map((path) => read(path).stroke),
    };
  });

/**
 * A named Tasks node. A board whose live items overwrite its authored text
 * falls back to "Tasks <short id>" without an authored name, which reads
 * as noise in a frame about the wires.
 */
const tasksBoard = (input: {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y?: number;
  readonly items?: ReadonlyArray<Task>;
  readonly width?: number;
  readonly height?: number;
}): CanvasNode => {
  const base = tasksNode({
    id: input.id,
    x: input.x,
    y: input.y ?? 240,
    items: input.items ?? [],
  });
  return {
    ...base,
    width: input.width ?? 260,
    height: input.height ?? 160,
    ether: {
      ...base.ether,
      tasks: { ...base.ether?.tasks, name: input.name },
    },
  } as CanvasNode;
};

const board = (id: string, x: number, y: number): CanvasNode => ({
  id,
  type: "text",
  text: "board",
  x,
  y,
  width: 240,
  height: 120,
  ether: { entity: { kind: "board" }, board: { topics: [], unread: 2 } },
});

const relay = (id: string, x: number, y: number): CanvasNode => ({
  id,
  type: "text",
  text: "relay",
  x,
  y,
  width: 220,
  height: 100,
  ether: { entity: { kind: "relay" }, host: "local" },
});

const capture = async (
  name: string,
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
  anchorNodeId: string,
  screenshotPath: string,
): Promise<WireFacts> => {
  const junto = await launchJunto({
    seedCanvases: { [name]: canvasDoc(nodes, edges) },
  });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(`.react-flow__node[data-id="${anchorNodeId}"]`),
    ).toBeVisible({ timeout: 30_000 });
    const fit = page.getByRole("button", { name: /fit all/i });
    if (await fit.isVisible().catch(() => false)) await fit.click();
    // Park the pointer off the control bar so its hover tooltip is not in frame.
    await page.mouse.move(4, 4);
    await page.waitForTimeout(900);
    await expect(page.locator("path.junto-edge")).toHaveCount(edges.length);
    const facts = await readWires(page);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    return facts;
  } finally {
    await junto.close();
  }
};

/** Solid hairline, every wire in the frame. */
const expectSolidHairlines = (facts: WireFacts): void => {
  for (const dash of facts.dashArrays) expect(dash).toBe("none");
  for (const width of facts.widths) expect(width).toBe(WIRE_WIDTH);
};

test("task trio — manages, contributes, and works read apart", async ({}, testInfo) => {
  const tasks = tasksBoard({
    id: "tasks",
    name: "Backlog",
    x: 520,
    width: 280,
    height: 180,
    items: [
      taskItem("t1", "Ship the verb cut", "submitted"),
      taskItem("t2", "Capture the rendered wires", "submitted"),
    ],
  });
  const nodes: CanvasNode[] = [
    tasks,
    agentTextNode({ id: "planner", key: "local:planner", label: "Planner", x: 60, y: 60 }),
    agentTextNode({ id: "builder", key: "local:builder", label: "Builder", x: 60, y: 300 }),
    agentTextNode({ id: "puller", key: "local:puller", label: "Puller", x: 1020, y: 240 }),
  ];
  const edges: CanvasEdge[] = [
    {
      id: "e-manages",
      fromNode: "planner",
      toNode: "tasks",
      fromSide: "right",
      toSide: "left",
      ether: { verb: "manages" },
    },
    {
      id: "e-contributes",
      fromNode: "builder",
      toNode: "tasks",
      fromSide: "right",
      toSide: "left",
      ether: { verb: "contributes" },
    },
    {
      id: "e-works",
      fromNode: "tasks",
      toNode: "puller",
      fromSide: "right",
      toSide: "left",
      ether: { verb: "works" },
    },
  ];

  const facts = await capture(
    "verb-edges-task-trio",
    nodes,
    edges,
    "tasks",
    testInfo.outputPath("task_trio.png"),
  );
  expectSolidHairlines(facts);
  // Three relationships around one sink, three colours — the trio is legible
  // without a label because nothing else distinguishes them.
  expect(new Set(facts.strokes).size).toBe(3);
});

test("feeds path — three boards, one hop word", async ({}, testInfo) => {
  const hop = (id: string, name: string, brief: string, x: number): CanvasNode =>
    tasksBoard({ id, name, x, items: [taskItem(`${id}-1`, brief, "submitted")] });
  const nodes: CanvasNode[] = [
    hop("intake", "Intake", "Draft the release notes", 60),
    hop("review", "Review", "Review the release notes", 460),
    hop("ship", "Ship", "Ship the release", 860),
  ];
  const edges: CanvasEdge[] = [
    {
      id: "e-intake-review",
      fromNode: "intake",
      toNode: "review",
      fromSide: "right",
      toSide: "left",
      ether: { verb: "feeds" },
    },
    {
      id: "e-review-ship",
      fromNode: "review",
      toNode: "ship",
      fromSide: "right",
      toSide: "left",
      ether: { verb: "feeds" },
    },
  ];

  const facts = await capture(
    "verb-edges-feeds",
    nodes,
    edges,
    "intake",
    testInfo.outputPath("feeds_path.png"),
  );
  expectSolidHairlines(facts);
  // One verb along the whole path: the hops must not drift in colour.
  expect(new Set(facts.strokes).size).toBe(1);
});

test("board — the quiet verb beside the participating one", async ({}, testInfo) => {
  const nodes: CanvasNode[] = [
    board("board", 520, 240),
    agentTextNode({ id: "reader", key: "local:reader", label: "Reader", x: 60, y: 120 }),
    agentTextNode({ id: "voice", key: "local:voice", label: "Voice", x: 60, y: 380 }),
  ];
  const edges: CanvasEdge[] = [
    {
      id: "e-messages",
      fromNode: "reader",
      toNode: "board",
      fromSide: "right",
      toSide: "left",
      ether: { verb: "messages" },
    },
    {
      id: "e-participates",
      fromNode: "voice",
      toNode: "board",
      fromSide: "right",
      toSide: "left",
      ether: { verb: "participates" },
    },
  ];

  const facts = await capture(
    "verb-edges-board",
    nodes,
    edges,
    "board",
    testInfo.outputPath("board_messages_vs_participates.png"),
  );
  expectSolidHairlines(facts);
  // Same pair of cards, two relationships: the megaphone is a different wire.
  expect(new Set(facts.strokes).size).toBe(2);
});

test("relay — what announces in, what it enqueues out", async ({}, testInfo) => {
  const source = tasksBoard({
    id: "source",
    name: "Build",
    x: 60,
    items: [taskItem("s1", "Cut the build", "completed")],
  });
  const followup = tasksBoard({ id: "followup", name: "Follow-up", x: 940 });
  const nodes: CanvasNode[] = [
    source,
    relay("relay", 520, 260),
    followup,
    agentTextNode({ id: "caller", key: "local:caller", label: "Caller", x: 520, y: 40 }),
  ];
  const edges: CanvasEdge[] = [
    {
      id: "e-announces",
      fromNode: "source",
      toNode: "relay",
      fromSide: "right",
      toSide: "left",
      ether: { verb: "announces" },
    },
    {
      id: "e-enqueues",
      fromNode: "relay",
      toNode: "followup",
      fromSide: "right",
      toSide: "left",
      ether: { verb: "enqueues" },
    },
    {
      id: "e-fires",
      fromNode: "caller",
      toNode: "relay",
      fromSide: "bottom",
      toSide: "top",
      ether: { verb: "fires" },
    },
  ];

  const facts = await capture(
    "verb-edges-relay",
    nodes,
    edges,
    "relay",
    testInfo.outputPath("relay_announces_enqueues.png"),
  );
  expectSolidHairlines(facts);
  // Cold in, hot out: the watch and the fire cannot share a colour.
  expect(new Set(facts.strokes).size).toBe(3);
});
