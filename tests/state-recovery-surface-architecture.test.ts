import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readSource = (relative: string) =>
  readFile(new URL(relative, import.meta.url), "utf8");

describe("state recovery renderer boundary", () => {
  it("does not expose a renderer-controlled destination or a restore verb", async () => {
    const ipc = await readSource("../src/shared/ipc.ts");
    const preload = await readSource("../src/preload/index.ts");

    expect(ipc).toContain(
      "readonly stateBackupExport: (\n    id: StateBackupId,\n  )",
    );
    expect(preload).toContain(
      "stateBackupExport: async (id) =>",
    );
    expect(preload).not.toContain(
      "decodeStateRecoveryExportResult",
    );
    expect(preload).not.toContain(
      "decodeStateRecoveryListResult",
    );
    expect(preload).not.toContain("stateBackupRestore");
    expect(ipc).not.toContain("stateBackupRestore");
  });

  it("keeps native save selection and overwrite refusal in Main", async () => {
    const settingsIpc = await readSource(
      "../src/main/junto/settings/ipc.ts",
    );
    const recovery = await readSource(
      "../src/main/junto/state/recovery.ts",
    );

    expect(settingsIpc).toContain("dialog.showSaveDialog");
    expect(settingsIpc).toContain(
      "stateRecovery.export(id, chooseDestination)",
    );
    expect(recovery).toContain("constants.O_EXCL");
  });

  it("offers verified export in Advanced without restore or replacement controls", async () => {
    const settings = await readSource(
      "../src/renderer/components/SettingsPanel.tsx",
    );

    expect(settings).toContain("Verified retained backups");
    expect(settings).toContain(
      "It cannot restore or replace this installation.",
    );
    expect(settings).toContain("api.stateBackupsList()");
    expect(settings).toContain(
      "api.stateBackupExport(selectedId)",
    );
    expect(settings).not.toContain("stateBackupRestore");
  });
});
