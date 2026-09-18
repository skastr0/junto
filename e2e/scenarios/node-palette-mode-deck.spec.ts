import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { GroupNode } from "../../src/shared/canvas";
import type { HarnessId } from "../../src/shared/managed-terminal-templates";
import type { ClaudeModelCacheEntry } from "../harness/agent-harness-fixture";
import { canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const REPO_ROOT = process.cwd();

const SEEDED_HARNESSES = ["claude", "codex", "grok"] as const satisfies readonly HarnessId[];

const CLAUDE_MODELS: readonly ClaudeModelCacheEntry[] = [
  { value: "claude-opus-4-6", label: "Opus 4.6" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
  { value: "claude-opus-4-5", label: "Opus 4.5" },
  { value: "claude-sonnet-4-5", label: "Sonnet 4.5" },
  { value: "claude-opus-4-1", label: "Opus 4.1" },
  { value: "claude-sonnet-4", label: "Sonnet 4" },
  { value: "claude-haiku-3-5", label: "Haiku 3.5" },
  { value: "claude-opus-3", label: "Opus 3" },
  { value: "claude-sonnet-3-7", label: "Sonnet 3.7" },
  { value: "claude-haiku-3", label: "Haiku 3" },
  { value: "claude-opus-4-0", label: "Opus 4.0" },
  { value: "claude-sonnet-3-5", label: "Sonnet 3.5" },
  { value: "claude-opus-4-7", label: "Opus 4.7" },
  { value: "claude-zephyr-1", label: "Zephyr 1" },
];

const seededLaunch = (
  extras: Parameters<typeof launchJunto>[0] = {},
) =>
  launchJunto({
    seedHarnessInstalls: SEEDED_HARNESSES,
    claudeModelCache: CLAUDE_MODELS,
    ...extras,
  });

const containingRegion: GroupNode = {
  id: "launch-region",
  type: "group",
  label: "Launch zone",
  x: -600,
  y: -500,
  width: 2_000,
  height: 1_400,
  ether: { region: { hold: false } },
};

const openModeDeck = async (page: Page): Promise<Locator> => {
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Add canvas item" }).click();

  const modal = page.getByRole("dialog", { name: "Add canvas item" });
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute("aria-modal", "true");
  const panel = modal.locator(".focus-surface__panel--workspace");
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(Math.abs(panelBox!.x + panelBox!.width / 2 - viewportWidth / 2))
    .toBeLessThanOrEqual(4);

  const search = page.getByRole("searchbox", {
    name: "Search nodes and agents",
  });
  await expect(search).toBeVisible();

  const deck = modal.getByRole("region", { name: "Add canvas item" });
  await expect(deck).toBeVisible();
  return deck;
};

const openFolderPicker = async (
  page: Page,
  deck: Locator,
): Promise<Locator> => {
  const launchContext = deck.getByRole("region", { name: "Launch context" });
  await expect(launchContext.getByLabel("Agent host")).toBeVisible();
  await launchContext
    .getByRole("button", { name: "Choose starting folder" })
    .click();

  const picker = page.getByRole("dialog", { name: "Choose starting folder" });
  await expect(picker).toBeVisible();
  // The picker reads its seed path on mount and rewrites the input when that
  // read lands. Typing before it settles appends to the rewritten value
  // instead of replacing it — `fill` selects all, the rewrite collapses the
  // selection, and the insert lands at the end of a home-joined path. Wait for
  // the first read to settle (a listing, or the read error) before typing.
  await expect(
    picker.locator("ul, [role='alert']").first(),
  ).toBeVisible({ timeout: 10_000 });
  return picker;
};

/**
 * Give the next agent a working directory. A managed agent seat must name one —
 * main refuses a seat whose cwd would fall back to the operator home — so the
 * deck opens this picker instead of creating a seat that cannot start.
 */
const chooseWorkingDirectory = async (
  page: Page,
  deck: Locator,
  folder = "src",
): Promise<void> => {
  const picker = await openFolderPicker(page, deck);
  const input = picker.getByLabel("Agent working directory");
  await input.fill(`${REPO_ROOT}/`);
  const listing = picker.getByRole("list", {
    name: `Folders in ${REPO_ROOT}`,
  });
  await expect(listing).toBeVisible({ timeout: 10_000 });
  await listing.getByRole("button", { name: `Select ${folder}` }).click();
  await expect(input).toHaveValue(join(REPO_ROOT, folder));
  await picker
    .getByRole("button", { name: "Close folder picker" })
    .click();
};

test("Mode Deck exposes the searchable catalog and keeps launch context dense at the foot of the agent pane", async () => {
  const junto = await seededLaunch();

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);

    for (const category of ["All", "Shell"]) {
      await expect(deck.getByRole("tab", { name: category, exact: true }))
        .toBeVisible();
    }

    await deck.getByRole("tab", { name: "Shell", exact: true }).click();
    await expect(
      deck.getByRole("button", { name: /terminal/i }),
    ).toBeVisible();

    await deck.getByRole("tab", { name: "Schedule", exact: true }).click();
    // Gauge (hermes stat_threshold) is palette-hidden — cron and relay are
    // the product scheduler peers.
    for (const scheduler of ["Cron", "Relay"]) {
      await expect(
        deck.locator(".node-deck-catalog__card").filter({ hasText: scheduler }),
      ).toBeVisible();
    }
    await expect(
      deck.locator(".node-deck-catalog__card").filter({ hasText: "Gauge" }),
    ).toHaveCount(0);

    const agentPane = deck.locator('aside[aria-label="Agents"]');
    const launchContext = agentPane.getByRole("region", {
      name: "Launch context",
    });
    const agentRows = [
      agentPane.getByRole("button", { name: "Claude Code", exact: true }),
      agentPane.getByRole("button", { name: "Codex", exact: true }),
      agentPane.getByRole("button", { name: "Grok", exact: true }),
      agentPane.getByRole("button", { name: "Hermes", exact: true }),
    ];

    await expect(launchContext.getByLabel("Agent host")).toBeVisible();
    await expect(
      launchContext
        .getByRole("button", { name: "Choose starting folder" }),
    ).toBeVisible();

    for (const row of agentRows) {
      await expect(row).toBeVisible();
      await expect(row.locator("svg.lucide-plus")).toHaveCount(0);
      await expect(row.getByRole("button")).toHaveCount(0);
      await expect(row).not.toContainText("template defaults");
    }

    const wiring = agentPane.getByRole("region", {
      name: "Agent connection summary",
    });
    await expect(wiring).toContainText("Tasks");
    await expect(wiring).toContainText("claims and completes work");
    await expect(wiring).toContainText("Requests and Artifacts");

    const lastAgentBox = await agentRows.at(-1)!.boundingBox();
    const wiringBox = await wiring.boundingBox();
    const launchBox = await launchContext.boundingBox();
    expect(lastAgentBox).not.toBeNull();
    expect(wiringBox).not.toBeNull();
    expect(launchBox).not.toBeNull();
    // The agent list absorbs leftover column height (free space lives inside
    // its scroll region), so wiring sits at the pane foot — below the last
    // row but not necessarily adjacent. The launch context must stay dense
    // under the wiring.
    expect(wiringBox!.y).toBeGreaterThanOrEqual(
      lastAgentBox!.y + lastAgentBox!.height,
    );
    expect(launchBox!.y).toBeGreaterThanOrEqual(
      wiringBox!.y + wiringBox!.height,
    );
    expect(
      launchBox!.y - (wiringBox!.y + wiringBox!.height),
    ).toBeLessThanOrEqual(24);
  } finally {
    await junto.close();
  }
});

