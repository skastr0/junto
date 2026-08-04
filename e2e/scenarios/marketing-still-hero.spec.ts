/**
 * Hero still — one frame that shows the factory grammar honestly:
 *   - agents wired to sinks (never agent↔agent pairs)
 *   - a live browser page bound to the writer seat
 *   - a claimed input-required request blocking its claimant (fire)
 *   - an empty queue + free seat reading as calm capacity (ice)
 *   - text notes as on-canvas context, one per region
 *   - mocked usage rail (fake codexbar) so the top chrome sits balanced
 *
 * Canvas name is `factory`. Same layout discipline as marketing-stills:
 * fixed card pitch, edges only along free corridors, no overlaps.
 *
 *   MARKETING_SHOTS_DIR=/path bun run test:e2e:fast e2e/scenarios/marketing-still-hero.spec.ts
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  agentTextNode,
  artifactsNode,
  canvasDoc,
  requestsNode,
  taskItem,
  tasksNode,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";
import type {
  Artifact,
  CanvasEdge,
  CanvasNode,
  LinkNode,
  Task,
  TextNode,
} from "../../src/shared/canvas";

const SHOTS =
  process.env.MARKETING_SHOTS_DIR ?? join(process.cwd(), "test-results", "marketing-stills");

const FRAME = { width: 1760, height: 1100 };

const CW = 260;
const CH = 120;
const GAP_X = 120;
const COL = CW + GAP_X; // 380
const PAD = 56;
const ROW = CH + 40; // 160

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(500);
  await page.screenshot({
    path: join(SHOTS, `${name}.png`),
    fullPage: false,
    animations: "disabled",
  });
};

const resizeFrame = async (
  app: {
    evaluate: (
      fn: (bw: typeof import("electron"), size: { width: number; height: number }) => void,
      size: { width: number; height: number },
    ) => Promise<void>;
  },
  page: Page,
) => {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setSize(size.width, size.height);
      win.center();
    }
  }, FRAME);
  await page.emulateMedia({ reducedMotion: "reduce" });
};

/** Hide the demo chip only — the usage rail stays visible (mocked codexbar). */
const hideDemoChip = async (page: Page) => {
  await page
    .getByText("DEMO - F9 to roll", { exact: false })
    .evaluate((el) => {
      const chip = el.parentElement;
      if (chip) chip.style.display = "none";
    })
    .catch(() => undefined);
};

const fitAll = async (page: Page) => {
  const fit = page.getByRole("button", { name: /fit all/i });
  if (await fit.isVisible().catch(() => false)) await fit.click();
  await page.waitForTimeout(900);
};

const richTask = (
  id: string,
  brief: string,
  state: Task["state"],
  workRole: string,
  claimedBy?: string,
): Task => {
  const base = taskItem(id, brief, state);
  return {
    ...base,
    metadata: {
      workRole,
      ...(claimedBy ? { claimedBy } : {}),
      details: brief,
    },
  };
};

const hEdge = (id: string, from: string, to: string): CanvasEdge => ({
  id,
  fromNode: from,
  toNode: to,
  fromSide: "right",
  toSide: "left",
  ether: { kind: "relates" },
});

const vEdge = (id: string, from: string, to: string): CanvasEdge => ({
  id,
  fromNode: from,
  toNode: to,
  fromSide: "bottom",
  toSide: "top",
  ether: { kind: "relates" },
});

const note = (id: string, text: string, x: number, y: number, width = 320): TextNode => ({
  id,
  type: "text",
  text,
  x,
  y,
  width,
  height: 96,
});

// Mocked usage rail — two believable quotas so the top chrome reads real.
const codexbarScenario = {
  mode: "healthy",
  quotas: [
    {
      provider: "codex",
      source: "cli",
      usage: {
        accountEmail: "ops@example.com",
        loginMethod: "chatgpt",
        primary: { usedPercent: 42, windowMinutes: 300, resetDescription: "resets in 5h" },
        secondary: { usedPercent: 7, windowMinutes: 10080 },
        updatedAt: new Date().toISOString(),
      },
    },
    {
      provider: "claude",
      source: "cli",
      usage: {
        accountEmail: "ops@example.com",
        loginMethod: "chatgpt",
        primary: { usedPercent: 63, windowMinutes: 300, resetDescription: "resets in 2h" },
        secondary: { usedPercent: 18, windowMinutes: 10080 },
        updatedAt: new Date().toISOString(),
      },
    },
  ],
};

