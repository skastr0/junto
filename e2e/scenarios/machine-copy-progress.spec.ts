import { mkdir } from "node:fs/promises";
import { IPC_CHANNELS } from "../../src/shared/ipc";
import { OPERATOR_PROTOCOL_VERSION } from "../../src/shared/operator-control";
import { modelFixture } from "../harness/model";
import { expect, test } from "../harness/launch";

test.use({ juntoOptions: { seedModels: { "copy-progress": modelFixture([]) } } });

test("the Machines strip shows bytes, a stated stall and resumed copying", async ({ junto }) => {
  const { app, page } = junto;
  await app.evaluate(({ ipcMain }, { command, progress, protocol }) => {
    const probe = globalThis as unknown as { copyProbe: { id: string; emit: (state: string, bytes: number) => void; finish: () => void } };
    ipcMain.removeHandler(command);
    ipcMain.handle(command, (event, request) => {
      if (request.op === "machine.list") return { protocol, id: request.id, op: request.op, ok: true, data: { machines: [{
        machine: { id: "copy-mini", label: "Copy mini", isThisMachine: false, capabilities: ["terminal"], sshEndpoint: "op@mini" },
        setUp: false, needsUpdate: false,
      }] } };
      if (request.op === "machine.send") return new Promise(resolve => {
        const emit = (state: string, copiedBytes: number) => event.sender.send(progress, {
          id: request.id, event: { event: "machine-copy", copiedBytes, totalBytes: 69_162_835, state },
        });
        probe.copyProbe = { id: request.id, emit, finish: () => resolve({ protocol, id: request.id, op: request.op, ok: false,
          error: { type: "io", message: "Fixture finished", details: { retryable: false, disposition: "uncertain" } } }) };
        emit("copying", 0);
      });
      return { protocol, id: request.id, op: request.op, ok: false, error: { type: "unavailable", message: "Fixture does not run this command" } };
    });
  }, { command: IPC_CHANNELS.machineCommand, progress: IPC_CHANNELS.machineProgress, protocol: OPERATOR_PROTOCOL_VERSION });
  await page.getByRole("button", { name: "Open machines", exact: true }).click();
  await page.getByTestId("machine-row-copy-mini").click();
  await page.getByTestId("machine-action-send").click();
  const strip = page.getByTestId("machine-steps");
  const copy = strip.locator('[data-step="copy"]');
  await expect(copy).toContainText("0 of 69 MB");
  const emit = async (state: string, bytes: number) => app.evaluate((_electron, input) => {
    const probe = globalThis as unknown as { copyProbe: { emit: (state: string, bytes: number) => void } };
    probe.copyProbe.emit(input.state, input.bytes);
  }, { state, bytes });
  await emit("copying", 25_000_000);
  await expect(copy).toHaveText("Copying: 25 of 69 MB");
  await mkdir("test-results/machine-copy-progress", { recursive: true });
  await page.screenshot({ path: "test-results/machine-copy-progress/copying.png" });
  await emit("stalled", 25_000_000);
  await expect(copy).toHaveText("No progress for 30 seconds: 25 of 69 MB");
  await page.screenshot({ path: "test-results/machine-copy-progress/stalled.png" });
  await emit("copying", 26_000_000);
  await expect(copy).toHaveText("Copying: 26 of 69 MB");
  await emit("copied", 69_162_835);
  await expect(copy).toHaveText("Done: Copy, 69 of 69 MB");
  await app.evaluate(() => (globalThis as unknown as { copyProbe: { finish: () => void } }).copyProbe.finish());
});