test("model and effort choices remain visually attached to the active agent row", async () => {
  const junto = await seededLaunch();

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const agent = deck.getByRole("button", { name: "Claude Code", exact: true });
    await agent.hover();

    const models = page.getByRole("menu", { name: "Claude Code models" });
    await expect(models).toBeVisible();
    const model = models.getByRole("menuitem").first();
    await model.hover();
    await expect(model).toHaveCSS("box-shadow", "none");
    const modelBorders = await model.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        top: style.borderTopWidth,
        right: style.borderRightWidth,
        bottom: style.borderBottomWidth,
        left: style.borderLeftWidth,
      };
    });
    expect(modelBorders).toEqual({
      top: "1px",
      right: "1px",
      bottom: "1px",
      left: "1px",
    });

    const efforts = page.getByRole("menu", { name: /effort$/ });
    await expect(efforts).toBeVisible();

    const [agentBox, modelBox, effortBox] = await Promise.all([
      agent.boundingBox(),
      models.boundingBox(),
      efforts.boundingBox(),
    ]);
    expect(agentBox).not.toBeNull();
    expect(modelBox).not.toBeNull();
    expect(effortBox).not.toBeNull();

    const horizontalGap = (
      left: NonNullable<typeof agentBox>,
      right: NonNullable<typeof agentBox>,
    ): number =>
      Math.max(
        0,
        Math.max(left.x, right.x) -
          Math.min(left.x + left.width, right.x + right.width),
      );
    const verticallyOverlaps = (
      first: NonNullable<typeof agentBox>,
      second: NonNullable<typeof agentBox>,
    ): boolean =>
      Math.min(first.y + first.height, second.y + second.height) >
      Math.max(first.y, second.y);

    expect(horizontalGap(agentBox!, modelBox!)).toBeLessThanOrEqual(24);
    expect(horizontalGap(modelBox!, effortBox!)).toBeLessThanOrEqual(24);
    expect(verticallyOverlaps(agentBox!, modelBox!)).toBe(true);
  } finally {
    await junto.close();
  }
});

