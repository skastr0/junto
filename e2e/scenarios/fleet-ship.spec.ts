/**
 * SHIP-profile Fleet acceptance coverage.
 *
 * Build first with `VELLUM_COMMAND_FEATURE_PROFILE=ship bun run electron-vite build`,
 * then run this file through the node Playwright runner. The harness owns a
 * throwaway SQLite installation and uses only the bounded e2e SSH fake.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { CanvasDoc, GroupNode, TextNode } from "../../src/shared/canvas";
import type { RemoteHost } from "../../src/shared/remote-hosts";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "fleet-ship");

const localHost: RemoteHost = {
  id: "local",
  label: "this machine",
  kind: "local",
  capabilities: ["terminal", "browser"],
};

const enrolledRemote: RemoteHost = {
  id: "remote-a",
  label: "remote-a",
  kind: "remote",
  sshEndpoint: "remote-a",
  capabilities: ["terminal", "browser"],
};

const terminalOnlyMac: RemoteHost = {
  id: "terminal-mac",
  label: "terminal mac",
  kind: "remote",
  sshEndpoint: "terminal-mac",
  capabilities: ["terminal"],
};

const emptyFleetDoc = canvasDoc([]);

const shipRoutingDoc = (): CanvasDoc => {
  const region: GroupNode = {
    id: "ship-region",
    type: "group",
    label: "ship region",
    x: 40,
    y: 40,
    width: 680,
    height: 360,
    ether: {
      region: {
        hold: true,
        defaults: {
          paths: { local: "/Users/operator/Projects/vellum", "remote-a": "/tmp/remote-a" },
        },
      },
    },
  };
  const taskSeed = tasksNode({ id: "ship-tasks", x: 110, y: 130 });
  const tasks: TextNode = { ...taskSeed, ether: { ...taskSeed.ether, host: "local" } };
  return canvasDoc([region, tasks]);
};

const waitForCanvas = async (page: Page): Promise<void> => {
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
};

const shot = async (page: Page, name: string): Promise<void> => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

const openFleet = async (page: Page): Promise<ReturnType<Page["locator"]>> => {
  await page.getByRole("button", { name: "Open fleet manager" }).click();
  const panel = page.locator(".fleet-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
};

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test("SHIP Fleet entry, empty state, enrollment validation, and clean relaunch", async () => {
  const vellumCommand = await launchVellum({
    seedCanvases: { "fleet-ship-empty": emptyFleetDoc },
  });
  try {
    const { page } = vellumCommand;
    await waitForCanvas(page);

    const panel = await openFleet(page);
    await expect(panel).toContainText("0 enrolled");
    await expect(panel).toContainText("routes untested");
    await expect(panel.getByRole("button", { name: "Add host" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Box" })).toHaveCount(0);
    await shot(page, "01-empty-fleet");

    await panel.getByRole("button", { name: "Add host" }).click();
    const form = page.getByRole("dialog", { name: "Add remote host" });
    await expect(form).toBeVisible();
    await form.getByRole("button", { name: "save host" }).click();
    await expect(form).toHaveAttribute("aria-label", "Add remote host");
    await expect(form.getByRole("alert")).toHaveText("Label and SSH endpoint are required.");
    await form.getByRole("textbox", { name: "Host label" }).fill("remote-a");
    await form.getByRole("textbox", { name: "Host endpoint" }).fill("remote-a");
    const terminalCapability = form.locator(".fleet-form__capabilities button", { hasText: "terminal" });
    const browserCapability = form.locator(".fleet-form__capabilities button", { hasText: "browser" });
    await terminalCapability.click();
    await browserCapability.click();
    await form.getByRole("button", { name: "save host" }).click();
    await expect(form.getByRole("alert")).toHaveText("Enable at least one host capability.");
    await terminalCapability.click();
    await form.getByRole("button", { name: "save host" }).click();
    await expect(form).toHaveCount(0);
    await expect(panel.locator(".fleet-station")).toHaveCount(1);
    await expect(panel).toContainText("remote-a");
    await shot(page, "02-enrolled-host");

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await openFleet(page);
    await expect(page.locator(".fleet-station")).toHaveCount(1);
    await shot(page, "03-fleet-reopened");
    await page.keyboard.press("Escape");
    await expect(page.locator(".fleet-panel")).toHaveCount(0);
  } finally {
    await vellumCommand.close();
  }
});

test("SHIP station detail shows probe truth and main-owned deploy gating", async () => {
  const vellumCommand = await launchVellum({
    seedCanvases: { "fleet-ship-detail": emptyFleetDoc },
    seedHosts: [localHost, enrolledRemote, terminalOnlyMac],
  });
  try {
    const { page } = vellumCommand;
    await waitForCanvas(page);
    const panel = await openFleet(page);
    await expect(panel.locator(".fleet-station")).toHaveCount(2, { timeout: 15_000 });
    await expect(panel.locator(".fleet-machine__icon")).toHaveCount(3, { timeout: 20_000 });

    const remoteStation = panel.locator(".fleet-station", { hasText: "remote-a" });
    await remoteStation.click();
    const detail = page.getByRole("complementary", { name: "Fleet node detail" });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Enrolled machine");
    await expect(detail).toContainText("remote-a");
    await expect(detail.getByText("Remote deploy", { exact: true })).toBeVisible();
    await expect(detail.locator(".fleet-detail__section-label", { hasText: "Linux host" })).toHaveCount(0);
    const deploy = detail.getByRole("button", { name: "Deploy Vellum Command Remote" });
    await expect(deploy).toBeDisabled();
    await expect(detail).toContainText(/turned off|disabled/i);
    await expect(detail.getByRole("button", { name: "Configure Remote" })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Test Station link" }).first()).toBeVisible();
    await expect(detail).toContainText(/link untested|checking route|reachable|On the network|Can't reach|unreachable/);
    await shot(page, "04-station-detail-gated");

    await detail.getByRole("button", { name: "Test Station link" }).first().click();
    await expect(detail).toContainText(/checking route|reachable|On the network|Can't reach|unreachable|link untested/, { timeout: 20_000 });
    await detail.getByRole("button", { name: "Close fleet detail" }).click();
    await expect(detail).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Box" })).toHaveCount(0);
    await shot(page, "05-probe-result");
  } finally {
    await vellumCommand.close();
  }
});

test("SHIP routing exposes enrolled hosts for terminal, agent, queue, regions, and Machine settings", async () => {
  const vellumCommand = await launchVellum({
    seedCanvases: { "fleet-ship-routing": shipRoutingDoc() },
    seedHosts: [localHost, enrolledRemote],
  });
  try {
    const { page } = vellumCommand;
    await waitForCanvas(page);

    const region = page.getByTestId("rf__node-ship-region");
    await expect(region).toBeVisible({ timeout: 30_000 });
    await region.locator(".region-drag-handle").click();
    await page.getByRole("button", { name: /Region folder paths/i }).click();
    const paths = page.getByRole("dialog", { name: "Region folder paths" });
    await expect(paths).toBeVisible();
    await expect(paths.getByRole("option", { name: /local|this machine/i })).toBeVisible();
    await paths.getByRole("option", { name: /remote-a/i }).click();
    await expect(paths.getByRole("textbox", { name: /Working directory for remote-a/i })).toHaveValue("/tmp/remote-a");
    await shot(page, "06-region-paths-ship");
    await page.keyboard.press("Escape");
    await expect(paths).toHaveCount(0);

    const tasks = page.locator('.react-flow__node[data-id="ship-tasks"]');
    await tasks.click();
    await page.getByRole("button", { name: "Queue home" }).click();
    const queueHome = page.getByLabel("Task queue home host");
    await expect(queueHome).toBeVisible();
    await queueHome.click();
    const queueOptions = page.getByRole("listbox", { name: "Task queue home host" });
    await expect(queueOptions.getByRole("option", { name: /remote-a/i })).toBeVisible();
    await queueOptions.getByRole("option", { name: /remote-a/i }).click();
    await expect(queueHome).toContainText(/remote-a/i);
    await shot(page, "07-queue-home-ship");

    await tasks.getByTestId("tasks-card").dispatchEvent("dblclick");
    const taskBoard = page.getByRole("dialog", { name: "Task board" });
    await expect(taskBoard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(taskBoard).toHaveCount(0);

    await page.locator(".node-deck-trigger").click();
    const add = page.getByRole("dialog", { name: "Add canvas item" });
    await expect(add).toBeVisible();
    await expect(add.getByRole("region", { name: "Launch context" })).toBeVisible();
    const agentHost = add.getByLabel("Agent host");
    await agentHost.click();
    const agentOptions = page.getByRole("listbox", { name: "Agent host" });
    await expect(agentOptions.getByRole("option", { name: /remote-a/i })).toBeVisible();
    await agentOptions.getByRole("option", { name: /remote-a/i }).click();
    await expect(agentHost).toContainText(/remote-a/i);
    await add.getByRole("button", { name: /^Terminal/i }).click();
    const terminalWizard = page.getByRole("dialog", { name: "New terminal" });
    await expect(terminalWizard).toBeVisible();
    const terminalHost = terminalWizard.getByLabel("Host");
    await terminalHost.click();
    const terminalOptions = page.getByRole("listbox", { name: "Host" });
    await expect(terminalOptions.getByRole("option", { name: /remote-a/i })).toBeVisible();
    await terminalOptions.getByRole("option", { name: /remote-a/i }).click();
    await expect(terminalHost).toContainText(/remote-a/i);
    await shot(page, "08-terminal-host-choice-ship");
    await page.keyboard.press("Escape");
    await expect(terminalWizard).toHaveCount(0);

    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(settings.locator(".settings-nav__item", { hasText: "Machine" })).toBeVisible();
    await expect(settings.getByTestId("settings-machine-section")).toContainText("This machine's host id");
    await expect(settings.getByLabel("Prefer supervised runtime")).toBeVisible();
    await shot(page, "09-machine-settings-ship");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
  } finally {
    await vellumCommand.close();
  }
});

test("SHIP Fleet stays usable in bright mode, reduced motion, and a narrow viewport", async () => {
  const vellumCommand = await launchVellum({
    seedCanvases: { "fleet-ship-a11y": emptyFleetDoc },
    seedHosts: [localHost, enrolledRemote],
  });
  try {
    const { page } = vellumCommand;
    await waitForCanvas(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 760, height: 620 });
    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Appearance" }).click();
    await settings.getByRole("radio", { name: "Bright" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
    await expect(settings).toContainText(/Appearance|theme/i);
    await page.keyboard.press("Escape");

    const panel = await openFleet(page);
    await expect(panel).toBeVisible();
    const overflow = await panel.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
    await shot(page, "10-fleet-narrow-bright-reduced-motion");
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  } finally {
    await vellumCommand.close();
  }
});
