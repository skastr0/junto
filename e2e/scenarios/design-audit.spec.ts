/**
 * Design-audit capture — NOT a correctness spec. Drives every reachable UI
 * surface with seeded fixtures + the fake herdr/hermes/codexbar binaries and
 * screenshots each one to test-results/design-audit/ for visual review.
 *   bun run test:e2e:fast e2e/scenarios/design-audit.spec.ts
 * The screenshots are the artifact; assertions only prove a surface appeared.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  taskItem,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";
import type { Artifact, CanvasEdge, CanvasNode, GroupNode, LinkNode, Task } from "../../src/shared/canvas";

const SHOTS = join(process.cwd(), "test-results", "design-audit");

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

/** Install visual fixtures through the same authority write path as the app. */
const installAuditCanvas = async (page: Page, doc: ReturnType<typeof canvasDoc>) => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly vellum?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellum?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  await page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellum: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string }>;
          readonly readCanvas: (name: string) => Promise<{ revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).vellum;
    const list = await api.listCanvases();
    const name = list[0]?.name ?? (await api.createCanvas("design-audit")).name;
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, doc);
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
  ether: {
    entity: { kind: "page" },
    host: "local",
    browser: { profile: "personal" },
  },
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

const auditTask = (id: string, brief: string, state: Task["state"], claimedBy?: string, update?: string): Task => {
  const task = taskItem(id, brief, state);
  return {
    ...task,
    ...(claimedBy
      ? {
          metadata: {
            claimedBy,
            workRole: "Security Agent",
            details:
              "Validate the task against the station capability boundary, preserve the operator’s declared intent, and return concrete proof with the result.",
          },
        }
      : {}),
    ...(update
      ? {
          history: [
            ...task.history,
            {
              messageId: `${id}-m1`,
              role: "agent" as const,
              parts: [{ kind: "text" as const, text: update }],
              taskId: id,
              contextId: "e2e",
            },
          ],
        }
      : {}),
  };
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
  agentTextNode({
    id: "agent1",
    key: "local:default",
    label: "builder",
    x: 520,
    y: 460,
  }),
  tasksNode({
    id: "tasks1",
    x: 0,
    y: 620,
    items: [
      auditTask("t-1", "Ship browser containment probe", "submitted"),
      auditTask("t-2", "Fix stale host badge", "working", "remote-a:profile-06"),
      auditTask(
        "t-3",
        "Clarify claim tick rules",
        "input-required",
        "remote-a:profile-06",
        "Which worker should own tasks without a matching role?",
      ),
      auditTask(
        "t-4",
        "Enable remote session capture",
        "auth-required",
        "remote-a:profile-06",
        "Operator authorization is required before opening the remote capability.",
      ),
      auditTask("t-5", "Rotate service key material", "completed", "remote-a:profile-06"),
      auditTask(
        "t-6",
        "Reject unsafe host cleanup",
        "rejected",
        "remote-a:profile-06",
        "The proposed operation exceeded the connected capability scope.",
      ),
    ],
  }),
  requestsNode({
    id: "req1",
    x: 260,
    y: 620,
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
              {
                kind: "url",
                url: "https://example.com/release-signing-checklist",
                mediaType: "text/html",
              },
            ],
            taskId: "r-1",
            contextId: "e2e",
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
    x: 520,
    y: 620,
    items: [
      {
        artifactId: "a-1",
        name: "release-v1.4.2-sigstore.json",
        taskId: "t-2",
        parts: [
          {
            kind: "text",
            text: '{\n  "subject": "vellum-command",\n  "verified": true,\n  "issuer": "sigstore"\n}',
          },
        ],
        metadata: { mediaType: "application/json", proof: "verified" },
      },
      {
        artifactId: "a-2",
        name: "station-deployment-report",
        taskId: "t-5",
        parts: [
          {
            kind: "url",
            url: "https://example.com/deployment-report",
            mediaType: "text/html",
          },
        ],
      },
      {
        artifactId: "a-3",
        name: "containment-observations.txt",
        parts: [{ kind: "text", text: "No capability escaped the connected task edge." }],
      },
    ] satisfies Artifact[],
  }),
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
  {
    id: "e2",
    fromNode: "proj1",
    toNode: "proj2",
    fromSide: "right",
    toSide: "left",
  },
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
      {
        workspace_id: "w1",
        label: "demo",
        tab_count: 1,
        pane_count: 1,
        agent_status: "working",
        focused: true,
        number: 1,
      },
    ],
    tabs: [
      {
        tab_id: "w1:t1",
        workspace_id: "w1",
        label: "1",
        pane_count: 1,
        agent_status: "working",
        focused: true,
        number: 1,
      },
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
    layouts: [
      {
        workspace_id: "w1",
        tab_id: "w1:t1",
        panes: [],
        splits: [],
        zoomed: false,
      },
    ],
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
        {
          provider: "codex",
          usage: {
            loginMethod: "auto",
            primary: { usedPercent: 42, resetDescription: "3h 12m" },
            secondary: { usedPercent: 7, resetDescription: "5d 1h" },
          },
        },
        {
          provider: "claude",
          usage: {
            loginMethod: "auto",
            primary: { usedPercent: 18, resetDescription: "1h 40m" },
          },
        },
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
  });

  try {
    const { page } = vellum;

    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await installAuditCanvas(page, canvasDoc(nodes, edges));

    // React Flow only mounts on-screen nodes: wait for the first, fit the
    // whole board, THEN distant entity nodes exist in the DOM.
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 30_000,
    });
    const fit = page.getByRole("button", { name: /fit all/i });
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await page.waitForTimeout(800);
    const termNode = page.locator(".react-flow__node", {
      hasText: "audit native term",
    });
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
    await closeup("Fix stale host badge", "06-node-tasks");

    // Task flow: the full five-lane board, including attention and terminal
    // variants. Double-click is the work-surface affordance on canvas nodes.
    const tasksNodeCard = page.locator(".react-flow__node", { hasText: "Fix stale host badge" }).first();
    await tasksNodeCard.getByTestId("tasks-card").dispatchEvent("dblclick");
    const taskFlow = page.getByRole("dialog", { name: "Task flow" });
    await expect(taskFlow).toBeVisible({ timeout: 10_000 });
    await expect(taskFlow.getByTestId("task-board")).toBeVisible();
    await expect(taskFlow.getByText("Needs authorization", { exact: true })).toBeVisible();
    await shot(page, "06b-task-flow-kanban");
    await taskFlow.getByLabel("Open details for Clarify claim tick rules").click();
    await expect(
      taskFlow.getByRole("complementary", { name: "Details for Clarify claim tick rules" }),
    ).toBeVisible();
    await shot(page, "06c-task-flow-details");
    await taskFlow.getByRole("button", { name: "New task" }).click();
    const taskCreator = page.getByRole("dialog", { name: "Create task" });
    await expect(taskCreator).toBeVisible();
    await shot(page, "06d-task-flow-create");
    await taskCreator.getByRole("button", { name: "Close task creator" }).click();
    await expect(taskCreator).toBeHidden();
    await taskFlow.locator('button[title="Close"]').click();
    await expect(taskFlow).toBeHidden();

    // Requests and artifacts reuse the same master-detail grammar.
    const requestsNodeCard = page.locator('.react-flow__node[data-id="req1"]');
    await requestsNodeCard.getByTestId("requests-card").dispatchEvent("dblclick");
    const requestInbox = page.getByRole("dialog", { name: "Input requests" });
    await expect(requestInbox).toBeVisible();
    await expect(requestInbox.getByText("Confirm release signing identity", { exact: true }).first()).toBeVisible();
    await shot(page, "06e-input-requests");
    await requestInbox.locator('button[title="Close"]').click();
    await expect(requestInbox).toBeHidden();

    const artifactsNodeCard = page.locator('.react-flow__node[data-id="art1"]');
    await artifactsNodeCard.getByTestId("artifacts-card").dispatchEvent("dblclick");
    const artifactLibrary = page.getByRole("dialog", { name: "Artifacts" });
    await expect(artifactLibrary).toBeVisible();
    await expect(artifactLibrary.getByText("release-v1.4.2-sigstore.json", { exact: true }).first()).toBeVisible();
    await shot(page, "06f-artifact-library");
    await artifactLibrary.locator('button[title="Close"]').click();
    await expect(artifactLibrary).toBeHidden();

    // Edge label closeup.
    const edgeLabel = page.locator(".vellum-edge-label").first();
    if (await edgeLabel.isVisible().catch(() => false)) {
      await edgeLabel.screenshot({ path: join(SHOTS, "07-edge-label.png") });
    }

    // Select a note → toolbar + inspector.
    await page.locator(".react-flow__node", { hasText: "Field notes" }).first().click();
    await shot(page, "08-node-selected-inspector");

    // Expanded note editor (FocusSurface document panel).
    await page.getByRole("button", { name: "Expand note editor" }).click();
    const noteEditor = page.getByRole("dialog", { name: "Edit note" });
    await expect(noteEditor).toBeVisible({ timeout: 10_000 });
    await shot(page, "25-note-edit");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const pageNode = page.locator(".react-flow__node", { hasText: "jsoncanvas.org" }).first();
    await pageNode.dispatchEvent("click");
    await expect(page.getByLabel("Page browser host")).toBeVisible();
    await shot(page, "08b-page-host-inspector");

    // Chat: double-click the agent node to open its focused ACP work surface.
    await page.locator(".react-flow__node", { hasText: "builder" }).first().dblclick();
    await expect(page.locator(".chat-view")).toBeVisible({ timeout: 15_000 });
    await shot(page, "11-chat-detached");
    await page.getByRole("button", { name: "attach" }).click();
    const chat = page.locator(".chat-view");
    const composer = chat.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.fill("ship the design system");
    await chat.getByRole("button", { name: "send", exact: true }).click();
    await expect(page.locator(".chat-message--assistant")).toContainText("Design tokens", {
      timeout: 30_000,
    });
    await shot(page, "12-chat-conversation");
    await page.getByRole("button", { name: "Pin ACP chat" }).click();
    await expect(page.getByRole("complementary", { name: "Pinned work surface dock" })).toBeVisible();
    await shot(page, "12b-chat-pinned");
    await page.getByRole("button", { name: "Unpin ACP chat" }).click();
    await expect(page.getByRole("dialog", { name: /Workbench · chat/ })).toBeVisible();
    await page.getByRole("button", { name: "Close ACP chat" }).click();
    await page.waitForTimeout(300);

    // Herdr terminal modal: single click on the card hero (pointerdown opens
    // when the card is not selected).
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await page.waitForTimeout(600);
    const herdrNode = page.locator(".react-flow__node", {
      hasText: "audit herdr pane",
    });
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
    await page.getByText("Hosts", { exact: true }).click();
    await expect(page.getByText("Browser", { exact: true }).first()).toBeVisible();
    await shot(page, "13b-settings-hosts");
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

    // Usage HUD + popover.
    const hud = page.getByRole("button", {
      name: "Provider limits",
      exact: true,
    });
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
      const termWiz = page.getByRole("button", {
        name: "Add native terminal work surface",
      });
      if (await termWiz.isVisible().catch(() => false)) {
        await termWiz.click();
        await shot(page, "21-terminal-wizard");
        // FocusSurface-backed now — Escape closes.
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
      await addItem.click();
      const herdrWiz = page.getByRole("button", {
        name: "Add legacy herdr work surface",
      });
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
    await termNode.dblclick();
    const surface = page.locator(".native-terminal-surface");
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(surface.locator(".native-terminal-surface__status")).toContainText(/control|attaching/, {
      timeout: 30_000,
    });
    await page.waitForTimeout(900);
    await shot(page, "09-native-terminal-focus");
    await surface.getByRole("button", { name: "Pin" }).click();
    await page.waitForTimeout(700);
    await shot(page, "09b-native-terminal-pinned");
  } finally {
    await vellum.close();
  }
});

