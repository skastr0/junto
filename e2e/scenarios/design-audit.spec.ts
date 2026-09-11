/**
 * Design-audit capture — NOT a correctness spec. Drives every reachable UI
 * surface with seeded fixtures + the fake hermes binary and
 * screenshots each one to test-results/design-audit/ for visual review.
 *   VELLUM_COMMAND_FEATURE_PROFILE=all-on electron-vite build   # fleet/usage/help surfaces
 *   bun run test:e2e:fast e2e/scenarios/design-audit.spec.ts
 * A plain ship-profile build hides those surfaces and fails this spec.
 * The screenshots are the artifact; assertions only prove a surface appeared.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { UsageState } from "../../src/shared/usage";
import {
  agentTextNode,
  artifactsNode,
  canvasDoc,
  projectNode,
  requestsNode,
  worksEdge,
  tasksNode,
  terminalTextNode,
  textNode,
  taskItem,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";
import type {
  Artifact,
  CanvasEdge,
  CanvasNode,
  GroupNode,
  LinkNode,
  Task,
} from "../../src/shared/canvas";

const SHOTS = join(process.cwd(), "test-results", "design-audit");

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

const noteNode: CanvasNode = {
  id: "note1",
  type: "text",
  text: "# Field notes\n\nThe **digest** stays deterministic.\n\n– relates edges are quiet\n– blockers paint crimson\n\n> agents read compiled projections\n\n`bun run digest`",
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

const boardNode: CanvasNode = {
  id: "board1",
  type: "text",
  text: "factory bulletin",
  x: 780,
  y: 620,
  width: 240,
  height: 120,
  ether: {
    entity: { kind: "board" },
    board: { topics: [] },
  },
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
  // Keep this interactive page card outside the held-region overlay so its
  // kind fields remain reachable in the visual audit.
  x: 920,
  y: 0,
  width: 240,
  height: 90,
  ether: {
    entity: { kind: "page" },
    host: "local",
    browser: { profile: "personal" },
  },
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
  argv: [
    "/bin/sh",
    "-c",
    "printf 'audit-terminal-ready\\r\\n'; exec sleep 3600",
  ],
};

const auditTask = (
  id: string,
  brief: string,
  state: Task["state"],
  claimedBy?: string,
  update?: string,
): Task => {
  const task = taskItem(id, brief, state);
  return {
    ...task,
    ...(claimedBy
      ? {
          metadata: {
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
      auditTask("t-2", "Fix stale host badge", "submitted"),
      auditTask(
        "t-3",
        "Clarify claim tick rules",
        "input-required",
        "remote-a:profile-06",
        "Which connected agent should take this next?",
      ),
      auditTask(
        "t-4",
        "Enable remote session capture",
        "submitted",
        undefined,
        "Confirm scope before opening the remote capability.",
      ),
      auditTask(
        "t-5",
        "Rotate service key material",
        "completed",
        "remote-a:profile-06",
      ),
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
        ...taskItem(
          "r-1",
          "Confirm release signing identity",
          "input-required",
        ),
        metadata: {
          title: "Confirm release signing identity",
          details:
            "Verify which signing identity should be used before the release artifact is distributed to remote stations.",
        },
        history: [
          ...taskItem(
            "r-1",
            "Confirm release signing identity",
            "input-required",
          ).history,
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
          details:
            "Select the duration for preserving completed task telemetry.",
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
        task: {
          kind: "task",
          itemId: "t-3",
          sink: { canvasName: "design-audit", nodeId: "tasks1" },
        },
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
        parts: [
          {
            kind: "text",
            text: "No capability escaped the connected task edge.",
          },
        ],
      },
    ] satisfies Artifact[],
  }),
  boardNode,
  terminalTextNode({
    id: "term1",
    bindingId: "audit-term-binding",
    label: "audit native term",
    launch: LAUNCH,
    x: 940,
    y: 460,
  }),
];

const edges: CanvasEdge[] = [
  worksEdge("e1", "tasks1", "agent1"),
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
  },
  { id: "e4", fromNode: "agent1", toNode: "req1" },
  { id: "e5", fromNode: "agent1", toNode: "art1" },
  { id: "e6", fromNode: "agent1", toNode: "board1" },
];

test("capture every surface for design review", async () => {
  // This audit drives ~30 surfaces plus seeded live planes; it runs long
  // enough to need a budget above the default 90s worker timeout.
  test.setTimeout(300_000);
  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-audit-"));
  await mkdir(SHOTS, { recursive: true });

  // Usage rail paint: seeded through the durable `usage_state` seam so the
  // audit still captures frames 18/19 against native sources.
  const auditUsage: UsageState = {
    snapshots: [
      {
        source: "codex",
        fetchedAt: new Date().toISOString(),
        ok: true,
        dataConfidence: "stale-cache",
        quotas: [
          {
            provider: "codex",
            source: "oauth",
            status: "ok",
            updatedAt: new Date().toISOString(),
            windows: [{ label: "primary", usedPercent: 42, windowMinutes: 300 }],
          },
        ],
      },
      {
        source: "claude",
        fetchedAt: new Date().toISOString(),
        ok: true,
        dataConfidence: "stale-cache",
        quotas: [
          {
            provider: "claude",
            source: "oauth",
            status: "ok",
            updatedAt: new Date().toISOString(),
            windows: [{ label: "primary", usedPercent: 18, windowMinutes: 300 }],
          },
        ],
      },
    ],
    lastLiveAt: new Date().toISOString(),
  };

  const vellumCommand = await launchVellum({
    // Seed before Electron owns the StateEngine. The harness splits work
    // projections into WorkRepository rows; writing this fixture through the
    // canvas API after startup would intentionally discard its task/request/
    // artifact items as authored-document data.
    seedCanvases: { "design-audit": canvasDoc(nodes, edges) },
    seedUsage: auditUsage,
    extraEnv: {
    },
  });

  try {
    const { page } = vellumCommand;

    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

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

    // Command bar: default catalog, then a filtered list.
    await page.locator(".station-command-trigger").click();
    await expect(page.getByTestId("command-bar-input")).toBeVisible();
    await shot(page, "01b-command-bar-open");
    await page.getByTestId("command-bar-input").fill("task");
    await shot(page, "01c-command-bar-filtered");
    await page.getByTestId("command-bar-input").fill(">");
    await shot(page, "01d-command-bar-actions");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-bar-input")).toHaveCount(0);

    // Node closeups.
    const closeup = async (hasText: string, name: string) => {
      const el = page.locator(".react-flow__node", { hasText }).first();
      await el.scrollIntoViewIfNeeded();
      await el.screenshot({ path: join(SHOTS, `${name}.png`) });
    };
    await closeup("Field notes", "02-node-note");
    await closeup("release checklist", "03-node-blocker");
    await closeup("audit native term", "05-node-terminal-card");

    // The dock obscures the lower part of the canvas. Use the field's middle-
    // button pan gesture to bring the task row above it before capturing.
    const pane = page.locator(".react-flow__pane");
    const paneBox = await pane.boundingBox();
    if (!paneBox)
      throw new Error("Canvas pane is unavailable for task-row capture");
    const panX = paneBox.x + paneBox.width * 0.5;
    const panStartY = paneBox.y + paneBox.height * 0.7;
    await page.mouse.move(panX, panStartY);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(panX, paneBox.y + paneBox.height * 0.25, {
      steps: 8,
    });
    await page.mouse.up({ button: "middle" });

    const tasksNodeCard = page.locator('.react-flow__node[data-id="tasks1"]');
    await expect(tasksNodeCard).toBeVisible({ timeout: 15_000 });
    await tasksNodeCard.getByTestId("tasks-card").click({ trial: true });
    await tasksNodeCard.screenshot({ path: join(SHOTS, "06-node-tasks.png") });

    // Task board: attention + terminal variants. Double-click is the work-surface
    // affordance on canvas nodes.
    await tasksNodeCard.getByTestId("tasks-card").dispatchEvent("dblclick");
    const taskBoard = page.getByRole("dialog", { name: "Task board" });
    await expect(taskBoard).toBeVisible({ timeout: 10_000 });
    await expect(taskBoard.getByTestId("task-board")).toBeVisible();
    await expect(
      taskBoard.getByText("Needs input", { exact: true }),
    ).toBeVisible();
    await shot(page, "06b-task-board-kanban");
    await taskBoard
      .getByLabel("Open details for Clarify claim tick rules")
      .click();
    await expect(
      taskBoard.getByRole("complementary", {
        name: "Details for Clarify claim tick rules",
      }),
    ).toBeVisible();
    await shot(page, "06c-task-board-details");
    await taskBoard.getByTestId("task-board-enqueue").click();
    const taskCreator = page.getByRole("dialog", { name: "Create task" });
    await expect(taskCreator).toBeVisible();
    await shot(page, "06d-task-board-create");
    await taskCreator
      .getByRole("button", { name: "Close task creator" })
      .click();
    await expect(taskCreator).toBeHidden();
    await taskBoard.getByRole("button", { name: "Close task board", exact: true }).click();
    await expect(taskBoard).toBeHidden();

    // Requests and artifacts reuse the same master-detail grammar.
    const requestsNodeCard = page.locator('.react-flow__node[data-id="req1"]');
    await requestsNodeCard
      .getByTestId("requests-card")
      .dispatchEvent("dblclick");
    const requestInbox = page.getByRole("dialog", { name: "Input requests" });
    await expect(requestInbox).toBeVisible();
    await expect(
      requestInbox
        .getByText("Confirm release signing identity", { exact: true })
        .first(),
    ).toBeVisible();
    await shot(page, "06e-input-requests");
    await requestInbox.getByRole("button", { name: "Close input requests", exact: true }).click();
    await expect(requestInbox).toBeHidden();

    const artifactsNodeCard = page.locator('.react-flow__node[data-id="art1"]');
    await artifactsNodeCard
      .getByTestId("artifacts-card")
      .dispatchEvent("dblclick");
    const artifactLibrary = page.getByRole("dialog", { name: "Artifacts" });
    await expect(artifactLibrary).toBeVisible();
    await expect(
      artifactLibrary
        .getByText("release-v1.4.2-sigstore.json", { exact: true })
        .first(),
    ).toBeVisible();
    await shot(page, "06f-artifact-library");
    await artifactLibrary.getByRole("button", { name: "Close artifacts", exact: true }).click();
    await expect(artifactLibrary).toBeHidden();

    // Return to the overview before continuing with the upper-canvas cards.
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await page.waitForTimeout(600);

    // Edge midpoint targets are intentionally invisible and covered by the
    // wire's pointer path. Use their keyboard affordance, then capture the
    // current Relation controls in the RTS bar.
    await page.getByRole("button", { name: /^Select edge -/ }).first().press("Enter");
    await expect(page.getByRole("toolbar", { name: "Relation actions" })).toBeVisible();
    await shot(page, "07-edge-inspector");

    // Select a note → toolbar + inspector.
    await page
      .locator(".react-flow__node", { hasText: "Field notes" })
      .first()
      .click();
    await shot(page, "08-node-selected-inspector");

    // Expanded note editor (FocusSurface document panel).
    await page.getByRole("button", { name: "Expand note editor" }).click();
    const noteEditor = page.getByRole("dialog", { name: "Edit note" });
    await expect(noteEditor).toBeVisible({ timeout: 10_000 });
    await shot(page, "25-note-edit");
    await noteEditor.getByRole("button", { name: "Pin note editor" }).click();
    const pinnedNote = page.getByTestId("note-workbench-surface");
    await expect(pinnedNote).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Pinned work surface dock" })).toBeVisible();
    await pinnedNote.getByRole("button", { name: "Unpin note editor" }).click();
    await expect(noteEditor).toBeVisible();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const pageNode = page
      .locator(".react-flow__node", { hasText: "jsoncanvas.org" })
      .first();
    // PageCard's main action attaches the browser surface. Select its blank
    // chrome instead; page kinds no longer expose a fields sheet
    // (showFieldsKey excludes "page"), so capture the selected kind strip.
    await pageNode.click({ position: { x: 120, y: 5 }, force: true });
    await shot(page, "08b-page-kind-strip");

    // ACP chat is intentionally retired; agent seats use managed terminals.
    // The terminal focus capture below covers the remaining live-seat surface.

    // Settings panel. The Hosts section was retired; Browser is the
    // deepest product section in an all-on build.
    await page.getByRole("button", { name: "Open settings" }).click();
    await shot(page, "13-settings");
    await page.locator(".settings-nav__item", { hasText: "Browser" }).click();
    await expect(
      page.getByRole("heading", { name: "Browser", exact: true }),
    ).toBeVisible();
    await shot(page, "13b-settings-browser");
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
      const deck = page.getByRole("region", { name: "Add canvas item" });
      await expect(deck).toBeVisible();
      await shot(page, "20-node-palette");
      const claudeAgent = deck.getByRole("button", {
        name: "Add Claude Code agent",
      });
      if (await claudeAgent.isVisible().catch(() => false)) {
        await claudeAgent.hover();
        const models = page.getByRole("menu", { name: "Claude Code models" });
        await models.waitFor({ state: "visible" });
        await shot(page, "20b-agent-cascade");
        const launchContext = deck.getByRole("region", {
          name: "Launch context",
        });
        await launchContext
          .getByRole("button", { name: "Choose starting folder" })
          .click();
        const folder = page.getByRole("dialog", {
          name: "Choose starting folder",
        });
        await expect(folder).toBeVisible();
        await expect(folder.getByLabel("Agent working directory")).toHaveValue(
          /^\//,
          { timeout: 10_000 },
        );
        await expect(
          folder.getByRole("checkbox", {
            name: /use this folder as region default for this host/i,
          }),
        ).toBeVisible();
        await shot(page, "20c-agent-folder");
        await folder
          .getByRole("button", { name: "Close folder picker" })
          .click();
        // The hover-opened cascade overlays the catalog and intercepts card
        // clicks. Move to neutral deck chrome so closeCascadeSoon retires it.
        await deck.getByLabel("Search nodes and agents").hover();
        await models.waitFor({ state: "hidden" });
      }
      const termWiz = deck.getByRole("button", {
        name: /Terminal/,
      });
      if (await termWiz.isVisible().catch(() => false)) {
        await termWiz.click();
        await shot(page, "21-terminal-wizard");
        // FocusSurface-backed now — Escape closes.
        await page.keyboard.press("Escape");
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
    await expect(
      surface.locator(".native-terminal-surface__status"),
    ).toContainText(/control|attaching/, {
      timeout: 30_000,
    });
    await page.waitForTimeout(900);
    await shot(page, "09-native-terminal-focus");
    await surface.getByRole("button", { name: "Pin" }).click();
    await page.waitForTimeout(700);
    await shot(page, "09b-native-terminal-pinned");
  } finally {
    await vellumCommand.close();
  }
});

test("capture Board empty and populated states", async () => {
  const vellumCommand = await launchVellum({
    seedCanvases: { "board-audit": canvasDoc([boardNode]) },
  });
  try {
    const { page } = vellumCommand;
    await mkdir(SHOTS, { recursive: true });
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const boardNodeCard = page.locator('.react-flow__node[data-id="board1"]');
    await expect(boardNodeCard).toBeVisible({ timeout: 15_000 });
    await boardNodeCard.getByTestId("board-card").dispatchEvent("dblclick");

    const bulletinBoard = page.getByRole("dialog", { name: "Bulletin board" });
    await expect(bulletinBoard).toBeVisible();
    await shot(page, "06g-board-empty");

    const createTopic = async (topicTitle: string, openingNote: string) => {
      await bulletinBoard.getByRole("button", { name: "New topic" }).first().click();
      await bulletinBoard.getByPlaceholder("New topic title").fill(topicTitle);
      await bulletinBoard
        .getByPlaceholder("Opening note (optional)")
        .fill(openingNote);
      await bulletinBoard.getByRole("button", { name: "Create topic" }).click();
      await expect(
        bulletinBoard.getByText(topicTitle, { exact: true }).first(),
      ).toBeVisible();
    };

    await createTopic(
      "Release readiness - August 3",
      "Capture blockers, proof receipts, and operator decisions for the next signed build.",
    );
    await bulletinBoard
      .getByPlaceholder("Write a reply…")
      .fill(
        "Notarization is green. Waiting on the two-host Station smoke before promotion.",
      );
    await bulletinBoard
      .getByRole("button", { name: "Post reply", exact: true })
      .click();
    await expect(
      bulletinBoard.getByRole("main").getByText(/two-host Station smoke/i),
    ).toBeVisible();
    await createTopic(
      "Remote station smoke",
      "Mac mini is enrolled. Validate reconnect, offline work, and exact protocol negotiation.",
    );
    await createTopic(
      "Board redesign notes",
      "Keep operator broadcasts distinct from agent-authored discussion and quiet by default.",
    );

    await shot(page, "06h-board-populated");
    await bulletinBoard
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(bulletinBoard).toBeHidden();
  } finally {
    await vellumCommand.close();
  }
});

// Empty field — the boot state every operator sees on a fresh canvas.
test("capture the empty field state", async () => {
  const vellumCommand = await launchVellum({
    seedCanvases: { empty: canvasDoc([]) },
  });
  try {
    const { page } = vellumCommand;
    await mkdir(SHOTS, { recursive: true });
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await shot(page, "24-empty-field");
  } finally {
    await vellumCommand.close();
  }
});

// Fleet manager — seed an enrolled fleet (local + four remotes, two with
// custom appearance) into the sandbox's SQLite database. The fake ssh binary
// answers reachability probes, so edges settle into reachable state.
test("capture the fleet manager overlay", async () => {
  const vellumCommand = await launchVellum({
    seedCanvases: { fleet: canvasDoc([]) },
    seedHosts: [
      {
        id: "local",
        label: "local",
        kind: "local",
        capabilities: ["hermes", "browser"],
      },
      {
        id: "mac-mini",
        label: "mac-mini",
        kind: "remote",
        sshEndpoint: "remote-a",
        capabilities: ["hermes", "terminal"],
        hermesId: "remote-a",
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
    const { page } = vellumCommand;
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
    await expect(page.locator(".fleet-machine__icon")).toHaveCount(6, {
      timeout: 15_000,
    });
    // Probes fire on open; in the sandbox they may still be in flight at
    // capture time — the frame asserts the fleet, not the probe outcome.
    await page.waitForTimeout(1500);
    await shot(page, "26-fleet-overlay");
    await page.locator(".fleet-station").first().click();
    await expect(page.locator(".fleet-station--selected")).toHaveCount(1);
    await expect(page.getByText("Automatic icon")).toBeVisible();
    const resolvedModel = page.locator(".fleet-detail__model-heading strong");
    await expect(resolvedModel).toHaveText("Mac mini");
    const macStudioChoice = page.getByRole("button", {
      name: "Use Mac Studio icon",
    });
    await macStudioChoice.click();
    await expect(page.getByText("Custom icon")).toBeVisible();
    await expect(resolvedModel).toHaveText("Mac Studio");
    await page
      .getByRole("button", { name: "Automatically choose machine icon" })
      .click();
    await expect(page.getByText("Automatic icon")).toBeVisible();
    await expect(resolvedModel).toHaveText("Mac mini");
    await shot(page, "26b-fleet-station-focus");
    // When the sandbox sees an unclaimed peer, its detail panel shows what
    // the device is (OS, addresses, online state) + the claim action.
    const ghost = page.locator(".fleet-ghost").first();
    if ((await ghost.count()) > 0) {
      await ghost.click();
      const detail = page.locator(".fleet-detail");
      await expect(detail).toBeVisible({ timeout: 5_000 });
      await expect(
        detail.getByRole("button", { name: "Enroll this machine" }),
      ).toBeVisible();
      await shot(page, "27-fleet-ghost-detail");
    }
  } finally {
    await vellumCommand.close();
  }
});
