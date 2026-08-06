/**
 * Static marketing stills — clean geometry only.
 *   01  one-region - short left→right chain
 *   02  two-region multi-host - each region a clean chain
 *   03  five-region map - three nodes per region, no cross-region edges
 *   04  six-machine fleet manager
 *   05  five-region - large forge with 2×2 agents → tasks/requests/artifacts
 *   06  work UI grid - kanban + requests + artifacts (composited)
 *   07  open UIs grid - managed agent terminal + native terminal
 *
 * Layout rules for canvas plates:
 *   - fixed card size 260×110; column pitch with ≥120px gaps
 *   - edges only along free corridors (right→left or bottom→top)
 *   - no overlapping nodes; nodes fully inside regions with pad
 *
 *   MARKETING_SHOTS_DIR=/path bun run test:e2e:fast e2e/scenarios/marketing-stills.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { demoCommand } from "../harness/demo";
import {
  agentTextNode,
  artifactsNode,
  canvasDoc,
  claimByNodeId,
  herdrTextNode,
  requestsNode,
  taskItem,
  tasksNode,
  terminalTextNode,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";
import type { Artifact, CanvasEdge, CanvasNode, GroupNode, Task } from "../../src/shared/canvas";
import type { DemoHerdrStatus } from "../../src/shared/demo";

const SHOTS =
  process.env.MARKETING_SHOTS_DIR ?? join(process.cwd(), "test-results", "marketing-stills");

const FRAME = { width: 1760, height: 1100 };

/** Column pitch from the widest card (herdr 260). Heights vary (tasks 120). */
const CW = 260;
const CH = 120; // max card height so regions never clip tasks sinks
/** Horizontal gap between card right edge and next card left edge. */
const GAP_X = 120;
const COL = CW + GAP_X; // 380
const PAD = 56;

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
      fn: (
        bw: typeof import("electron"),
        size: { width: number; height: number },
      ) => void,
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

const hideFilmChrome = async (page: Page) => {
  await page
    .getByText("DEMO - F9 to roll", { exact: false })
    .evaluate((el) => {
      const chip = el.parentElement;
      if (chip) chip.style.display = "none";
    })
    .catch(() => undefined);
  await page.addStyleTag({
    content: ".usage-hud { visibility: hidden !important; }",
  });
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
    // Claim is first-class domain state now; the sandbox resolves the
    // authored node id to the derived ActorSeatId when seeding work.
    ...(claimedBy ? { claimedBy: claimByNodeId(claimedBy) } : {}),
    metadata: {
      workRole,
      details: brief,
    },
  };
};

/** Horizontal neighbor edge — clear corridor between columns. */
const hEdge = (id: string, from: string, to: string): CanvasEdge => ({
  id,
  fromNode: from,
  toNode: to,
  fromSide: "right",
  toSide: "left",
  ether: { kind: "relates" },
});

/** Vertical neighbor edge — clear corridor between rows. */
const vEdge = (id: string, from: string, to: string): CanvasEdge => ({
  id,
  fromNode: from,
  toNode: to,
  fromSide: "bottom",
  toSide: "top",
  ether: { kind: "relates" },
});

const TERM_LAUNCH = {
  kind: "command" as const,
  argv: [
    "/bin/sh",
    "-c",
    "printf '\\033[1;33m● agent - ready\\033[0m\\r\\n$ bun run typecheck\\r\\n\\033[32m✓ pass\\033[0m\\r\\n'; exec sleep 3600",
  ],
};

/** Tile PNGs into a single grid (row-major). Uses system Python + Pillow. */
const compositeGrid = (
  inputs: readonly string[],
  output: string,
  cols: number,
  gap = 24,
  bg = "#0B0A08",
) => {
  const py = `
from PIL import Image
import sys
out = sys.argv[1]
cols = int(sys.argv[2])
gap = int(sys.argv[3])
bg = sys.argv[4]
paths = sys.argv[5:]
imgs = [Image.open(p).convert("RGB") for p in paths]
w = max(i.width for i in imgs)
h = max(i.height for i in imgs)
rows = (len(imgs) + cols - 1) // cols
canvas = Image.new("RGB", (cols * w + gap * (cols + 1), rows * h + gap * (rows + 1)), bg)
for idx, im in enumerate(imgs):
    r, c = divmod(idx, cols)
    x = gap + c * (w + gap) + (w - im.width) // 2
    y = gap + r * (h + gap) + (h - im.height) // 2
    canvas.paste(im, (x, y))
canvas.save(out, "PNG")
`;
  execFileSync(
    "python3",
    ["-c", py, output, String(cols), String(gap), bg, ...inputs],
    { stdio: "pipe" },
  );
};

