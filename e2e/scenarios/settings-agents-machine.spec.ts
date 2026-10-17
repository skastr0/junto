import { mkdir } from "node:fs/promises";
import { IPC_CHANNELS } from "../../src/shared/ipc";
import { OPERATOR_PROTOCOL_VERSION } from "../../src/shared/operator-control";
import { modelFixture } from "../harness/model";
import { expect, test } from "../harness/launch";

// Settings > Agents renders for the machine the page head chose: every
// harness card has the four rows with an All machines and a machine control,
// unset rows say Harness default, and a missing inventory is a red line.

test.use({ juntoOptions: { seedModels: { "settings-agents-machine": modelFixture([]) } } });

const SHOTS = "test-results/settings-agents-machine";
const ROWS = ["Model", "Effort", "Permission mode", "Extra arguments"];

test("Settings > Agents follows the chosen machine", async ({ junto }) => {
  const { app, page } = junto;
  await mkdir(SHOTS, { recursive: true });
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Machine" }).first().click();
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
        return ok({ machines: [row(own, "Desk", true), row("mac-mini", "Mini", false)] });
      }
      if (request.op === "machine.status" && request.args?.name) {
        return ok({ machineName: request.args.name, reachable: true, harnesses: [], missingSecrets: [] });
      }
      return { protocol, id: request.id, op: request.op, ok: false, error: { type: "unavailable", message: "Fixture does not run this command" } };
    });
  }, { command: IPC_CHANNELS.machineCommand, protocol: OPERATOR_PROTOCOL_VERSION, own });

  await page.locator(".settings-nav__item", { hasText: /^Agents$/ }).click();
  const picker = page.getByTestId("settings-machine-picker");
  const section = page.locator(".settings-section[data-machine]").first();

  for (const [machine, label] of [[own, "Desk"], ["mac-mini", "Mini"]] as const) {
    if (machine !== own) {
      await picker.getByRole("button").click();
      await page.getByRole("listbox", { name: /Choose a machine/ }).getByRole("option", { name: new RegExp(label) }).click();
    }
    await expect(picker).toHaveAttribute("data-machine", machine);
    await expect(section).toHaveAttribute("data-machine", machine);
    await expect(page.getByTestId("harness-settings-machine")).toContainText(label);
    await expect(page.getByRole("status").filter({ hasText: `No inventory for ${label}` })).toBeVisible();

    const card = section.locator(".settings-harness-list > li").first();
    for (const rowLabel of ROWS) {
      const row = card.locator(".settings-field", { hasText: rowLabel }).first();
      await expect(row).toContainText(`Seats on ${label} start with: Harness default`);
      await expect(row.locator(".settings-harness-layer")).toHaveCount(2);
      await expect(row.locator('[data-layer="harnessDefault"]')).toContainText("All machines");
      await expect(row.locator('[data-layer="machineDefault"]')).toContainText(label);
    }
    await page.screenshot({ path: `${SHOTS}/${label.toLowerCase()}.png` });
  }

  // Effort is a closed list: it is a select, so an off-list value cannot be typed.
  const effort = section.getByLabel("Claude Code effort, all machines");
  await expect(effort).toBeVisible();
  expect(await effort.evaluate((el) => el.tagName)).toBe("BUTTON");
  await expect(section.getByRole("textbox", { name: /effort/i })).toHaveCount(0);
});
