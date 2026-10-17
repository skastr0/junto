import { mkdir } from "node:fs/promises";
import { IPC_CHANNELS } from "../../src/shared/ipc";
import { OPERATOR_PROTOCOL_VERSION } from "../../src/shared/operator-control";
import { modelFixture } from "../harness/model";
import { expect, test } from "../harness/launch";

// One machines dropdown in the Settings section list heads every
// machine-specific page: every linked machine in it, an unreachable one
// still a choice.

test.use({ juntoOptions: { seedModels: { "settings-machine": modelFixture([]) } } });

const SHOTS = "test-results/settings-machine-picker";

test("the Settings sidebar has a machines dropdown naming every linked machine", async ({ junto }) => {
  const { app, page } = junto;
  await mkdir(SHOTS, { recursive: true });
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Name and startup" }).click();
  const own = (await page.getByTestId("settings-machine-section").locator('span[style*="color"]').first().innerText()).trim();

  await app.evaluate(({ ipcMain }, { command, protocol, own }) => {
    ipcMain.removeHandler(command);
    const row = (id: string, label: string, isThisMachine: boolean) => ({
      machine: { id, label, isThisMachine, capabilities: ["terminal"], ...(isThisMachine ? {} : { sshEndpoint: `op@${id}` }) },
      setUp: true, needsUpdate: false,
    });
    ipcMain.handle(command, (_event, request) => {
      const ok = (data: unknown) => ({ protocol, id: request.id, op: request.op, ok: true, data });
      if (request.op === "machine.list") {
        return ok({ machines: [row(own, "Desk", true), row("mac-mini", "Mini", false), row("build-box", "Build box", false)] });
      }
      if (request.op === "machine.status" && request.args?.name) {
        return ok({ machineName: request.args.name, reachable: request.args.name !== "mac-mini", harnesses: [], missingSecrets: [] });
      }
      return { protocol, id: request.id, op: request.op, ok: false, error: { type: "unavailable", message: "Fixture does not run this command" } };
    });
  }, { command: IPC_CHANNELS.machineCommand, protocol: OPERATOR_PROTOCOL_VERSION, own });
  // The dropdown reads the machines as Settings opens: open it again on the fixture.
  await page.locator(".settings-panel__close").click();
  await page.getByRole("button", { name: "Open settings" }).click();

  for (const theme of ["Dark", "Bright"] as const) {
    await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
    const choice = page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: new RegExp(theme) });
    await choice.click();
    await expect(choice).toHaveAttribute("aria-checked", "true");

    await page.locator(".settings-nav__item", { hasText: /^Agents$/ }).click();
    const picker = page.getByTestId("settings-machine-picker");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute("data-machine", own);
    await expect(picker).toContainText("Desk");
    await page.screenshot({ path: `${SHOTS}/${theme.toLowerCase()}-closed.png` });

    await picker.getByRole("button").click();
    const menu = page.getByRole("listbox", { name: /Choose a machine/ });
    await expect(menu.getByRole("option")).toHaveCount(3);
    await expect(menu.getByRole("option").nth(0)).toContainText("this machine");
    await expect(menu.getByRole("option", { name: /Mini/ })).toContainText("unreachable");
    await page.screenshot({ path: `${SHOTS}/${theme.toLowerCase()}-open.png` });

    await menu.getByRole("option", { name: /Mini/ }).click();
    await expect(picker).toHaveAttribute("data-machine", "mac-mini");
    await expect(picker).toContainText("unreachable");
    await page.screenshot({ path: `${SHOTS}/${theme.toLowerCase()}-unreachable.png` });
    // Every machine page follows the dropdown.
    await page.locator(".settings-nav__item", { hasText: "Providers" }).click();
    await expect(page.getByTestId("providers-machine-refused")).toContainText("Mini");
    await expect(picker).toHaveAttribute("data-machine", "mac-mini");

    // Back to this machine for the next theme.
    await picker.getByRole("button").click();
    await page.getByRole("listbox", { name: /Choose a machine/ }).getByRole("option").nth(0).click();
    await expect(picker).toHaveAttribute("data-machine", own);
  }
});