interface Pane {
  readonly id: string;
  readonly host: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly agent: string;
  readonly label: string;
  readonly status: DemoHerdrStatus;
  readonly x: number;
  readonly y: number;
}

const lightPanes = async (page: Page, panes: readonly Pane[]) => {
  for (const p of panes) {
    const result = await demoCommand(page, {
      kind: "ensure-pane",
      pane: {
        host: p.host,
        paneId: p.paneId,
        agent: p.agent,
        label: p.label,
        cwd: "~/Projects/vellum",
      },
      status: p.status,
    });
    expect(result.ok, `ensure-pane ${p.paneId} @ ${p.host}`).toBe(true);
  }
};

const paneNode = (p: Pane) =>
  herdrTextNode({
    id: p.id,
    host: p.host,
    paneId: p.paneId,
    terminalId: p.terminalId,
    label: p.label,
    x: p.x,
    y: p.y,
  });

// ── 01 - one region - single clean chain ────────────────────────────────────

test("still 01 — one region factory close", async () => {
  await mkdir(SHOTS, { recursive: true });

  // Absolute content origin
  const ox = 0;
  const oy = 0;
  // Three columns, one row: herdr → tasks → agent → requests
  // Optional second herdr under first column, connected up via vertical? Skip —
  // keep one row only so every edge is a horizontal right→left hop.
  const c0 = ox + PAD;
  const c1 = c0 + COL;
  const c2 = c1 + COL;
  const c3 = c2 + COL;
  const y0 = oy + PAD;

  const panes: readonly Pane[] = [
    {
      id: "h1",
      host: "local",
      paneId: "w1:p01",
      terminalId: "term-p01",
      agent: "rivet",
      label: "typecheck",
      status: "working",
      x: c0,
      y: y0,
    },
  ];

  const regionW = c3 + CW + PAD - ox;
  const regionH = y0 + CH + PAD - oy;

  const region: GroupNode = {
    id: "rg-forge",
    type: "group",
    label: "forge - build lane",
    x: ox,
    y: oy,
    width: regionW,
    height: regionH,
    ether: { region: { hold: true } },
  };

  const nodes: readonly CanvasNode[] = [
    region,
    ...panes.map(paneNode),
    tasksNode({
      id: "tasks",
      x: c1,
      y: y0,
      items: [
        richTask("t-1", "ship design tokens", "working", "Builder", "agent"),
        richTask("t-2", "wire checkout", "submitted", "Builder"),
      ],
    }),
    agentTextNode({
      id: "agent",
      key: "local:builder",
      label: "builder",
      host: "local",
      x: c2,
      y: y0,
    }),
    requestsNode({
      id: "req",
      x: c3,
      y: y0,
      items: [richTask("r-1", "approve palette", "input-required", "Design")],
    }),
  ];

  const edges: readonly CanvasEdge[] = [
    hEdge("e1", "h1", "tasks"),
    hEdge("e2", "tasks", "agent"),
    hEdge("e3", "agent", "req"),
  ];

  const vellumCommand = await launchVellum({
    demo: true,
    seedCanvases: { portfolio: canvasDoc(nodes, edges) },
  });

  try {
    const { app, page } = vellumCommand;
    await resizeFrame(app, page);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    await lightPanes(page, panes);
    await hideFilmChrome(page);
    await fitAll(page);
    await shot(page, "01-canvas-one-region");
  } finally {
    await vellumCommand.close();
  }
});

// ── 02 - two regions - multi-host - two parallel chains ─────────────────────

