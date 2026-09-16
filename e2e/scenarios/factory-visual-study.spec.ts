/**
 * Temporary implementation-near study for the pair-aware factory grammar.
 * This is a real Electron render over normal canvas/work projections, not a
 * correctness spec or a second product surface.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import {
  agentTextNode,
  artifactsNode,
  canvasDoc,
  requestsNode,
  taskItem,
  tasksNode,
  terminalTextNode,
  verbEdge,
} from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");

const taskSink = {
  ...tasksNode({
    id: "tasks",
    x: 40,
    y: 110,
    items: [
      taskItem("t1", "Grant check — request.create", "submitted"),
      taskItem("t2", "Escalate grant check — operator", "submitted"),
      taskItem("t3", "Add PTY terminal color proof", "submitted"),
      taskItem("t4", "Approve reinstalling current", "submitted"),
    ],
  }),
  width: 270,
  height: 230,
};

const actors = [
  agentTextNode({ id: "claude", key: "local:claude", label: "Claude Code - opus", x: 410, y: 60 }),
  agentTextNode({ id: "codex-a", key: "local:codex-a", label: "Codex - gpt-5.6-sol", x: 410, y: 190 }),
  agentTextNode({ id: "codex-b", key: "local:codex-b", label: "Codex - gpt-5.6-sonnet", x: 410, y: 320 }),
  agentTextNode({ id: "grok", key: "local:grok", label: "Grok - grok-4.5", x: 410, y: 450 }),
];

const requestSink = {
  ...requestsNode({
    id: "requests",
    x: 810,
    y: 90,
    items: [
      taskItem("r1", "Grant check — request.create", "input-required"),
      taskItem("r2", "Escalate grant check — operator", "completed"),
      taskItem("r3", "Add the PTY/terminal color", "completed"),
      taskItem("r4", "Approve reinstalling current", "completed"),
    ],
  }),
  width: 270,
  height: 190,
};

const artifacts: Artifact[] = [
  { artifactId: "a1", name: "grant-check.md", parts: [{ kind: "text", text: "verified" }] },
  { artifactId: "a2", name: "terminal-color-regression.log", parts: [{ kind: "text", text: "pass" }] },
  { artifactId: "a3", name: "grok-scrolling-regression.txt", parts: [{ kind: "text", text: "pass" }] },
];

const artifactSink = {
  ...artifactsNode({ id: "artifacts", x: 810, y: 350, items: artifacts }),
  width: 270,
  height: 160,
};

const cron: CanvasNode = {
  id: "cron",
  type: "text",
  text: "heartbeat",
  x: 810,
  y: 535,
  width: 230,
  height: 92,
  ether: { entity: { kind: "cron" }, timer: { everyMinutes: 30 } },
};

const terminal = terminalTextNode({
  id: "terminal",
  bindingId: "factory-study-terminal",
  label: "terminal",
  launch: {
    kind: "command",
    argv: ["/bin/sh", "-c", "printf 'factory ready\\r\\n'; exec sleep 3600"],
  },
  x: 1110,
  y: 535,
});

const board: CanvasNode = {
  id: "board",
  type: "text",
  text: "board",
  x: 1110,
  y: 350,
  width: 240,
  height: 150,
  ether: { entity: { kind: "board" }, board: { topics: [], unread: 0 } },
};

const nodes: CanvasNode[] = [
  taskSink,
  ...actors,
  requestSink,
  artifactSink,
  cron,
  board,
  terminal,
];

const taskEdges: CanvasEdge[] = actors.map((actor) =>
  verbEdge(`task-${actor.id}`, "tasks", actor.id, "works", nodes),
);

const edges: CanvasEdge[] = [
  ...taskEdges,
  verbEdge("request-flow", "claude", "requests", "escalates", nodes),
  verbEdge("artifact-flow", "claude", "artifacts", "publishes", nodes),
  // The heartbeat pushes: a clock wakes a seat. Agent → cron is not a
  // relationship the grammar holds, so the old wire here never rendered.
  verbEdge("cron-wake", "cron", "grok", "wakes", nodes, {
    fromSide: "left",
    toSide: "right",
  }),
];

test("capture the implementation-near factory grammar", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({
    seedCanvases: {
      "factory-visual-study": canvasDoc(nodes, edges),
    },
  });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.react-flow__node[data-id="tasks"]')).toBeVisible({ timeout: 30_000 });
    const fit = page.getByRole("button", { name: /fit all/i });
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await page.waitForTimeout(900);
    await page.screenshot({
      path: join(SHOTS, "00-factory-visual-study.png"),
      fullPage: false,
    });
  } finally {
    await junto.close();
  }
});
