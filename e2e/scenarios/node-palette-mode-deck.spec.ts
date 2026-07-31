import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { GroupNode } from "../../src/shared/canvas";
import { canvasDoc } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const REPO_ROOT = process.cwd();

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

  const search = page.getByRole("searchbox", {
    name: "Search nodes and agents",
  });
  await expect(search).toBeVisible();

  const deck = page.getByRole("region", { name: "Add canvas item" });
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
  return picker;
};

test("Mode Deck exposes the searchable catalog and keeps launch context dense at the foot of the agent pane", async () => {
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    const deck = await openModeDeck(page);

    for (const category of ["All", "Agents", "Shell"]) {
      await expect(deck.getByRole("tab", { name: category, exact: true }))
        .toBeVisible();
    }

    await deck.getByRole("tab", { name: "Shell", exact: true }).click();
    await expect(
      deck.getByRole("button", { name: /terminal/i }),
    ).toBeVisible();
    await expect(deck.getByRole("button", { name: /herdr/i })).toBeVisible();

    await deck.getByRole("tab", { name: "Schedule", exact: true }).click();
    for (const scheduler of ["Cron", "Gauge", "Relay"]) {
      await expect(
        deck.locator(".node-deck-catalog__card").filter({ hasText: scheduler }),
      ).toBeVisible();
    }

    await deck.getByRole("tab", { name: "Agents", exact: true }).click();
    const agentPane = deck.locator('aside[aria-label="Agents"]');
    const launchContext = agentPane.getByRole("region", {
      name: "Launch context",
    });
    const agentRows = [
      agentPane.getByRole("button", { name: "Add Claude Code agent" }),
      agentPane.getByRole("button", { name: "Add Codex agent" }),
      agentPane.getByRole("button", { name: "Add Grok agent" }),
      agentPane.getByRole("button", { name: "Add Hermes agent" }),
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
    for (const port of ["tasks.list", "tasks.claim", "tasks.update"]) {
      await expect(wiring.locator("code").filter({ hasText: port })).toBeVisible();
    }
    await expect(wiring).toContainText("Requests and Artifacts");
    await expect(wiring).toContainText("Schedulers enqueue at Tasks");

    const lastAgentBox = await agentRows.at(-1)!.boundingBox();
    const wiringBox = await wiring.boundingBox();
    const launchBox = await launchContext.boundingBox();
    expect(lastAgentBox).not.toBeNull();
    expect(wiringBox).not.toBeNull();
    expect(launchBox).not.toBeNull();
    expect(wiringBox!.y).toBeGreaterThanOrEqual(
      lastAgentBox!.y + lastAgentBox!.height,
    );
    expect(
      wiringBox!.y - (lastAgentBox!.y + lastAgentBox!.height),
    ).toBeLessThanOrEqual(24);
    expect(launchBox!.y).toBeGreaterThanOrEqual(
      wiringBox!.y + wiringBox!.height,
    );
    expect(
      launchBox!.y - (wiringBox!.y + wiringBox!.height),
    ).toBeLessThanOrEqual(24);
  } finally {
    await vellum.close();
  }
});

test("model and effort choices remain visually attached to the active agent row", async () => {
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    const deck = await openModeDeck(page);
    await deck.getByRole("tab", { name: "Agents", exact: true }).click();

    const agent = deck.getByRole("button", { name: "Add Claude Code agent" });
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
    await vellum.close();
  }
});

test("starting-folder modal reuses live directory browsing and can save a containing-region default", async () => {
  const vellum = await launchVellum({
    seedCanvases: { portfolio: canvasDoc([containingRegion]) },
  });

  try {
    const { page } = vellum;
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
    await vellum.close();
  }
});

test("region-default promotion fails closed with actionable guidance outside a region", async () => {
  const vellum = await launchVellum({
    seedCanvases: { portfolio: canvasDoc([]) },
  });

  try {
    const { page } = vellum;
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
    await vellum.close();
  }
});

test("one agent-row click creates exactly one configured agent without a legacy location step", async () => {
  const vellum = await launchVellum({
    seedCanvases: { portfolio: canvasDoc([]) },
  });

  try {
    const { page } = vellum;
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
    await deck.getByRole("button", { name: "Add Claude Code agent" }).click();

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
        const canvases = await window.vellum!.listCanvases();
        const name = canvases[0]?.name;
        if (!name) return [];
        const read = await window.vellum!.readCanvas(name);
        return read.doc.nodes
          .filter((node) => node.ether?.entity?.kind === "agent")
          .map((node) => ({
            harness: node.ether?.terminal?.harness,
            cwd: node.ether?.terminal?.launch?.cwd,
          }));
      });
    }).toEqual([{ harness: "claude", cwd: join(REPO_ROOT, "src") }]);
  } finally {
    await vellum.close();
  }
});

test("node detail rail preserves navigation while explaining primary and secondary connections", async () => {
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    const deck = await openModeDeck(page);
    const terminal = deck.locator(".node-deck-catalog__card").filter({
      hasText: "Terminal",
    });
    await terminal.hover();

    const detail = deck.getByRole("complementary", {
      name: "Terminal details",
    });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(/managed shell/i);
    await expect(detail.locator(".node-deck-catalog__connection-map"))
      .not.toHaveCount(0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(deck).not.toContainText(/inspect · click to add/i);

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
    await expect(taskDetail).toContainText("Agent");
    await expect(taskDetail).toContainText("Scheduler");
    await expect(taskDetail).toContainText("tasks.claim");
    await expect(taskDetail.locator(".node-deck-catalog__connection--primary"))
      .toHaveCount(1);
    await expect(taskDetail.locator(".node-deck-catalog__connection--secondary"))
      .not.toHaveCount(0);
  } finally {
    await vellum.close();
  }
});