test("still 02 — multi-host work board", async () => {
  await mkdir(SHOTS, { recursive: true });

  // Each region: herdr → tasks → agent  (3 nodes, 2 edges)
  // Stacked vertically with a clear gap between regions (no edges between them).
  const regionH = PAD + CH + PAD; // one row + pad
  const regionW = PAD + 3 * CW + 2 * GAP_X + PAD;
  const gapBetween = 80;

  // Region forge (local)
  const fx = 0;
  const fy = 0;
  const forge: GroupNode = {
    id: "rg-forge",
    type: "group",
    label: "forge - local",
    x: fx,
    y: fy,
    width: regionW,
    height: regionH,
    ether: { region: { hold: true } },
  };
  const f0 = fx + PAD;
  const f1 = f0 + COL;
  const f2 = f1 + COL;
  const fy0 = fy + PAD;

  // Region beacon (remote-a) below
  const bx = 0;
  const by = fy + regionH + gapBetween;
  const beacon: GroupNode = {
    id: "rg-beacon",
    type: "group",
    label: "beacon - remote-a",
    x: bx,
    y: by,
    width: regionW,
    height: regionH,
    ether: { region: { hold: true } },
  };
  const b0 = bx + PAD;
  const b1 = b0 + COL;
  const b2 = b1 + COL;
  const by0 = by + PAD;

  const panes: readonly Pane[] = [
    {
      id: "h-local",
      host: "local",
      paneId: "w1:p01",
      terminalId: "term-p01",
      agent: "rivet",
      label: "typecheck",
      status: "working",
      x: f0,
      y: fy0,
    },
    {
      id: "h-mini",
      host: "remote-a",
      paneId: "w1:p02",
      terminalId: "term-p02",
      agent: "ward",
      label: "release notes",
      status: "blocked",
      x: b0,
      y: by0,
    },
  ];

  const nodes: readonly CanvasNode[] = [
    forge,
    beacon,
    ...panes.map(paneNode),
    tasksNode({
      id: "tasks-forge",
      x: f1,
      y: fy0,
      items: [
        richTask("t-1", "ship tokens", "working", "Builder", "a-builder"),
        richTask("t-2", "green e2e", "submitted", "Builder"),
      ],
    }),
    agentTextNode({
      id: "a-builder",
      key: "local:builder",
      label: "builder",
      host: "local",
      x: f2,
      y: fy0,
    }),
    tasksNode({
      id: "tasks-beacon",
      x: b1,
      y: by0,
      items: [
        richTask("t-3", "founder pricing", "input-required", "Release", "a-release"),
      ],
    }),
    agentTextNode({
      id: "a-release",
      key: "remote-a:release",
      label: "release",
      host: "remote-a",
      x: b2,
      y: by0,
    }),
  ];

  const edges: readonly CanvasEdge[] = [
    hEdge("e-f1", "h-local", "tasks-forge"),
    hEdge("e-f2", "tasks-forge", "a-builder"),
    hEdge("e-b1", "h-mini", "tasks-beacon"),
    hEdge("e-b2", "tasks-beacon", "a-release"),
  ];

  const vellumCommand = await launchVellum({
    demo: true,
    seedCanvases: { portfolio: canvasDoc(nodes, edges) },
  });

  try {
    const { app, page } = vellumCommand;
    await resizeFrame(app, page);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    await lightPanes(page, panes);
    await hideFilmChrome(page);
    await fitAll(page);
    await shot(page, "02-canvas-multi-host-work");
  } finally {
    await vellumCommand.close();
  }
});

// ── 03 - five regions - 3-node chain each - no cross edges ──────────────────

