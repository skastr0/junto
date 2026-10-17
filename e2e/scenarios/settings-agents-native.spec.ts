import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { IPC_CHANNELS } from "../../src/shared/ipc";
import { OPERATOR_PROTOCOL_VERSION } from "../../src/shared/operator-control";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import { expect, launchJunto, test } from "../harness/launch";

// Agents, Providers and Name and startup follow the machine the page head
// chose. This machine reads its harness's own config (a seeded settings.json
// in the sandboxed home, read only here); another machine's pages refuse
// plainly with their controls off. The palette still opens each harness on
// its own first step.

const SHOTS = "test-results/settings-agents-native";
const REAL_CLAUDE = join(process.env.HOME ?? "", ".local", "bin", "claude");

const seeded = {
  seedHarnessInstalls: ["amp", "hermes"] as const,
  claudeModelCache: [
    { value: "claude-opus-4-6", label: "Opus 4.6" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  ],
  afterSeed: async (sandbox: { homeDir: string }) => {
    const bin = seededHarnessBinDir(sandbox as never);
    await mkdir(bin, { recursive: true });
    // The operator's real claude binary answers --version; nothing else is read.
    await writeFile(join(bin, "claude"), '#!/bin/sh\ncase "$1" in --version) echo "2.1.302 (Claude Code)";; esac\nexit 0\n', { mode: 0o755 });
    await mkdir(join(sandbox.homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(sandbox.homeDir, ".claude", "settings.json"),
      `${JSON.stringify({ model: "opus", effortLevel: "high", permissions: { defaultMode: "plan" }, alwaysThinkingEnabled: true }, null, 2)}\n`,
    );
  },
};

const linkMini = (app: ElectronApplication, own: string) =>
  app.evaluate(({ ipcMain }, { command, protocol, own }) => {
    ipcMain.removeHandler(command);
    const row = (id: string, label: string, isThisMachine: boolean) => ({
      machine: { id, label, isThisMachine, capabilities: ["terminal"], ...(isThisMachine ? {} : { sshEndpoint: `op@${id}` }) },
      setUp: true, needsUpdate: false,
    });
    ipcMain.handle(command, (_event, request) => {
      const ok = (data: unknown) => ({ protocol, id: request.id, op: request.op, ok: true, data });
      if (request.op === "machine.list") return ok({ machines: [row(own, "Desk", true), row("mac-mini", "Mini", false)] });
      if (request.op === "machine.status" && request.args?.name) {
        return ok({ machineName: request.args.name, reachable: true, harnesses: [], missingSecrets: [] });
      }
      return { protocol, id: request.id, op: request.op, ok: false, error: { type: "unavailable", message: "Fixture does not run this command" } };
    });
  }, { command: IPC_CHANNELS.machineCommand, protocol: OPERATOR_PROTOCOL_VERSION, own });

const chooseMachine = async (page: Page, label: string) => {
  const picker = page.getByTestId("settings-machine-picker");
  await picker.getByRole("button").click();
  await page.getByRole("listbox", { name: /Choose a machine/ }).getByRole("option", { name: new RegExp(label) }).click();
};

const nav = (page: Page, name: RegExp) => page.locator(".settings-nav__item", { hasText: name }).click();

test("Agents, Providers and Name and startup follow the chosen machine", async () => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });
  const realVersion = /\d+\.\d+\.\d+/.exec(execFileSync(REAL_CLAUDE, ["--version"], { encoding: "utf8" }))?.[0];
  expect(realVersion).toBeDefined();
  const junto = await launchJunto(seeded);
  try {
    const { page, app } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Open settings" }).click();
    await nav(page, /Machine|Name and startup/);
    const own = (await page.getByTestId("settings-machine-section").locator('span[style*="color"]').first().innerText()).trim();
    await linkMini(app, own);

    // (1) Agents on this machine: real version, saved values from the file.
    await nav(page, /^Agents$/);
    const claude = page.locator('.settings-harness-card[data-harness="claude"]');
    // The first open waits on the scan and shows its result without a reopen.
    await expect(claude).toContainText(`version ${realVersion}`, { timeout: 60_000 });
    await expect(claude).toContainText("Saved in Claude Code's own config");
    const field = (label: string) => claude.getByLabel(`Claude Code ${label} in its own config on Desk`);
    await expect(field("model")).toHaveValue("opus", { timeout: 15_000 });
    await expect(field("effort")).toContainText("high");
    await expect(field("permission mode")).toContainText("plan");
    await expect(field("always think")).toBeChecked();
    await claude.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/desk-agents.png` });

    // (2) Agents with Mini: every card says inventory unavailable.
    await chooseMachine(page, "Mini");
    const cards = page.locator(".settings-harness-card");
    await expect(cards.first()).toContainText("inventory unavailable");
    const count = await cards.count();
    for (let index = 0; index < count; index += 1) await expect(cards.nth(index)).toContainText("inventory unavailable");
    await page.screenshot({ path: `${SHOTS}/mini-agents.png` });

    // (3) Providers and Name and startup with Mini: plain refusals, controls off.
    await nav(page, /^Providers$/);
    await expect(page.getByTestId("providers-machine-refused")).toContainText("No providers for Mini:");
    const providerSwitches = page.locator('.settings-section input[type="checkbox"]');
    expect(await providerSwitches.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await providerSwitches.count()); index += 1) await expect(providerSwitches.nth(index)).toBeDisabled();
    const secrets = page.locator('.settings-section input[type="password"]');
    expect(await secrets.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await secrets.count()); index += 1) await expect(secrets.nth(index)).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/mini-providers.png` });
    await nav(page, /Machine|Name and startup/);
    await expect(page.getByRole("status").filter({ hasText: "No record from Mini:" })).toBeVisible();
    const nameControls = page.getByTestId("settings-machine-section").locator("input");
    expect(await nameControls.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await nameControls.count()); index += 1) await expect(nameControls.nth(index)).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/mini-name.png` });

    // This machine again: both pages work as before.
    await chooseMachine(page, "Desk");
    await expect(page.getByRole("status").filter({ hasText: "No record from" })).toHaveCount(0);
    await expect(page.getByTestId("settings-machine-section").locator("input").first()).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}/desk-name.png` });
    await nav(page, /^Providers$/);
    await expect(page.getByTestId("providers-machine-refused")).toHaveCount(0);
    await expect(page.locator(".settings-section input").first()).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}/desk-providers.png` });
  } finally {
    await junto.close();
  }
});

test("the palette opens Hermes on profiles, Amp on modes and Claude on models", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto(seeded);
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Add canvas item" }).click();
    const deck = page.getByRole("dialog", { name: "Add canvas item" }).getByRole("region", { name: "Add canvas item" });
    const agentPane = deck.locator('aside[aria-label="Agents"]');
    for (const [name, step] of [["Hermes", "profile"], ["Amp", "mode"], ["Claude Code", "model"]] as const) {
      await agentPane.getByRole("button", { name, exact: true }).hover();
      await expect(page.locator(".agent-cascade__column").first().locator(".agent-cascade__caption-step")).toHaveText(step, { timeout: 15_000 });
      await page.screenshot({ path: `${SHOTS}/palette-${step}.png` });
      await page.mouse.move(4, 4);
    }
  } finally {
    await junto.close();
  }
});