test("starting-folder modal reuses live directory browsing and can save a containing-region default", async () => {
  const junto = await seededLaunch({
    seedCanvases: { portfolio: canvasDoc([containingRegion]) },
  });

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const picker = await openFolderPicker(page, deck);
    const input = picker.getByLabel("Agent working directory");

    await input.fill(`${REPO_ROOT}/`);
    const listing = picker.getByRole("list", {
      name: `Folders in ${REPO_ROOT}`,
    });
    await expect(listing).toBeVisible({ timeout: 10_000 });
    await expect(
      listing.getByRole("button", { name: "Select src" }),
    ).toBeVisible();
    await expect(
      listing.getByRole("button", { name: "Select tests" }),
    ).toBeVisible();

    await listing.getByRole("button", { name: "Select src" }).click();
    await expect(input).toHaveValue(join(REPO_ROOT, "src"));

    const regionDefault = picker.getByRole("checkbox", {
      name: /use this folder as region default for (?:this )?host/i,
    });
    await expect(regionDefault).toBeEnabled();
    await regionDefault.check({ force: true });
  } finally {
    await junto.close();
  }
});

test("region-default promotion fails closed with actionable guidance outside a region", async () => {
  const junto = await seededLaunch({
    seedCanvases: { portfolio: canvasDoc([]) },
  });

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const picker = await openFolderPicker(page, deck);
    const regionDefault = picker.getByRole("checkbox", {
      name: /use this folder as region default for (?:this )?host/i,
    });

    await expect(regionDefault).toBeDisabled();
    await expect(picker).toContainText(
      /add a region to set up defaults and shared context/i,
    );
  } finally {
    await junto.close();
  }
});

