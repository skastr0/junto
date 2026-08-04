/**
 * Product surface audit — walk EVERY customer-facing surface and screenshot it:
 * every node kind's card + inspector + RTS bar, every work-detail modal,
 * every edge family's sheet (single click) AND legacy dbl-click panel,
 * the palette deck tabs. Capture spec, not a correctness spec.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc, taskItem, tasksNode, requestsNode, artifactsNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "stupidity-audit");

// --- scene: one of every product-creatable kind, adjacency-planned lanes ---

const agent1 = agentTextNode({ id: "agent1", key: "local:claude", label: "Claude Code - fable", x: 0, y: 0 });
const agent2 = agentTextNode({ id: "agent2", key: "local:codex", label: "Codex - gpt-5.6", x: 0, y: 320 });

const tasks = {
  ...tasksNode({
    id: "tasks",
    x: 520,
    y: 0,
    items: [
      taskItem("t1", "Ship the edge sheet v2", "submitted"),
      taskItem("t2", "Purge relayState chrome", "submitted"),
      taskItem("t3", "Digest role counts", "submitted"),
    ],
  }),
  width: 260,
  height: 180,
};

const tasks2 = {
  ...tasksNode({
    id: "tasks2",
    x: 1040,
    y: 320,
    items: [taskItem("rv1", "Review wires hotfix", "submitted")],
  }),
  width: 260,
  height: 140,
};

const requests = requestsNode({
  id: "requests",
  x: 1560,
  y: 640,
  items: [taskItem("rq1", "Need prod API key to continue", "input-required")],
});

const artifacts = artifactsNode({ id: "artifacts", x: 1560, y: 320 });

const board: CanvasNode = {
  id: "board", type: "text", text: "board", x: 520, y: 320, width: 240, height: 130,
  ether: { entity: { kind: "board" }, board: { topics: [], unread: 2 } },
};

const relay: CanvasNode = {
  id: "relay", type: "text", text: "relay", x: 1040, y: 0, width: 220, height: 100,
  ether: { entity: { kind: "relay" }, host: "local" },
};

const cron: CanvasNode = {
  id: "cron", type: "text", text: "cron", x: 1560, y: 0, width: 220, height: 96,
  ether: { entity: { kind: "cron" }, host: "local", timer: { expression: "*/30 * * * *", everyMinutes: 30 } },
};

const note: CanvasNode = {
  id: "note", type: "text", text: "release checklist\n\n- edge sheets\n- copy pass\n- pricing page", x: 0, y: 640, width: 240, height: 140,
};

const label: CanvasNode = {
  id: "label", type: "text", text: "label\nNORTH WING", x: 2080, y: 640, width: 220, height: 60,
  ether: { entity: { kind: "label" } },
};

const page1: CanvasNode = {
  id: "page1", type: "link", url: "https://example.com", x: 520, y: 640, width: 260, height: 110,
  ether: { entity: { kind: "page" }, host: "local", browser: { profile: "personal", onDelete: "kill-session" } },
} as unknown as CanvasNode;

const terminal: CanvasNode = {
  id: "terminal", type: "text", text: "terminal", x: 1040, y: 640, width: 260, height: 110,
  ether: { entity: { kind: "terminal" }, host: "local", terminal: { bindingId: "e2e-term-1", label: "terminal" } },
};

const NODES: ReadonlyArray<CanvasNode> = [
  agent1, agent2, tasks, tasks2, requests, artifacts, board, relay, cron, note, label, page1, terminal,
];

const EDGES: CanvasEdge[] = [
  // access: claim lane agent1→tasks
  { id: "e-claim", fromNode: "agent1", toNode: "tasks", fromSide: "right", toSide: "left",
    ether: { stops: { mode: "tasks" } } },
  // access: bare agent mail pair (vertical)
  { id: "e-mail", fromNode: "agent1", toNode: "agent2", fromSide: "bottom", toSide: "top" },
  // access: board wake
  { id: "e-wake", fromNode: "agent2", toNode: "board", fromSide: "right", toSide: "left", ether: { wake: true } },
  // access: escalate lane so the pending request has its raiser
  { id: "e-esc", fromNode: "agent2", toNode: "requests", fromSide: "bottom", toSide: "left" },
  // watch: tasks→relay on completes
  { id: "e-watch", fromNode: "tasks", toNode: "relay", fromSide: "right", toSide: "left",
    ether: { slot: "input", when: { word: "completes" } } },
  // effect: relay→tasks2 enqueue
  { id: "e-fire", fromNode: "relay", toNode: "tasks2", fromSide: "bottom", toSide: "top",
    ether: { slot: "output", does: { mode: "enqueue_task", data: { brief: "review the completed work", metadata: { title: "review the completed work", details: "review the completed work" } } } } },
  // effect: cron→tasks2 heartbeat
  { id: "e-cron", fromNode: "cron", toNode: "tasks2", fromSide: "bottom", toSide: "right",
    ether: { does: { mode: "enqueue_task", data: { brief: "heartbeat check", metadata: { title: "heartbeat check", details: "heartbeat check" } } } } },
];