test("still 03 — five region factory map", async () => {
  await mkdir(SHOTS, { recursive: true });

  // Each region: herdr → tasks → agent
  // Grid: 3 on top row, 2 on bottom row centered under the top three.
  const regionW = PAD + 3 * CW + 2 * GAP_X + PAD; // ~896
  const regionH = PAD + CH + PAD; // ~206
  const gapX = 60;
  const gapY = 70;

  type Orbit = {
    readonly id: string;
    readonly label: string;
    readonly host: string;
    readonly agent: string;
    readonly agentKey: string;
    readonly agentLabel: string;
    readonly status: DemoHerdrStatus;
    readonly workLabel: string;
    readonly taskBrief: string;
    readonly taskState: Task["state"];
    readonly col: number; // 0..2 top, 0..1 bottom
    readonly row: number; // 0 top, 1 bottom
  };

  const orbits: readonly Orbit[] = [
    {
      id: "forge",
      label: "forge - build",
      host: "local",
      agent: "rivet",
      agentKey: "local:builder",
      agentLabel: "builder",
      status: "working",
      workLabel: "typecheck",
      taskBrief: "ship tokens",
      taskState: "working",
      col: 0,
      row: 0,
    },
    {
      id: "beacon",
      label: "beacon - launch",
      host: "remote-a",
      agent: "ward",
      agentKey: "remote-a:release",
      agentLabel: "release",
      status: "idle",
      workLabel: "release",
      taskBrief: "pricing lock",
      taskState: "input-required",
      col: 1,
      row: 0,
    },
    {
      id: "survey",
      label: "survey - research",
      host: "remote-a",
      agent: "gauge",
      agentKey: "remote-a:research",
      agentLabel: "research",
      status: "working",
      workLabel: "quasar",
      taskBrief: "mine sessions",
      taskState: "working",
      col: 2,
      row: 0,
    },
    {
      id: "scribe",
      label: "scribe - copy",
      host: "local",
      agent: "relay",
      agentKey: "local:writer",
      agentLabel: "writer",
      status: "working",
      workLabel: "landing",
      taskBrief: "factory section",
      taskState: "submitted",
      col: 0,
      row: 1,
    },
    {
      id: "oracle",
      label: "oracle - ops",
      host: "local",
      agent: "mote",
      agentKey: "local:ops",
      agentLabel: "ops",
      status: "blocked",
      workLabel: "health",
      taskBrief: "station probe",
      taskState: "input-required",
      col: 1,
      row: 1,
    },
  ];

  // Bottom row has 2 regions — offset so they sit under the top trio with equal side margins.
  const topSpan = 3 * regionW + 2 * gapX;
  const bottomSpan = 2 * regionW + gapX;
  const bottomOffset = Math.round((topSpan - bottomSpan) / 2);

  const originX = (o: Orbit) =>
    o.row === 0
      ? o.col * (regionW + gapX)
      : bottomOffset + o.col * (regionW + gapX);
  const originY = (o: Orbit) => o.row * (regionH + gapY);

  const regions: GroupNode[] = [];
  const panes: Pane[] = [];
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  for (const [i, o] of orbits.entries()) {
    const rx = originX(o);
    const ry = originY(o);
    const c0 = rx + PAD;
    const c1 = c0 + COL;
    const c2 = c1 + COL;
    const y0 = ry + PAD;
    const herdrId = `h-${o.id}`;
    const tasksId = `t-${o.id}`;
    const agentId = `a-${o.id}`;
    const paneId = `w1:p${String(i + 1).padStart(2, "0")}`;

    regions.push({
      id: `rg-${o.id}`,
      type: "group",
      label: o.label,
      x: rx,
      y: ry,
      width: regionW,
      height: regionH,
      ether: { region: { hold: true } },
    });

    panes.push({
      id: herdrId,
      host: o.host,
      paneId,
      terminalId: `term-${o.id}`,
      agent: o.agent,
      label: o.workLabel,
      status: o.status,
      x: c0,
      y: y0,
    });

    nodes.push(
      tasksNode({
        id: tasksId,
        x: c1,
        y: y0,
        items: [
          richTask(
            `${o.id}-task`,
            o.taskBrief,
            o.taskState,
            o.agentLabel,
            // Claim by the authored agent node id; submitted tasks carry no claim.
            o.taskState === "submitted" ? undefined : `a-${o.id}`,
          ),
        ],
      }),
      agentTextNode({
        id: agentId,
        key: o.agentKey,
        label: o.agentLabel,
        host: o.host,
        x: c2,
        y: y0,
      }),
    );

    edges.push(hEdge(`e-${o.id}-1`, herdrId, tasksId), hEdge(`e-${o.id}-2`, tasksId, agentId));
  }

  const allNodes: CanvasNode[] = [...regions, ...panes.map(paneNode), ...nodes];

  const vellumCommand = await launchVellum({
    demo: true,
    seedCanvases: { portfolio: canvasDoc(allNodes, edges) },
  });

  try {
    const { app, page } = vellumCommand;
    await resizeFrame(app, page);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    await lightPanes(page, panes);
    await hideFilmChrome(page);
    await fitAll(page);
    await shot(page, "03-canvas-five-regions");
  } finally {
    await vellumCommand.close();
  }
});

// ── 04 - six-machine fleet manager (unchanged composition) ──────────────────

test("still 04 — six machine fleet manager", async () => {
  await mkdir(SHOTS, { recursive: true });

  const vellumCommand = await launchVellum({
    seedCanvases: { fleet: canvasDoc([]) },
    seedHosts: [
        {
          id: "local",
          label: "local",
          kind: "local",
          capabilities: ["herdr", "hermes", "browser"],
        },
        {
          id: "remote-a",
          label: "remote-a",
          kind: "remote",
          sshEndpoint: "remote-a",
          capabilities: ["herdr", "hermes", "terminal"],
          hermesId: "remote-a",
        },
        {
          id: "mac-studio",
          label: "mac-studio",
          kind: "remote",
          sshEndpoint: "mac-studio",
          capabilities: ["herdr", "hermes", "browser", "terminal"],
          appearance: { color: "#E6A94A", glyph: "remote-anchor" },
        },
        {
          id: "forge-pi",
          label: "forge-pi",
          kind: "remote",
          sshEndpoint: "forge-pi",
          capabilities: ["terminal"],
          appearance: { color: "#39C6D6", glyph: "remote-anchor" },
        },
        {
          id: "relay-1",
          label: "relay-1",
          kind: "remote",
          sshEndpoint: "relay-1",
          capabilities: ["hermes", "browser"],
          appearance: { color: "#7F6DD6", glyph: "relay-obelisk" },
        },
        {
          id: "archive",
          label: "archive",
          kind: "remote",
          sshEndpoint: "archive",
          capabilities: ["terminal", "browser"],
          appearance: { glyph: "artifact-vault" },
        },
      ],
  });

  try {
    const { app, page } = vellumCommand;
    await resizeFrame(app, page);
    await expect(page.locator(".react-flow").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Open fleet manager" }).click();
    const panel = page.locator(".fleet-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".fleet-machine-object--ready")).toHaveCount(6, {
      timeout: 20_000,
    });
    await page.waitForTimeout(1500);
    await shot(page, "04-fleet-six-machines");

    const stations = page.locator(".fleet-station");
    if ((await stations.count()) > 0) {
      await stations.first().click();
      await page.waitForTimeout(400);
      await shot(page, "04b-fleet-station-focus");
    }
  } finally {
    await vellumCommand.close();
  }
});

