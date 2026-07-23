/**
 * Design-audit capture — NOT a correctness spec. Drives every reachable UI
 * surface with seeded fixtures + the fake herdr/hermes/codexbar binaries and
 * screenshots each one to test-results/design-audit/ for visual review.
 *   bun run test:e2e:fast e2e/scenarios/design-audit.spec.ts
 * The screenshots are the artifact; assertions only prove a surface appeared.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { writeScenario as writeHerdrScenario } from "../fakes/scenario";
import { oneReplyScenario, writeScenario as writeHermesScenario } from "../fakes/hermes-scenario";
import {
  agentTextNode,
  artifactsNode,
  canvasDoc,
  herdrTextNode,
  projectNode,
  requestsNode,
  tasksCriteriaEdge,
  tasksNode,
  terminalTextNode,
  textNode,
  a2aTask,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";
import type { CanvasEdge, CanvasNode, GroupNode, LinkNode } from "../../src/shared/canvas";

const SHOTS = join(process.cwd(), "test-results", "design-audit");

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

const noteNode: CanvasNode = {
  id: "note1",
  type: "text",
  text: "# Field notes\n\nThe **digest** stays deterministic.\n\n– relates edges are quiet\n– blockers paint crimson\n\n> the file is the agent API\n\n`bun run digest`",
  x: 0,
  y: 0,
  width: 280,
  height: 230,
};

const flaggedNote: CanvasNode = {
  id: "note2",
  type: "text",
  text: "release checklist",
  x: 340,
  y: 0,
  width: 220,
  height: 90,
  color: "1",
  ether: { flags: ["blocker"] },
};

const attentionNote: CanvasNode = {
  id: "note3",
  type: "text",
  text: "copy review pending",
  x: 340,
  y: 140,
  width: 220,
  height: 90,
  ether: { flags: ["attention"] },
};

const parkedNote: CanvasNode = {
  id: "note4",
  type: "text",
  text: "old experiment",
  x: 340,
  y: 280,
  width: 220,
  height: 90,
  ether: { flags: ["parked"] },
};

const linkNode: LinkNode = {
  id: "link1",
  type: "link",
  url: "https://jsoncanvas.org",
  x: 620,
  y: 0,
  width: 240,
  height: 90,
};

const fileNode: CanvasNode = {
  id: "file1",
  type: "file",
  file: "docs/rts-bottom-bar.md",
  x: 620,
  y: 140,
  width: 240,
  height: 90,
};

const regionNode: GroupNode = {
  id: "region1",
  type: "group",
  label: "forge orbit",
  x: -40,
  y: -60,
  width: 940,
  height: 460,
  ether: { region: { hold: true } },
};

const LAUNCH = {
  kind: "command" as const,
  argv: ["/bin/sh", "-c", "printf 'audit-terminal-ready\\r\\n'; exec sleep 3600"],
};

const nodes: CanvasNode[] = [
  regionNode,
  noteNode,
  flaggedNote,
  attentionNote,
  parkedNote,
  linkNode,
  fileNode,
  projectNode({ id: "proj1", name: "prism", x: 0, y: 460 }),
  projectNode({ id: "proj2", name: "vellum", x: 260, y: 460 }),
  agentTextNode({ id: "agent1", key: "local:default", label: "builder", x: 520, y: 460 }),
  tasksNode({ id: "tasks1", x: 0, y: 620, items: [a2aTask("t-1", "ship design tokens", "working")] }),
  requestsNode({ id: "req1", x: 260, y: 620, items: [a2aTask("r-1", "approve copy", "input-required")] }),
  artifactsNode({ id: "art1", x: 520, y: 620 }),
  terminalTextNode({
    id: "term1",
    bindingId: "audit-term-binding",
    label: "audit native term",
    launch: LAUNCH,
    x: 940,
    y: 460,
  }),
  herdrTextNode({
    id: "herdr1",
    host: "local",
    paneId: "w1:p1",
    terminalId: "term_1",
    label: "audit herdr pane",
    x: 940,
    y: 620,
  }),
];

const edges: CanvasEdge[] = [
  tasksCriteriaEdge("e1", "tasks1", "proj1"),
  { id: "e2", fromNode: "proj1", toNode: "proj2", fromSide: "right", toSide: "left" },
  {
    id: "e3",
    fromNode: "note2",
    toNode: "proj2",
    fromSide: "right",
    toSide: "left",
    ether: { kind: "blocks" },
  },
];

test("capture every surface for design review", async () => {
  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-audit-"));
  const herdrScenario = join(scenarioDir, "herdr.json");
  const hermesScenario = join(scenarioDir, "hermes.json");
  const codexbarScenario = join(scenarioDir, "codexbar.json");
  await mkdir(SHOTS, { recursive: true });

  const world = {
    workspaces: [
      { workspace_id: "w1", label: "demo", tab_count: 1, pane_count: 1, agent_status: "working", focused: true, number: 1 },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "1", pane_count: 1, agent_status: "working", focused: true, number: 1 },
    ],
    panes: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        terminal_id: "term_1",
        cwd: "/proj/vellum",
        foreground_cwd: "/proj/vellum",
        agent: "claude",
        agent_status: "working",
        focused: true,
        revision: 0,
      },
    ],
    agents: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        terminal_id: "term_1",
        cwd: "/proj/vellum",
        agent: "claude",
        agent_status: "working",
        focused: true,
      },
    ],
    layouts: [{ workspace_id: "w1", tab_id: "w1:t1", panes: [], splits: [], zoomed: false }],
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    focused_pane_id: "w1:p1",
    protocol: 16,
    version: "0.7.3",
  } as const;

  await writeHerdrScenario(herdrScenario, {
    world,
    frames: {
      term_1: [
        { text: "● claude · forging design tokens\r\n" },
        { text: "$ bun run typecheck && bun run test\r\n" },
        { text: "✓ 187 tests passed\r\n" },
      ],
    },
  });
  await writeHermesScenario(hermesScenario, oneReplyScenario("Design tokens landed — ink, dim, amber, crimson."));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    codexbarScenario,
    JSON.stringify({
      mode: "healthy",
      quotas: [
        { provider: "codex", label: "codex", usedPercent: 42, resetsIn: "3h 12m" },
        { provider: "claude", label: "claude", usedPercent: 7, resetsIn: "5d 1h" },
      ],
    }),
    "utf8",
  );

  const vellum = await launchVellum({
    extraEnv: {
      FAKE_HERDR_SCENARIO: herdrScenario,
      FAKE_HERMES_SCENARIO: hermesScenario,
      FAKE_CODEXBAR_SCENARIO: codexbarScenario,
    },
    seedCanvases: { audit: canvasDoc(nodes, edges) },
  });

  try {
    const { page } = vellum;

    // React Flow only mounts on-screen nodes: wait for the first, fit the
    // whole board, THEN distant entity nodes exist in the DOM.
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    const fit = page.getByRole("button", { name: /fit all/i });
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await page.waitForTimeout(800);
    const termNode = page.locator(".react-flow__node", { hasText: "audit native term" });
    await expect(termNode).toBeVisible({ timeout: 15_000 });
    await shot(page, "01-canvas-full");

    // Node closeups.
    const closeup = async (hasText: string, name: string) => {
      const el = page.locator(".react-flow__node", { hasText }).first();
      await el.scrollIntoViewIfNeeded();
      await el.screenshot({ path: join(SHOTS, `${name}.png`) });
    };
    await closeup("Field notes", "02-node-note");
    await closeup("release checklist", "03-node-blocker");
    await closeup("audit herdr pane", "04-node-herdr");
    await closeup("audit native term", "05-node-terminal-card");
    await closeup("ship design tokens", "06-node-tasks");

    // Edge label closeup.
    const edgeLabel = page.locator(".vellum-edge-label").first();
    if (await edgeLabel.isVisible().catch(() => false)) {
      await edgeLabel.screenshot({ path: join(SHOTS, "07-edge-label.png") });
    }

    // Select a note → toolbar + inspector.
    await page.locator(".react-flow__node", { hasText: "Field notes" }).first().click();
    await shot(page, "08-node-selected-inspector");

    // Chat: select the agent node, attach, send.
    await page.locator(".react-flow__node", { hasText: "builder" }).first().click();
    await expect(page.locator(".chat-view")).toBeVisible({ timeout: 15_000 });
    await shot(page, "11-chat-detached");
    await page.getByRole("button", { name: "attach" }).click();
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.fill("ship the design system");
    await page.getByRole("button", { name: "send" }).click();
    await expect(page.locator(".chat-message--assistant")).toContainText("Design tokens", {
      timeout: 30_000,
    });
    await shot(page, "12-chat-conversation");
    await page.getByRole("button", { name: "Close inspector" }).click();
    await page.waitForTimeout(300);

    // Herdr terminal modal: single click on the card hero (pointerdown opens
    // when the card is not selected).
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await page.waitForTimeout(600);
    const herdrNode = page.locator(".react-flow__node", { hasText: "audit herdr pane" });
    await herdrNode.getByRole("button", { name: "audit herdr pane" }).click();
    const herdrPanel = page.locator(".herdr-terminal-panel");
    await expect(herdrPanel).toBeVisible({ timeout: 30_000 });
    await expect(herdrPanel.getByRole("status", { name: "connected" })).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(700);
    await shot(page, "10-herdr-terminal-modal");
    await herdrPanel.getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(400);

    // Settings panel.
    await page.getByRole("button", { name: "Open settings" }).click();
    await shot(page, "13-settings");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Connectors popover.
    await page.getByRole("button", { name: "Open connectors" }).click();
    await shot(page, "14-connectors");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Interaction help popover.
    await page.getByRole("button", { name: "Open interaction help" }).click();
    await shot(page, "15-help");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // New-canvas dialog.
    await page.getByRole("button", { name: "New canvas" }).click();
    await shot(page, "16-canvas-dialog");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Digest panel.
    await page.getByRole("button", { name: "Export digest" }).click();
    const digest = page.getByRole("dialog", { name: "Canvas digest" });
    await expect(digest).toBeVisible({ timeout: 15_000 });
    await shot(page, "17-digest");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Usage HUD + popover.
    const hud = page.getByRole("button", { name: "Provider limits", exact: true });
    if (await hud.isVisible().catch(() => false)) {
      await shot(page, "18-usage-hud-rail");
      await hud.click();
      await shot(page, "19-usage-hud-popover");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    // Wizards via the add-item palette.
    const addItem = page.getByRole("button", { name: "Add canvas item" });
    if (await addItem.isVisible().catch(() => false)) {
      await addItem.click();
      await shot(page, "20-node-palette");
      const termWiz = page.getByRole("button", { name: "Add native terminal work surface" });
      if (await termWiz.isVisible().catch(() => false)) {
        await termWiz.click();
        await shot(page, "21-terminal-wizard");
        // FocusSurface-backed now — Escape closes.
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
      await addItem.click();
      const herdrWiz = page.getByRole("button", { name: "Add legacy herdr work surface" });
      if (await herdrWiz.isVisible().catch(() => false)) {
        await herdrWiz.click();
        await page.waitForTimeout(600);
        await shot(page, "22-herdr-wizard");
        // Closes on backdrop click or its cancel button — no Escape handler.
        await page.getByRole("button", { name: "cancel" }).click();
        await page.waitForTimeout(300);
      }
    }

    // LAST: native terminal (its workbench surface has no close affordance
    // yet — it would cover the canvas for every later step).
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await page.waitForTimeout(600);
    await termNode.scrollIntoViewIfNeeded();
    await termNode.getByRole("button", { name: "Start" }).click();
    const surface = page.locator(".native-terminal-surface");
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(surface.locator(".native-terminal-surface__status")).toContainText(
      /control|attaching/,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(900);
    await shot(page, "09-native-terminal-focus");
    await page.getByRole("button", { name: "Pin all" }).click();
    await page.waitForTimeout(700);
    await shot(page, "09b-native-terminal-pinned");
  } finally {
    await vellum.close();
  }
});
