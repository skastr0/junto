/**
 * Operator feed — the needs-you surface.
 *   bun run test:e2e:fast e2e/scenarios/operator-feed.spec.ts
 *
 * Signals arrive through the same main → renderer event the signal store
 * listens to, so the feed reads them exactly as it would a seat's raise.
 *
 * Asserts:
 *   - ⌘I opens a calm empty feed when nobody is waiting
 *   - open signals group under their region, most urgent region first
 *   - the top bar entry carries the live count
 *   - j selects, Enter opens the inline reply, Esc closes the reply then the feed
 *   - an answered signal leaves the feed
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { GroupNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "operator-feed");
const CANVAS = "operator-feed";

const region = (id: string, label: string, x: number, y: number, width: number, height: number): GroupNode => ({
  id,
  type: "group",
  label,
  x,
  y,
  width,
  height,
});

const fixture = canvasDoc(
  [
    region("build", "Build", 0, 0, 900, 420),
    region("docs", "Docs", 1000, 0, 620, 420),
    agentTextNode({ id: "atlas", key: "local:e2e-feed-atlas", label: "Atlas", harness: "claude", x: 40, y: 80 }),
    agentTextNode({ id: "brook", key: "local:e2e-feed-brook", label: "Brook", harness: "codex", x: 360, y: 80 }),
    agentTextNode({ id: "cedar", key: "local:e2e-feed-cedar", label: "Cedar", harness: "claude", x: 1060, y: 80 }),
    agentTextNode({ id: "drift", key: "local:e2e-feed-drift", label: "Drift", harness: "codex", x: 1800, y: 80 }),
  ],
  [],
);

const MINUTE = 60_000;

const signal = (over: Partial<AgentSignal> & Pick<AgentSignal, "signalId" | "nodeId" | "kind" | "text">): AgentSignal => ({
  canvasName: CANVAS,
  createdAt: Date.now() - 5 * MINUTE,
  state: "open",
  ...over,
});

test("the operator feed lists every seat waiting on the operator, by region", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: fixture } });
  try {
    const { app, page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });

    const push = async (value: AgentSignal): Promise<void> => {
      await app.evaluate(({ BrowserWindow }, payload) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send("junto:agent-signal", payload);
      }, value);
    };

    // Calm empty state.
    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    await expect(feed).toContainText("Nobody needs you right now");
    await page.screenshot({ path: join(SHOTS, "feed-empty.png") });
    await page.keyboard.press("Escape");
    await expect(feed).toHaveCount(0);

    await push(signal({
      signalId: "sig-blocked",
      nodeId: "cedar",
      kind: "blocked",
      text: "I need the staging database password to run the migration.",
      detail: "The migration in `db/0042_accounts.sql` needs **write** access.\n\n- tried the read replica\n- the vault entry is empty",
      createdAt: Date.now() - 42 * MINUTE,
    }));
    await push(signal({
      signalId: "sig-escalate",
      nodeId: "atlas",
      kind: "escalate",
      text: "Two tests disagree on the date format; I picked ISO 8601 and kept going.",
      createdAt: Date.now() - 18 * MINUTE,
    }));
    await push(signal({
      signalId: "sig-feedback",
      nodeId: "brook",
      kind: "feedback",
      text: "The settings page redesign is ready for a look.",
      createdAt: Date.now() - 7 * MINUTE,
    }));
    await push(signal({
      signalId: "sig-open-field",
      nodeId: "drift",
      kind: "feedback",
      text: "Draft release notes are in the pad.",
      createdAt: Date.now() - 3 * MINUTE,
    }));

    const trigger = page.getByTestId("operator-feed-trigger");
    await expect(trigger).toHaveAttribute("aria-label", "Open needs-you feed, 4 waiting");
    await page.screenshot({ path: join(SHOTS, "topbar-count.png"), clip: { x: 0, y: 0, width: 1400, height: 60 } });

    await trigger.click();
    await expect(feed).toBeVisible();
    const regionLabels = feed.locator(".operator-feed__region-label");
    await expect(regionLabels).toHaveText(["Docs", "Build", "open field"]);
    await expect(feed.getByTestId("operator-feed-card")).toHaveCount(4);
    await page.screenshot({ path: join(SHOTS, "feed-regions.png") });

    // Expand the blocked card's detail.
    const blocked = feed.locator("[data-item-id='signal:sig-blocked']");
    await blocked.getByRole("button", { name: "details" }).click();
    await expect(blocked.locator(".operator-feed__detail")).toContainText("tried the read replica");

    // j selects the first card; Enter opens its reply; Esc closes the reply first.
    await page.keyboard.press("j");
    await expect(blocked).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Enter");
    await expect(blocked.getByLabel("Your reply")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "feed-reply.png") });
    await page.keyboard.press("Escape");
    await expect(blocked.getByLabel("Your reply")).toHaveCount(0);
    await expect(feed).toBeVisible();

    // An answered signal leaves.
    await push(signal({
      signalId: "sig-feedback",
      nodeId: "brook",
      kind: "feedback",
      text: "The settings page redesign is ready for a look.",
      state: "answered",
      response: { text: "Looks great, ship it.", at: Date.now() },
      closedAt: Date.now(),
    }));
    await expect(feed.getByTestId("operator-feed-card")).toHaveCount(3, { timeout: 5_000 });
    await expect(trigger).toHaveAttribute("aria-label", "Open needs-you feed, 3 waiting");

    await page.keyboard.press("Escape");
    await expect(feed).toHaveCount(0);
  } finally {
    await junto.close();
  }
});