// ── 05 - five regions - large forge with 2×2 agents + work sinks ────────────

test("still 05 — five regions agent square", async () => {
  await mkdir(SHOTS, { recursive: true });

  // Small satellite regions: herdr → agent (2 nodes). Large forge: 2×2 agents
  // on the left, sink column (tasks / requests / artifacts) on the right.
  // Only the right-column agents edge into sinks so corridors stay empty;
  // left-column agents join via the square ring.
  const smallW = PAD + 2 * CW + GAP_X + PAD;
  const smallH = PAD + CH + PAD;
  const gap = 64;

  // Forge: 2 agent cols + 1 sink col
  const forgeW = PAD + 3 * CW + 2 * GAP_X + PAD;
  const forgeH = PAD + 3 * CH + 2 * 40 + PAD; // 3 sink rows

  // Top row: three small regions
  const satellites: Array<{
    id: string;
    label: string;
    host: string;
    agent: string;
    agentKey: string;
    agentLabel: string;
    status: DemoHerdrStatus;
    work: string;
    col: number;
  }> = [
    {
      id: "beacon",
      label: "beacon - launch",
      host: "remote-a",
      agent: "ward",
      agentKey: "remote-a:release",
      agentLabel: "release",
      status: "idle",
      work: "release",
      col: 0,
    },
    {
      id: "survey",
      label: "survey - research",
      host: "remote-a",
      agent: "gauge",
      agentKey: "remote-a:research",
      agentLabel: "research",
      status: "working",
      work: "quasar",
      col: 1,
    },
    {
      id: "scribe",
      label: "scribe - copy",
      host: "local",
      agent: "relay",
      agentKey: "local:writer",
      agentLabel: "writer",
      status: "working",
      work: "landing",
      col: 2,
    },
  ];

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const panes: Pane[] = [];

  for (const [i, s] of satellites.entries()) {
    const rx = s.col * (smallW + gap);
    const ry = 0;
    const c0 = rx + PAD;
    const c1 = c0 + COL;
    const y0 = ry + PAD;
    const herdrId = `h-${s.id}`;
    const agentId = `a-${s.id}`;
    nodes.push({
      id: `rg-${s.id}`,
      type: "group",
      label: s.label,
      x: rx,
      y: ry,
      width: smallW,
      height: smallH,
      ether: { region: { hold: true } },
    });
    panes.push({
      id: herdrId,
      host: s.host,
      paneId: `w1:p${String(i + 1).padStart(2, "0")}`,
      terminalId: `term-${s.id}`,
      agent: s.agent,
      label: s.work,
      status: s.status,
      x: c0,
      y: y0,
    });
    nodes.push(
      agentTextNode({
        id: agentId,
        key: s.agentKey,
        label: s.agentLabel,
        host: s.host,
        x: c1,
        y: y0,
      }),
    );
    edges.push(hEdge(`e-${s.id}`, herdrId, agentId));
  }

  // Large forge below, left-aligned under the top row span
  const forgeX = 0;
  const forgeY = smallH + gap;
  nodes.push({
    id: "rg-forge",
    type: "group",
    label: "forge - build lane",
    x: forgeX,
    y: forgeY,
    width: forgeW,
    height: forgeH,
    ether: { region: { hold: true } },
  });

  // 2×2 agent square (left)
  const ax0 = forgeX + PAD;
  const ax1 = ax0 + COL;
  const ay0 = forgeY + PAD;
  const ay1 = ay0 + CH + 40;
  const agents = [
    { id: "a-builder", key: "local:builder", label: "builder", host: "local", x: ax0, y: ay0 },
    { id: "a-security", key: "local:security", label: "security", host: "local", x: ax1, y: ay0 },
    { id: "a-review", key: "remote-a:review", label: "reviewer", host: "remote-a", x: ax0, y: ay1 },
    { id: "a-release", key: "remote-a:release2", label: "releaser", host: "remote-a", x: ax1, y: ay1 },
  ] as const;
  for (const a of agents) {
    nodes.push(
      agentTextNode({
        id: a.id,
        key: a.key,
        label: a.label,
        host: a.host,
        x: a.x,
        y: a.y,
      }),
    );
  }
  // Square ring — no diagonals
  edges.push(
    hEdge("e-sq-top", "a-builder", "a-security"),
    hEdge("e-sq-bot", "a-review", "a-release"),
    vEdge("e-sq-left", "a-builder", "a-review"),
    vEdge("e-sq-right", "a-security", "a-release"),
  );

  // Sink column to the right of the square.
  // Align tasks with top agent row, requests with bottom agent row, artifacts under.
  const sx = ax1 + COL;
  const sinkGap = 40;
  const sy0 = ay0;
  const sy1 = ay1;
  const sy2 = ay1 + CH + sinkGap;

  nodes.push(
    tasksNode({
      id: "tasks-forge",
      x: sx,
      y: sy0,
      items: [
        richTask("t-1", "ship design tokens", "working", "Builder", "a-builder"),
        richTask("t-2", "wire founder checkout", "submitted", "Builder"),
        richTask("t-3", "authorize signing", "input-required", "Security", "a-security"),
        richTask("t-4", "green e2e stills", "working", "Reviewer", "a-review"),
      ],
    }),
    requestsNode({
      id: "req-forge",
      x: sx,
      y: sy1,
      items: [
        richTask("r-1", "approve founder pricing", "input-required", "Release", "a-release"),
        richTask("r-2", "confirm palette", "input-required", "Design", "a-builder"),
      ],
    }),
    artifactsNode({
      id: "art-forge",
      x: sx,
      y: sy2,
      items: [
        {
          artifactId: "a-1",
          name: "tokens.json",
          task: {
            kind: "task",
            itemId: "t-1",
            sink: { canvasName: "portfolio", nodeId: "tasks-forge" },
          },
          parts: [{ kind: "text", text: '{ "signal": "#E6A94A" }' }],
        },
        {
          artifactId: "a-2",
          name: "release-notes.md",
          task: {
            kind: "task",
            itemId: "t-4",
            sink: { canvasName: "portfolio", nodeId: "tasks-forge" },
          },
          parts: [{ kind: "text", text: "# Beta stills\n\n- factory board\n- fleet map" }],
        },
      ] satisfies Artifact[],
    }),
  );

  // Right-column agents feed sinks on clear horizontal corridors.
  // Left-column agents reach sinks via the square ring (no edge-over-node).
  // Sink column is a vertical chain ending at artifacts.
  edges.push(
    hEdge("e-sec-tasks", "a-security", "tasks-forge"),
    hEdge("e-rel-req", "a-release", "req-forge"),
    hEdge("e-rel-art", "a-release", "art-forge"),
    vEdge("e-tasks-req", "tasks-forge", "req-forge"),
    vEdge("e-req-art", "req-forge", "art-forge"),
  );

  // Grow forge height so artifacts sits inside the region.
  const forgeNeededH = sy2 + CH + PAD - forgeY;
  const forgeRegion = nodes.find((n) => n.id === "rg-forge");
  if (forgeRegion && forgeRegion.type === "group") {
    (forgeRegion as { height: number }).height = Math.max(forgeH, forgeNeededH);
  }

  // Oracle satellite to the right of forge
  const oracleX = forgeW + gap;
  const oracleY = forgeY;
  nodes.push({
    id: "rg-oracle",
    type: "group",
    label: "oracle - ops",
    x: oracleX,
    y: oracleY,
    width: smallW,
    height: smallH,
    ether: { region: { hold: true } },
  });
  panes.push({
    id: "h-oracle",
    host: "local",
    paneId: "w1:p10",
    terminalId: "term-oracle",
    agent: "mote",
    label: "health",
    status: "blocked",
    x: oracleX + PAD,
    y: oracleY + PAD,
  });
  nodes.push(
    agentTextNode({
      id: "a-ops",
      key: "local:ops",
      label: "ops",
      host: "local",
      x: oracleX + PAD + COL,
      y: oracleY + PAD,
    }),
  );
  edges.push(hEdge("e-oracle", "h-oracle", "a-ops"));

  const allNodes: CanvasNode[] = [...nodes, ...panes.map(paneNode)];

  const vellumCommand = await launchVellum({
    demo: true,
    seedCanvases: { portfolio: canvasDoc(allNodes, edges) },
  });

  try {
    const { app, page } = vellumCommand;
    await resizeFrame(app, page);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    await lightPanes(page, panes);
    await hideFilmChrome(page);
    await fitAll(page);
    await shot(page, "05-canvas-five-regions-agent-square");
  } finally {
    await vellumCommand.close();
  }
});

