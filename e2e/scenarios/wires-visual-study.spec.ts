/**
 * Wires study — capture the CURRENT edge rendering over a dense wired scene so
 * word-visual design is grounded in the real canvas, not idealized straight
 * lines. Real Electron render over normal projections; not a correctness spec.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import {
  agentTextNode,
  canvasDoc,
  taskItem,
  tasksNode,
  canvasDoc as _doc,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "wires-study");

const work = {
  ...tasksNode({
    id: "work",
    x: 40,
    y: 120,
    items: [
      taskItem("t1", "Ship the edge sheet v2", "submitted"),
      taskItem("t2", "Purge relayState chrome", "submitted"),
      taskItem("t3", "Digest role counts", "submitted"),
    ],
  }),
  width: 260,
  height: 200,
};

const review = {
  ...tasksNode({
    id: "review",
    x: 1180,
    y: 120,
    items: [taskItem("rv1", "Review wires hotfix", "submitted")],
  }),
  width: 260,
  height: 160,
};

const actors = [
  agentTextNode({ id: "claude", key: "local:claude", label: "Claude Code - fable", x: 430, y: 40 }),
  agentTextNode({ id: "codex", key: "local:codex", label: "Codex - gpt-5.6", x: 430, y: 180 }),
  agentTextNode({ id: "grok", key: "local:grok", label: "Grok - grok-4.5", x: 430, y: 320 }),
];

const board: CanvasNode = {
  id: "board",
  type: "text",
  text: "board",
  x: 430,
  y: 470,
  width: 230,
  height: 130,
  ether: { entity: { kind: "board" }, board: { topics: [], unread: 2 } },
};

const relay: CanvasNode = {
  id: "relay",
  type: "text",
  text: "relay",
  x: 820,
  y: 260,
  width: 220,
  height: 100,
  ether: { entity: { kind: "relay" }, host: "local" },
};

const cron: CanvasNode = {
  id: "cron",
  type: "text",
  text: "heartbeat",
  x: 820,
  y: 470,
  width: 220,
  height: 92,
  ether: { entity: { kind: "cron" }, timer: { everyMinutes: 30 } },
};

const flaggedBase = agentTextNode({
  id: "blocked",
  key: "local:blocked",
  label: "Hermes - stuck",
  x: 820,
  y: 40,
});
const flagged: CanvasNode = {
  ...flaggedBase,
  ether: { ...flaggedBase.ether, flags: ["blocker"] },
} as CanvasNode;

const edges: CanvasEdge[] = [
  // access stops — three agents into one sink, bundled
  ...actors.map((actor) => ({
    id: `claim-${actor.id}`,
    fromNode: actor.id,
    toNode: "work",
    fromSide: "left" as const,
    toSide: "right" as const,
    ether: { stops: { mode: "tasks" as const } },
  })),
  // access wakes + access messages
  { id: "wake-claude", fromNode: "claude", toNode: "board", fromSide: "left", toSide: "top", ether: { wake: true } },
  { id: "msg-pair", fromNode: "claude", toNode: "codex", fromSide: "right", toSide: "right" },
  // watch wires into relay
  {
    id: "watch-work",
    fromNode: "work",
    toNode: "relay",
    fromSide: "right",
    toSide: "left",
    ether: { slot: "input" as const, when: { word: "completes" as const } },
  },
  {
    id: "watch-flag",
    fromNode: "blocked",
    toNode: "relay",
    fromSide: "right",
    toSide: "top",
    ether: { slot: "input" as const, when: { word: "flagged" as const, flag: "blocker" as const } },
  },
  // effect wires out
  {
    id: "fire-review",
    fromNode: "relay",
    toNode: "review",
    fromSide: "right",
    toSide: "left",
    ether: {
      slot: "output" as const,
      does: { mode: "enqueue_task" as const, data: { brief: "review the completed work", metadata: { title: "review the completed work", details: "review the completed work" } } },
    },
  },
  {
    id: "cron-fire",
    fromNode: "cron",
    toNode: "review",
    fromSide: "right",
    toSide: "bottom",
    ether: {
      does: { mode: "enqueue_task" as const, data: { brief: "heartbeat check", metadata: { title: "heartbeat check", details: "heartbeat check" } } },
    },
  },
];

test("capture current wires rendering — dense scene", async () => {
  await mkdir(SHOTS, { recursive: true });
  const vellumCommand = await launchVellum({
    seedCanvases: {
      "wires-visual-study": canvasDoc(
        [work, ...actors, board, relay, cron, flagged, review],
        edges,
      ),
    },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.react-flow__node[data-id="work"]')).toBeVisible({ timeout: 30_000 });
    const fit = page.getByRole("button", { name: /fit all/i });
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(SHOTS, "00-wires-overview.png"), fullPage: false });

    // Zoom into the bundled agent→work edges to study blending.
    const workNode = page.locator('.react-flow__node[data-id="work"]');
    const box = await workNode.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width + 60, box.y + box.height / 2);
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press("Meta+=").catch(() => {});
      }
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, "01-wires-bundle-zoom.png"), fullPage: false });
    }
  } finally {
    await vellumCommand.close();
  }
});