test("walk every product surface and screenshot it", async () => {
  test.setTimeout(600_000);
  await mkdir(SHOTS, { recursive: true });
  const vellum = await launchVellum({
    seedCanvases: { "stupidity-audit": canvasDoc(NODES, EDGES) },
  });

  const { page } = vellum;
  const shot = async (name: string) => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
  };
  const escapeAll = async () => {
    // Persistent work surfaces (page/terminal) ignore Escape — close them first.
    const close = page.getByRole("button", { name: /^close$/i }).first();
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  };

  try {
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.react-flow__node[data-id="tasks"]')).toBeVisible({ timeout: 30_000 });
    const fit = page.getByRole("button", { name: /fit all/i });
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await shot("00-overview");

    // --- palette deck: every tab ---
    const addButton = page.getByRole("button", { name: "Add canvas item" });
    if (await addButton.isVisible().catch(() => false)) {
      await addButton.click();
      await page.waitForTimeout(400);
      await shot("01-palette-initial");
      const tabs = page.getByRole("tab");
      const tabCount = await tabs.count().catch(() => 0);
      for (let i = 0; i < tabCount; i += 1) {
        const tab = tabs.nth(i);
        const tabName = ((await tab.textContent().catch(() => null)) ?? `tab${i}`).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
        await tab.click().catch(() => {});
        await shot(`01-palette-${tabName}`);
      }
      await escapeAll();
    }

    // --- every node: select → inspector + RTS bar ---
    for (const node of NODES) {
      const locator = page.locator(`.react-flow__node[data-id="${node.id}"]`);
      if (!(await locator.isVisible().catch(() => false))) continue;
      await locator.click({ position: { x: 10, y: 10 } }).catch(() => {});
      await shot(`10-node-${node.id}`);
      await escapeAll();
    }

    // --- cron: settings/schedule modal off the selection bar ---
    await page.locator('.react-flow__node[data-id="cron"]').click({ position: { x: 10, y: 10 } }).catch(() => {});
    await page.waitForTimeout(300);
    const cronSettings = page.getByRole("button", { name: /schedule|settings/i }).first();
    if (await cronSettings.isVisible().catch(() => false)) {
      await cronSettings.click().catch(() => {});
      await shot("20-cron-schedule-modal");
    }
    await escapeAll();

    // --- work surfaces: double-click detail modals (+ DETAILS tab) ---
    for (const id of ["tasks", "requests", "artifacts", "board", "page1"]) {
      const locator = page.locator(`.react-flow__node[data-id="${id}"]`);
      if (!(await locator.isVisible().catch(() => false))) continue;
      await locator.dblclick({ position: { x: 10, y: 10 } }).catch(() => {});
      await shot(`30-detail-${id}`);
      const detailsTab = page.getByRole("tab", { name: /details/i }).first();
      if (await detailsTab.isVisible().catch(() => false)) {
        await detailsTab.click().catch(() => {});
        await shot(`30-detail-${id}-details-tab`);
      }
      await escapeAll();
    }

    // --- every edge: single click → wire sheet; dbl-click → legacy panel ---
    const nodeById = new Map(NODES.map((n) => [n.id, n]));
    for (const edge of EDGES) {
      const a = nodeById.get(edge.fromNode);
      const b = nodeById.get(edge.toNode);
      if (!a || !b) continue;
      const boxA = await page.locator(`.react-flow__node[data-id="${a.id}"]`).boundingBox();
      const boxB = await page.locator(`.react-flow__node[data-id="${b.id}"]`).boundingBox();
      if (!boxA || !boxB) continue;
      const mid = {
        x: (boxA.x + boxA.width / 2 + boxB.x + boxB.width / 2) / 2,
        y: (boxA.y + boxA.height / 2 + boxB.y + boxB.height / 2) / 2,
      };
      await page.mouse.click(mid.x, mid.y);
      await page.waitForTimeout(300);
      let selected = await page.locator(".inspector-panel").isVisible().catch(() => false);
      if (!selected) {
        await page.getByTestId(`rf__edge-${edge.id}`).click({ force: true }).catch(() => {});
        selected = await page.locator(".inspector-panel").isVisible().catch(() => false);
      }
      await shot(`40-edge-${edge.id}`);
      await escapeAll();
      // legacy double-click surface, if it differs
      await page.mouse.dblclick(mid.x, mid.y);
      await shot(`41-edge-${edge.id}-dblclick`);
      await escapeAll();
    }
  } finally {
    await vellum.close();
  }
});