// ── 06 - work UI grid - kanban + requests + artifacts ───────────────────────

test("still 06 — work UI grid", async () => {
  await mkdir(SHOTS, { recursive: true });

  const auditTask = (
    id: string,
    brief: string,
    state: Task["state"],
    workRole: string,
    claimedBy?: string,
    update?: string,
  ): Task => {
    const task = richTask(id, brief, state, workRole, claimedBy);
    if (!update) return task;
    return {
      ...task,
      history: [
        ...task.history,
        {
          messageId: `${id}-m1`,
          role: "agent",
          parts: [{ kind: "text", text: update }],
          taskId: id,
          contextId: "marketing",
        },
      ],
    };
  };

  // Work-plane seeds require compiled local actor seats to raise claims,
  // requests, and artifacts; each seat owns at most one active task, so the
  // claimed kanban items are spread across four seats under the sink row.
  const doc = canvasDoc(
    [
    tasksNode({
      id: "tasks1",
      x: 40,
      y: 40,
      items: [
        auditTask("t-1", "Ship browser containment probe", "submitted", "Builder"),
        auditTask("t-2", "Fix stale host badge", "working", "Builder", "a-builder"),
        auditTask(
          "t-3",
          "Clarify claim tick rules",
          "input-required",
          "Release Engineer",
          "a-security",
          "Which worker should own tasks without a matching role?",
        ),
        auditTask(
          "t-4",
          "Enable remote session capture",
          "input-required",
          "Security Agent",
          "a-ops",
          "Operator authorization is required before opening the remote capability.",
        ),
        auditTask("t-5", "Rotate service key material", "completed", "Security Agent", "a-review"),
        auditTask(
          "t-6",
          "Reject unsafe host cleanup",
          "rejected",
          "Security Agent",
          "a-review",
          "The proposed operation exceeded the connected capability scope.",
        ),
      ],
    }),
    requestsNode({
      id: "req1",
      x: 360,
      y: 40,
      items: [
        {
          ...taskItem("r-1", "Confirm release signing identity", "input-required"),
          metadata: {
            title: "Confirm release signing identity",
            details:
              "Verify which signing identity should be used before the release artifact is distributed to remote stations.",
          },
          history: [
            ...taskItem("r-1", "Confirm release signing identity", "input-required").history,
            {
              messageId: "r-1-m1",
              role: "agent",
              parts: [
                {
                  kind: "text",
                  text: "The distribution step is paused until the operator confirms the identity.",
                },
              ],
              taskId: "r-1",
              contextId: "marketing",
            },
          ],
        },
        {
          ...taskItem("r-2", "Choose retention window", "completed"),
          metadata: {
            title: "Choose retention window",
            details: "Select the duration for preserving completed task telemetry.",
          },
        },
      ],
    }),
    artifactsNode({
      id: "art1",
      x: 680,
      y: 40,
      items: [
        {
          artifactId: "a-1",
          name: "release-v1.4.2-sigstore.json",
          task: {
            kind: "task",
            itemId: "t-2",
            sink: { canvasName: "portfolio", nodeId: "tasks1" },
          },
          parts: [
            {
              kind: "text",
              text: '{\n  "subject": "vellum-command",\n  "verified": true\n}',
            },
          ],
          metadata: { mediaType: "application/json", proof: "verified" },
        },
        {
          artifactId: "a-2",
          name: "station-deployment-report",
          task: {
            kind: "task",
            itemId: "t-5",
            sink: { canvasName: "portfolio", nodeId: "tasks1" },
          },
          parts: [{ kind: "text", text: "All five stations projected generation 12." }],
        },
        {
          artifactId: "a-3",
          name: "containment-observations.txt",
          parts: [{ kind: "text", text: "No capability escaped the connected task edge." }],
        },
      ] satisfies Artifact[],
    }),
    agentTextNode({
      id: "a-builder",
      key: "local:builder",
      label: "builder",
      host: "local",
      x: 40,
      y: 200,
    }),
    agentTextNode({
      id: "a-security",
      key: "local:security",
      label: "security",
      host: "local",
      x: 300,
      y: 200,
    }),
    agentTextNode({
      id: "a-ops",
      key: "local:ops",
      label: "ops",
      host: "local",
      x: 560,
      y: 200,
    }),
    agentTextNode({
      id: "a-review",
      key: "local:review",
      label: "review",
      host: "local",
      x: 820,
      y: 200,
    }),
  ],
    [
      hEdge("e-t1-builder", "tasks1", "a-builder"),
      hEdge("e-r1-security", "req1", "a-security"),
      hEdge("e-a1-ops", "art1", "a-ops"),
    ],
  );

  const vellumCommand = await launchVellum({
    seedCanvases: { portfolio: doc },
  });

  try {
    const { app, page } = vellumCommand;
    await resizeFrame(app, page);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    await hideFilmChrome(page);
    await fitAll(page);

    const grab = async (name: string) => {
      const path = join(SHOTS, name);
      await page.waitForTimeout(350);
      await page.screenshot({ path, fullPage: false, animations: "disabled" });
      return path;
    };

    // Kanban
    await page
      .locator('.react-flow__node[data-id="tasks1"]')
      .getByTestId("tasks-card")
      .dispatchEvent("dblclick");
    const taskFlow = page.getByRole("dialog", { name: "Task flow" });
    await expect(taskFlow).toBeVisible({ timeout: 10_000 });
    await expect(taskFlow.getByTestId("task-board")).toBeVisible();
    const kanbanPath = await grab("06a-ui-kanban.png");
    await taskFlow.locator('button[title="Close"]').click();
    await expect(taskFlow).toBeHidden();

    // Requests
    await page
      .locator('.react-flow__node[data-id="req1"]')
      .getByTestId("requests-card")
      .dispatchEvent("dblclick");
    const requestInbox = page.getByRole("dialog", { name: "Input requests" });
    await expect(requestInbox).toBeVisible({ timeout: 10_000 });
    const reqPath = await grab("06b-ui-requests.png");
    await requestInbox.locator('button[title="Close"]').click();
    await expect(requestInbox).toBeHidden();

    // Artifacts
    await page
      .locator('.react-flow__node[data-id="art1"]')
      .getByTestId("artifacts-card")
      .dispatchEvent("dblclick");
    const artifactLibrary = page.getByRole("dialog", { name: "Artifacts" });
    await expect(artifactLibrary).toBeVisible({ timeout: 10_000 });
    const artPath = await grab("06c-ui-artifacts.png");
    await artifactLibrary.locator('button[title="Close"]').click();

    compositeGrid([kanbanPath, reqPath, artPath], join(SHOTS, "06-ui-work-grid.png"), 3, 32);
  } finally {
    await vellumCommand.close();
  }
});