// Empty field — the boot state every operator sees on a fresh canvas.
test("capture the empty field state", async () => {
  const vellum = await launchVellum({
    seedCanvases: { empty: canvasDoc([]) },
  });
  try {
    const { page } = vellum;
    await mkdir(SHOTS, { recursive: true });
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await shot(page, "24-empty-field");
  } finally {
    await vellum.close();
  }
});

// Fleet manager — seed an enrolled fleet (local + four remotes, two with
// custom appearance) via VELLUM_HOSTS_PATH. With no key/seal beside it the
// registry bootstrap-admits the document. The fake ssh binary answers the
// reachability probes, so edges settle into the reachable state with latency.
test("capture the fleet manager overlay", async () => {
  const hostsDir = await mkdtemp(join(tmpdir(), "vellum-e2e-hosts-"));
  const hostsPath = join(hostsDir, "hosts.json");
  await writeFile(
    hostsPath,
    JSON.stringify({
      version: 1,
      hosts: [
        {
          id: "local",
          label: "local",
          kind: "local",
          capabilities: ["herdr", "hermes", "browser"],
        },
        {
          id: "mac-mini",
          label: "mac-mini",
          kind: "remote",
          endpoint: "mac-mini",
          capabilities: ["herdr", "hermes", "terminal"],
          hermesId: "remote-a",
        },
        {
          id: "forge-pi",
          label: "forge-pi",
          kind: "remote",
          endpoint: "forge-pi",
          capabilities: ["terminal"],
          appearance: { color: "#39C6D6", glyph: "remote-anchor" },
        },
        {
          id: "relay-1",
          label: "relay-1",
          kind: "remote",
          endpoint: "relay-1",
          capabilities: ["hermes", "browser"],
          appearance: { color: "#7F6DD6", glyph: "relay-obelisk" },
        },
        {
          id: "archive",
          label: "archive",
          kind: "remote",
          endpoint: "archive",
          capabilities: ["terminal", "browser"],
          appearance: { glyph: "artifact-vault" },
        },
      ],
    }),
    "utf8",
  );
  const vellum = await launchVellum({
    seedCanvases: { fleet: canvasDoc([]) },
    extraEnv: { VELLUM_HOSTS_PATH: hostsPath },
  });
  try {
    const { page } = vellum;
    await mkdir(SHOTS, { recursive: true });
    await expect(page.locator(".react-flow").first()).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Open fleet manager" }).click();
    const panel = page.locator(".fleet-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // Stations render from the seeded registry with a Command Core at center.
    await expect(page.locator(".fleet-station")).toHaveCount(4, {
      timeout: 15_000,
    });
    await expect(page.locator(".fleet-machine-object--ready")).toHaveCount(6, {
      timeout: 15_000,
    });
    // Dither fidelity is a live shader choice: pointer-up updates every object
    // without tearing down or reloading the model library.
    await page.getByRole("button", { name: "coarse" }).click();
    await expect(page.getByRole("button", { name: "coarse" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator(".fleet-machine-object--ready")).toHaveCount(6);
    await page.getByRole("button", { name: "fine" }).click();
    await expect(page.locator(".fleet-machine-object--ready")).toHaveCount(6);
    // Probes fire on open; in the sandbox they may still be in flight at
    // capture time — the frame asserts the fleet, not the probe outcome.
    await page.waitForTimeout(1500);
    await shot(page, "26-fleet-overlay");
    await page.locator(".fleet-station").first().click();
    await expect(page.locator(".fleet-station--selected")).toHaveCount(1);
    await expect(page.getByText("Automatic silhouette")).toBeVisible();
    const resolvedModel = page.locator(".fleet-detail__model-heading strong");
    await expect(resolvedModel).toHaveText("Mac mini");
    const macStudioChoice = page.getByRole("button", {
      name: "Use Mac Studio silhouette",
    });
    await macStudioChoice.click();
    await expect(page.getByText("Custom silhouette")).toBeVisible();
    await expect(resolvedModel).toHaveText("Mac Studio");
    await page
      .getByRole("button", { name: "Automatically choose station silhouette" })
      .click();
    await expect(page.getByText("Automatic silhouette")).toBeVisible();
    await expect(resolvedModel).toHaveText("Mac mini");
    await shot(page, "26b-fleet-station-focus");
    // When the sandbox sees an unclaimed peer, its detail panel shows what
    // the device is (OS, addresses, online state) + the claim action.
    const ghost = page.locator(".fleet-ghost").first();
    if ((await ghost.count()) > 0) {
      await ghost.click();
      const detail = page.locator(".fleet-detail");
      await expect(detail).toBeVisible({ timeout: 5_000 });
      await expect(detail.getByRole("button", { name: "Claim as station" })).toBeVisible();
      await shot(page, "27-fleet-ghost-detail");
    }
  } finally {
    await vellum.close();
  }
});