test("still 00 — factory hero board", async () => {
  await mkdir(SHOTS, { recursive: true });

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  // ── region A - scribe - landing — queue → writer → artifacts, page below ──
  const aX = 0;
  const aY = 0;
  const aW = PAD + 3 * CW + 2 * GAP_X + PAD; // 1132
  const aH = PAD + 2 * CH + 40 + PAD; // 392
  nodes.push({
    id: "rg-scribe",
    type: "group",
    label: "scribe - landing",
    x: aX,
    y: aY,
    width: aW,
    height: aH,
    ether: { region: { hold: true } },
  });
  const ac0 = aX + PAD;
  const ac1 = ac0 + COL;
  const ac2 = ac1 + COL;
  const ar0 = aY + PAD;
  const ar1 = ar0 + ROW;
  nodes.push(
    tasksNode({
      id: "tasks-scribe",
      x: ac0,
      y: ar0,
      items: [
        richTask("t-a1", "draft hero section", "working", "Writer", "local:writer"),
        richTask("t-a2", "rewrite pricing faq", "submitted", "Writer"),
      ],
    }),
    agentTextNode({ id: "a-writer", key: "local:writer", label: "writer", host: "local", x: ac1, y: ar0 }),
    artifactsNode({
      id: "art-scribe",
      x: ac2,
      y: ar0,
      items: [
        {
          artifactId: "a-1",
          name: "hero-copy.md",
          task: {
            kind: "task",
            itemId: "t-a1",
            sink: { canvasName: "factory", nodeId: "tasks-scribe" },
          },
          parts: [{ kind: "text", text: "# All your agents. One factory." }],
        },
        {
          artifactId: "a-2",
          name: "launch-notes.md",
          task: {
            kind: "task",
            itemId: "t-a1",
            sink: { canvasName: "factory", nodeId: "tasks-scribe" },
          },
          parts: [{ kind: "text", text: "# Beta launch\n\n- hero still\n- fleet map" }],
        },
      ] satisfies Artifact[],
    }),
  );
  const pageNode: LinkNode = {
    id: "page-landing",
    type: "link",
    url: "https://vellumcommand.com",
    x: ac1,
    y: ar1,
    width: CW,
    height: 96,
    ether: {
      entity: { kind: "page" },
      host: "local",
      browser: { profile: "work" },
    },
  };
  nodes.push(pageNode);
  edges.push(
    hEdge("e-a-queue", "tasks-scribe", "a-writer"),
    hEdge("e-a-out", "a-writer", "art-scribe"),
    vEdge("e-a-page", "a-writer", "page-landing"),
  );
  nodes.push(
    note(
      "note-scribe",
      "Writer pulls queued sections, drafts in the live page, files finished copy as artifacts.",
      aX + PAD,
      aY + aH + 24,
    ),
  );

  // ── region C - survey - standby — empty queue + free seat = ice ───────────
  const cX = aW + 64;
  const cY = 0;
  const cW = PAD + 2 * CW + GAP_X + PAD; // 752
  const cH = PAD + CH + PAD; // 232
  nodes.push({
    id: "rg-survey",
    type: "group",
    label: "survey - standby",
    x: cX,
    y: cY,
    width: cW,
    height: cH,
    ether: { region: { hold: true } },
  });
  nodes.push(
    agentTextNode({
      id: "a-research",
      key: "local:research",
      label: "research",
      host: "local",
      x: cX + PAD,
      y: cY + PAD,
    }),
    tasksNode({ id: "tasks-survey", x: cX + PAD + COL, y: cY + PAD, items: [] }),
  );
  edges.push(hEdge("e-c-queue", "a-research", "tasks-survey"));
  nodes.push(
    note(
      "note-survey",
      "Calm capacity — empty queue, free seat. Ice, not fire.",
      cX + PAD,
      cY + cH + 24,
      300,
    ),
  );

  // ── region B - forge - release gate — claimed request blocks its actor ────
  const bX = cX;
  const bY = cH + 128;
  const bW = cW;
  const bH = PAD + 2 * CH + 40 + PAD; // 392
  nodes.push({
    id: "rg-forge",
    type: "group",
    label: "forge - release gate",
    x: bX,
    y: bY,
    width: bW,
    height: bH,
    ether: { region: { hold: true } },
  });
  const bc0 = bX + PAD;
  const bc1 = bc0 + COL;
  const br0 = bY + PAD;
  const br1 = br0 + CH + 16;
  // Vertically centered between the two sink rows so both direct edges
  // fan out from its right side along clean corridors.
  const security = agentTextNode({
    id: "a-security",
    key: "remote-a:security",
    label: "security",
    host: "remote-a",
    x: bc0,
    y: br0 + Math.round((CH + 16) / 2),
  });
  nodes.push(
    { ...security, ether: { ...security.ether, flags: ["blocker"] } },
    tasksNode({
      id: "tasks-forge",
      x: bc1,
      y: br0,
      items: [
        richTask("t-b1", "sign release build", "working", "Security", "a-security"),
        richTask("t-b2", "rotate signing key", "submitted", "Security"),
      ],
    }),
    requestsNode({
      id: "req-forge",
      x: bc1,
      y: br1,
      items: [
        richTask("r-b1", "authorize signing identity", "input-required", "Security", "a-security"),
      ],
    }),
  );
  edges.push(hEdge("e-b-queue", "a-security", "tasks-forge"), {
    // Real gate: criteria edge from the request sink into the claimant actor.
    // The execution graph derives phase "blocks" from the claimed
    // input-required item — the red is physics, not paint.
    id: "e-b-req",
    fromNode: "req-forge",
    toNode: "a-security",
    fromSide: "left",
    toSide: "right",
    ether: { criteria: { mode: "tasks" } },
  });
  nodes.push(
    note(
      "note-forge",
      "Security claimed the signing request — blocked until you authorize it.",
      bX + PAD,
      bY + bH + 24,
    ),
  );

  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-hero-"));
  const scenarioPath = join(scenarioDir, "codexbar.json");
  await writeFile(scenarioPath, JSON.stringify(codexbarScenario));

  const vellum = await launchVellum({
    demo: true,
    seedCanvases: { factory: canvasDoc(nodes, edges) },
    extraEnv: { FAKE_CODEXBAR_SCENARIO: scenarioPath },
  });

  try {
    const { app, page } = vellum;
    await resizeFrame(app, page);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    await hideDemoChip(page);
    await fitAll(page);
    await shot(page, "00-canvas-factory-hero");
  } finally {
    await vellum.close();
  }
});
