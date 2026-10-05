/**
 * A preview thumbnail in the needs-you feed, by keyboard.
 *   bun run test:e2e:fast e2e/scenarios/feed-previews-keyboard.spec.ts
 *
 * A thumbnail is a button. With the keyboard on it, Enter and Space both
 * open the viewer at that file, as a press does. Enter is also the feed's
 * key for writing a reply, and the feed must not take it from a focused
 * thumbnail: no reply box opens.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "feed-previews-keys";
/** A real 1 by 1 PNG. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("Enter and Space on a focused thumbnail open the viewer, and Enter opens no reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "junto-feed-previews-keys-"));
  await writeFile(join(dir, "before.png"), PIXEL);
  await writeFile(join(dir, "after.png"), PIXEL);
  const signal: AgentSignal = {
    signalId: "sig-keys",
    canvasName: CANVAS,
    nodeId: "atlas",
    kind: "feedback",
    text: "Two screenshots to look at.",
    detail: `- Before: ${join(dir, "before.png")}\n- After: ${join(dir, "after.png")}`,
    createdAt: Date.now() - 60_000,
    state: "open",
  };
  const junto = await launchJunto({
    seedCanvases: {
      [CANVAS]: canvasDoc([agentTextNode({ id: "atlas", key: "local:e2e-preview-keys", label: "Atlas", harness: "claude", x: 40, y: 80 })], []),
    },
    seedAgentSignals: [signal],
  });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const card = feed.locator("[data-item-id='signal:sig-keys']");
    await card.getByRole("button", { name: "Details" }).click();
    const thumbs = card.getByTestId("preview-strip").getByTestId("preview-thumbnail");
    await expect(thumbs).toHaveCount(2);
    const viewer = page.getByTestId("preview-viewer");

    for (const key of ["Space", "Enter"]) {
      await thumbs.nth(1).focus();
      await expect(thumbs.nth(1)).toBeFocused();
      await page.keyboard.press(key);
      await expect(viewer, `${key} on the focused thumbnail`).toBeVisible({ timeout: 3_000 });
      await expect(viewer.getByTestId("preview-viewer-title")).toHaveText("after.png");
      await expect(card.getByLabel("Your reply")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(viewer).toHaveCount(0);
      await expect(feed).toBeVisible();
    }
  } finally {
    await junto.close();
    await rm(dir, { recursive: true, force: true });
  }
});