test("one agent-row click creates exactly one configured agent without a legacy location step", async () => {
  const junto = await seededLaunch({
    seedCanvases: { portfolio: canvasDoc([]) },
  });

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const picker = await openFolderPicker(page, deck);
    const input = picker.getByLabel("Agent working directory");

    await input.fill(`${REPO_ROOT}/`);
    const listing = picker.getByRole("list", {
      name: `Folders in ${REPO_ROOT}`,
    });
    await expect(listing).toBeVisible({ timeout: 10_000 });
    await listing.getByRole("button", { name: "Select src" }).click();
    await expect(input).toHaveValue(join(REPO_ROOT, "src"));
    await picker
      .getByRole("button", { name: "Close folder picker" })
      .click();

    const canvasNodes = page.locator(".react-flow__node");
    const before = await canvasNodes.count();
    await deck.getByRole("button", { name: "Claude Code", exact: true }).click();

    await expect(deck).toHaveCount(0);
    await expect(canvasNodes).toHaveCount(before + 1);
    await expect(
      page.locator(".react-flow__node", { hasText: "Claude Code" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("dialog", { name: /agent location/i }),
    ).toHaveCount(0);

    await expect.poll(async () => {
      return page.evaluate(async () => {
        const canvases = await window.junto!.listCanvases();
        const name = canvases[0]?.name;
        if (!name) return [];
        const read = await window.junto!.readCanvas(name);
        return read.doc.nodes
          .filter((node) => node.ether?.entity?.kind === "agent")
          .map((node) => ({
            harness: node.ether?.terminal?.harness,
            cwd: node.ether?.terminal?.launch?.cwd,
          }));
      });
    }).toEqual([{ harness: "claude", cwd: join(REPO_ROOT, "src") }]);
  } finally {
    await junto.close();
  }
});

test("a create attempt with no working directory opens the folder picker instead of minting a seat", async () => {
  const junto = await seededLaunch({
    seedCanvases: { portfolio: canvasDoc([]) },
    seedHarnessInstalls: [...SEEDED_HARNESSES, "kimi"],
  });

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const canvasNodes = page.locator(".react-flow__node");
    const before = await canvasNodes.count();

    // Kimi offers a single "Use harness defaults" row, so one activation
    // reaches the create step with no model choice in the way.
    const kimi = deck.getByRole("button", { name: "Kimi Code", exact: true });
    await kimi.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Kimi Code models" });
    await menu
      .getByRole("menuitem", { name: "Use harness defaults" })
      .press("Enter");

    // A managed agent seat must name a working directory, so the create
    // attempt answers with the picker and the deck stays open on no new node.
    await expect(
      page.getByRole("dialog", { name: "Choose starting folder" }),
    ).toBeVisible();
    await expect(deck).toHaveCount(1);
    await expect(canvasNodes).toHaveCount(before);
  } finally {
    await junto.close();
  }
});

test("node detail rail preserves navigation while explaining primary and secondary connections", async () => {
  const junto = await seededLaunch();

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const terminal = deck.locator(".node-deck-catalog__card").filter({
      hasText: "Terminal",
    });
    await terminal.hover();
    await expect(terminal.locator(".node-deck-catalog__label"))
      .toHaveCSS("text-transform", "none");

    const detail = deck.getByRole("complementary", {
      name: "Terminal details",
    });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(/shell on the selected machine/i);
    await expect(detail.locator(".node-deck-catalog__detail-copy strong"))
      .toHaveCSS("text-transform", "none");
    const wireMap = detail.locator(".node-deck-catalog__wires");
    await expect(wireMap).not.toHaveCount(0);
    await expect(wireMap).toHaveCSS("text-transform", "none");
    await expect(wireMap).toContainText("No wires — open it and work by hand.");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(deck).not.toContainText(/inspect - click to add/i);

    const tasks = deck.locator(".node-deck-catalog__card").filter({
      hasText: "Tasks",
    });
    const terminalBox = await terminal.boundingBox();
    await tasks.focus();
    const tasksBox = await tasks.boundingBox();
    expect(terminalBox).not.toBeNull();
    expect(tasksBox).not.toBeNull();
    expect(tasksBox!.height).toBeLessThanOrEqual(84);

    const taskDetail = deck.getByRole("complementary", {
      name: "Tasks details",
    });
    await expect(taskDetail).toBeVisible();
    // Wire explainer: one access line (agent ports) + watch/effect lines.
    await expect(taskDetail).toContainText("Agents can:");
    await expect(taskDetail).toContainText("Claim tasks");
    await expect(taskDetail).toContainText("A relay can watch:");
    await expect(taskDetail).toContainText("Cron and relay can:");
    await expect(
      taskDetail.locator(".node-deck-catalog__wire-family").filter({ hasText: "access" }),
    ).toHaveCount(1);
    await expect(taskDetail.locator(".node-deck-catalog__wire-family")).not.toHaveCount(0);

    const wires = taskDetail.locator(".node-deck-catalog__wires");
    await expect(wires).toBeVisible();
    await expect(wires.locator("img")).toHaveCount(0);
  } finally {
    await junto.close();
  }
});

const searchBox = (page: Page) =>
  page.getByRole("searchbox", { name: "Search nodes and agents" });