// ── 07 - open surfaces grid - managed agent terminal + native terminal ─────
// The ACP chat UI is unshipped product (ACP_CHAT_SURFACE_HIDDEN): the managed
// terminal is the one agent work surface. Minimal seed nodes only exist so
// the open workbenches can be launched. The plate is the opened workbench,
// not a board of terminal/agent cards.

test("still 07 — open terminal and ACP UIs", async () => {
  test.setTimeout(120_000);
  await mkdir(SHOTS, { recursive: true });

  // Minimal seed — only what we open. The plate is the open workbench, not the cards.
  const nodes: CanvasNode[] = [
    agentTextNode({
      id: "agent-a",
      key: "local:builder",
      label: "builder",
      host: "local",
      x: 40,
      y: 40,
    }),
    terminalTextNode({
      id: "term-a",
      bindingId: "bind-a",
      label: "build - typecheck",
      launch: TERM_LAUNCH,
      x: 360,
      y: 40,
    }),
  ];

  const vellumCommand = await launchVellum({
    seedCanvases: { portfolio: canvasDoc(nodes) },
  });

  try {
    const { app, page } = vellumCommand;
    await resizeFrame(app, page);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    await hideFilmChrome(page);
    await fitAll(page);

    const grab = async (name: string) => {
      const path = join(SHOTS, name);
      await page.waitForTimeout(400);
      await page.screenshot({ path, fullPage: false, animations: "disabled" });
      return path;
    };

    // Real pointer dblclick (React onDoubleClick) — dispatchEvent does not open these surfaces.

    // 1 - Managed agent terminal workbench (the one agent work surface).
    const agentNode = page.locator(".react-flow__node", { hasText: "builder" }).first();
    await expect(agentNode).toBeVisible({ timeout: 15_000 });
    await agentNode.dblclick();
    const agentSurface = page.locator(".native-terminal-surface");
    await expect(agentSurface).toBeVisible({ timeout: 15_000 });
    await expect(
      agentSurface.locator(".native-terminal-surface__status"),
    ).toContainText(/control|attaching|ready|live|running|connected/i, {
      timeout: 20_000,
    });
    await page.waitForTimeout(800);
    const agentTermPath = await grab("07a-ui-agent-terminal.png");
    await agentSurface.getByRole("button", { name: "Close view" }).click();
    await expect(agentSurface).toBeHidden();
    await page.waitForTimeout(400);

    // 2 - Native terminal workbench
    const termNode = page.locator(".react-flow__node", { hasText: "build - typecheck" }).first();
    await expect(termNode).toBeVisible({ timeout: 15_000 });
    await termNode.dblclick();
    const surface = page.locator(".native-terminal-surface");
    await expect(surface).toBeVisible({ timeout: 15_000 });
    await expect(surface.locator(".native-terminal-surface__status")).toContainText(
      /control|attaching|ready|live|running|connected/i,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(800);
    const termPath = await grab("07b-ui-native-terminal.png");

    // Open-UI grid only — managed agent terminal + native terminal workbench
    // (not canvas cards).
    compositeGrid([agentTermPath, termPath], join(SHOTS, "07-ui-surfaces-grid.png"), 2, 32);
  } finally {
    await vellumCommand.close();
  }
});
