import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { HarnessId } from "../../src/shared/managed-terminal-templates";
import type { ClaudeModelCacheEntry } from "../harness/agent-harness-fixture";
import { modelFixture } from "../harness/model";
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
  await expect(launchContext.getByLabel("Machine")).toBeVisible();
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

test("one agent-row click creates exactly one configured agent without a legacy location step", async () => {
  const junto = await seededLaunch({
    seedModels: { portfolio: modelFixture([]) },
  });

  try {
    const { page } = junto;
    const deck = await openModeDeck(page);
    const picker = await openFolderPicker(page, deck);
    const input = picker.getByLabel("Agent working directory");

    await input.fill(`${REPO_ROOT}/`);
    const listing = picker.getByRole("listbox", {
      name: `Folders in ${REPO_ROOT}`,
    });
    await expect(listing).toBeVisible({ timeout: 10_000 });
    await listing.getByRole("option", { name: "src", exact: true }).click();
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
        const canvases = await window.junto!.modelCanvases();
        const name = canvases[0]?.name;
        if (!name) return [];
        const read = await window.junto!.modelOpen({ canvas: name });
        return read.nodes
          .filter((node) => node.kind === "agent")
          .map((node) => ({
            harness: node.harness,
            cwd: node.launch?.cwd,
          }));
      });
    }).toEqual([{ harness: "claude", cwd: join(REPO_ROOT, "src") }]);
  } finally {
    await junto.close();
  }
});

test("a create attempt with no working directory opens the folder picker instead of minting a seat", async () => {
  const junto = await seededLaunch({
    seedModels: { portfolio: modelFixture([]) },
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