const agentSeats = async (page: Page) =>
  page.evaluate(async () => {
    const canvases = await window.junto!.listCanvases();
    const name = canvases[0]?.name;
    if (!name) return [];
    const read = await window.junto!.readCanvas(name);
    return read.doc.nodes
      .filter((node) => node.ether?.entity?.kind === "agent")
      .map((node) => {
        const argv = node.ether?.terminal?.launch?.argv ?? [];
        const modelAt = argv.indexOf("--model");
        const effortAt = argv.indexOf("--effort");
        return {
          harness: node.ether?.terminal?.harness,
          model: modelAt >= 0 ? argv[modelAt + 1] : undefined,
          effort: effortAt >= 0 ? argv[effortAt + 1] : undefined,
        };
      });
  });

const waitForClaudeModels = async (page: Page): Promise<Locator> => {
  const models = page.getByRole("menu", { name: "Claude Code models" });
  await expect(models.getByRole("menuitem", { name: "Opus 4.6", exact: true }))
    .toBeVisible();
  return models;
};

const cascadeEnterKey = async (menu: Locator): Promise<"ArrowRight" | "ArrowLeft"> => {
  const direction = await menu.evaluate((element) => {
    const root = element.closest(".agent-cascade");
    return root ? getComputedStyle(root).flexDirection : "row";
  });
  return direction === "row-reverse" ? "ArrowLeft" : "ArrowRight";
};

test("fuzzy agent search ranks installed harnesses and reports an honest miss", async () => {
  const junto = await seededLaunch();

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const claude = deck.getByRole("button", { name: "Claude Code", exact: true });
    await expect(claude).toBeVisible();

    const search = searchBox(page);
    for (const query of ["cc", "claudec", "code claude"]) {
      await search.fill(query);
      await expect(claude).toBeVisible();
      const first = deck.locator(".agent-harness-pick__item").first();
      await expect(first).toHaveAttribute("aria-label", "Claude Code");
    }

    await search.fill("zzzz-not-an-agent");
    await expect(deck.locator(".agent-harness-pick__empty")).toContainText(
      'No agents match "zzzz-not-an-agent".',
    );
    await expect(deck).not.toContainText(
      "No installed agent CLIs found on this machine.",
    );
  } finally {
    await junto.close();
  }
});

test("changing the search closes the cascade without resurrecting it on clear", async () => {
  const junto = await seededLaunch();

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const claude = deck.getByRole("button", { name: "Claude Code", exact: true });
    await claude.hover();
    await waitForClaudeModels(page);

    const search = searchBox(page);
    await search.fill("codex");
    await expect(page.locator(".agent-cascade")).toHaveCount(0);
    await expect(claude).toHaveCount(0);

    await search.hover();
    await search.fill("");
    await expect(claude).toBeVisible();
    await expect(page.locator(".agent-cascade")).toHaveCount(0);
  } finally {
    await junto.close();
  }
});

test("search Down and Enter browse results without creating nodes", async () => {
  const junto = await seededLaunch({
    seedCanvases: { portfolio: canvasDoc([]) },
  });

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const canvasNodes = page.locator(".react-flow__node");
    const before = await canvasNodes.count();
    const search = searchBox(page);

    await search.press("ArrowDown");
    await expect(
      deck.getByRole("button", { name: "Claude Code", exact: true }),
    ).toBeFocused();
    await expect(canvasNodes).toHaveCount(before);

    await search.focus();
    await search.fill("shell");
    await search.press("Enter");
    await expect(deck.locator(".node-deck-catalog__card").first()).toBeFocused();
    await expect(canvasNodes).toHaveCount(before);

    await search.focus();
    await search.fill("zzzz-not-an-agent");
    await search.press("ArrowDown");
    await expect(search).toBeFocused();
    await expect(canvasNodes).toHaveCount(before);
  } finally {
    await junto.close();
  }
});

test("harness keyboard activation opens choices and Escape dismisses one layer at a time", async () => {
  const junto = await seededLaunch();

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const search = searchBox(page);
    await search.press("ArrowDown");
    const claude = deck.getByRole("button", { name: "Claude Code", exact: true });
    await expect(claude).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(deck.getByRole("button", { name: "Codex", exact: true })).toBeFocused();
    await page.keyboard.press("c");
    await expect(claude).toBeFocused();
    await expect(page.locator(".agent-cascade")).toHaveCount(0);

    await page.keyboard.press("Enter");
    const models = await waitForClaudeModels(page);
    await expect(models.getByRole("menuitem").first()).toBeFocused();
    await expect(deck).toBeVisible();

    const enterKey = await cascadeEnterKey(models);
    await page.keyboard.press(enterKey);
    const efforts = page.getByRole("menu", { name: /effort$/ });
    await expect(efforts).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(efforts).toHaveCount(0);
    await expect(models.getByRole("menuitem").first()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.locator(".agent-cascade")).toHaveCount(0);
    await expect(claude).toBeFocused();
    await page.waitForTimeout(400);
    await expect(page.locator(".agent-cascade")).toHaveCount(0);

    await page.keyboard.press(" ");
    await waitForClaudeModels(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".agent-cascade")).toHaveCount(0);
    await expect(claude).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Add canvas item" })).toHaveCount(0);
  } finally {
    await junto.close();
  }
});

test("Tab and Shift-Tab leave the cascade relative to its harness anchor", async () => {
  const junto = await seededLaunch();

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const claude = deck.getByRole("button", { name: "Claude Code", exact: true });
    await claude.focus();
    await page.keyboard.press("Enter");
    await waitForClaudeModels(page);

    await page.keyboard.press("Tab");
    await expect(page.locator(".agent-cascade")).toHaveCount(0);
    await expect(deck.getByRole("button", { name: "Codex", exact: true })).toBeFocused();

    await claude.focus();
    await page.keyboard.press("Enter");
    await waitForClaudeModels(page);
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(".agent-cascade")).toHaveCount(0);
    await expect(deck.getByRole("tab", { name: "Canvas", exact: true })).toBeFocused();
  } finally {
    await junto.close();
  }
});

test("Escape dismisses a hover preview without changing search focus or query", async () => {
  const junto = await seededLaunch();

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const search = searchBox(page);
    await search.fill("claude");
    await expect(search).toBeFocused();

    await deck.getByRole("button", { name: "Claude Code", exact: true }).hover();
    await waitForClaudeModels(page);
    await expect(search).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.locator(".agent-cascade")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Add canvas item" })).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("claude");
  } finally {
    await junto.close();
  }
});

test("column type-ahead scrolls to an offscreen model and selects its effort", async () => {
  const junto = await seededLaunch({
    seedCanvases: { portfolio: canvasDoc([]) },
  });

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    await chooseWorkingDirectory(page, deck);
    await searchBox(page).press("ArrowDown");
    await page.keyboard.press("Enter");
    const models = await waitForClaudeModels(page);

    await page.keyboard.type("zephyr");
    const zephyr = models.getByRole("menuitem", { name: "Zephyr 1", exact: true });
    await expect(zephyr).toBeFocused();
    await expect.poll(async () =>
      zephyr.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const root = element.closest(".agent-cascade__items");
        if (!root) return false;
        const bounds = root.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      }),
    ).toBe(true);

    const enterKey = await cascadeEnterKey(models);
    await page.keyboard.press(enterKey);
    const efforts = page.getByRole("menu", { name: "Zephyr 1 effort" });
    await expect(efforts).toBeVisible();
    await page.keyboard.type("high");
    await expect(efforts.getByRole("menuitem", { name: "high", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");

    await expect.poll(async () => agentSeats(page)).toEqual([
      { harness: "claude", model: "claude-zephyr-1", effort: "high" },
    ]);
  } finally {
    await junto.close();
  }
});

test("Use harness defaults creates one Kimi agent when no models are available", async () => {
  const junto = await seededLaunch({
    seedCanvases: { portfolio: canvasDoc([]) },
    seedHarnessInstalls: [...SEEDED_HARNESSES, "kimi"],
  });

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    await chooseWorkingDirectory(page, deck);
    const kimi = deck.getByRole("button", { name: "Kimi Code", exact: true });
    await expect(kimi).toBeVisible();
    await kimi.focus();
    await page.keyboard.press("Enter");

    const menu = page.getByRole("menu", { name: "Kimi Code models" });
    await expect(menu.getByRole("status", { name: "Loading options" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem")).toHaveCount(1);
    await expect(menu.getByRole("menuitem", { name: "Use harness defaults" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Use harness defaults" }).press("Enter");

    await expect.poll(async () => agentSeats(page)).toEqual([
      { harness: "kimi", model: undefined, effort: undefined },
    ]);
  } finally {
    await junto.close();
  }
});
