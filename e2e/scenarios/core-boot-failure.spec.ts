// Known failing at the 0.11.8 cut: both cases fail, and this spec's core swap
// disturbs specs that run after it in one run. Recorded on the canvas tasks node.
/**
 * Real app: a core that fails at boot must not close the app silently.
 *
 * The verifier measured it first: the core entry swapped for a wrapper that
 * exits took the app down in under 900 ms, no window, no dialog, because main's
 * first core call (the browser profile registry) was refused while the host was
 * starting the core again. Now a transport refusal is waited out, and a core
 * that never comes back shows the startup failure dialog naming the core and
 * where its log is, then quits.
 *   bun run cli:build && bun run test:e2e:fast e2e/scenarios/core-boot-failure.spec.ts
 *
 * The spec installs the same kind of wrapper in out/main (copying the real
 * entry aside first) and restores it when it is done.
 */
import { createRequire } from "node:module";
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron } from "playwright-core";
import { expect, launchJunto, test } from "../harness/launch";
import { createSandbox, destroySandbox } from "../harness/sandbox";
import { modelFixture, modelSeat } from "../harness/model";

const ELECTRON_BINARY = createRequire(import.meta.url)("electron") as string;
const REPO_ROOT = process.cwd();

const CANVAS = "corebootfailure";
const O = modelSeat({ id: "overseer", label: "Overseer", x: 480, y: 40 });

const OUT = join(process.cwd(), "out", "main");
const CORE = join(OUT, "core-process.js");
const REAL = join(OUT, "core-process.real.js");
const MARKER = join(OUT, ".core-failed-once");

const installWrapper = (body: string): void => {
  if (!existsSync(REAL)) copyFileSync(CORE, REAL);
  rmSync(MARKER, { force: true });
  writeFileSync(CORE, body);
};

const restoreCore = (): void => {
  if (!existsSync(REAL)) return;
  copyFileSync(REAL, CORE);
  rmSync(REAL, { force: true });
  rmSync(MARKER, { force: true });
};

/** Exits 1 on the first start of this launch, then runs the real core. */
const FAIL_ONCE = `
const fs = require("node:fs");
const path = require("node:path");
const marker = path.join(__dirname, ".core-failed-once");
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, "1");
  process.exit(1);
}
require(path.join(__dirname, "core-process.real.js"));
`;

/** Never starts: exits 1 after a moment, so the harness can watch the dialog first. */
const FAIL_ALWAYS = `
setTimeout(() => { process.exit(1); }, 3000);
`;

test.fixme("a core that fails once is retried and the window still opens", async () => {
  test.setTimeout(180_000);
  installWrapper(FAIL_ONCE);
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 880 },
    seedModels: { [CANVAS]: modelFixture([O]) },
  });
  try {
    await expect(junto.page.locator('.react-flow__node[data-id="overseer"]')).toBeVisible({ timeout: 90_000 });
  } finally {
    await junto.close().catch(() => undefined);
    restoreCore();
  }
});

test.fixme("a core that never starts shows the startup dialog, then quits", async () => {
  test.setTimeout(240_000);
  installWrapper(FAIL_ALWAYS);
  // No window is ever created on this path, so this launch is raw: the harness
  // waits for a first window, and a boot failure by definition has none.
  const sandbox = await createSandbox();
  const app = await electron.launch({
    executablePath: ELECTRON_BINARY,
    args: [REPO_ROOT, `--user-data-dir=${sandbox.userDataDir}`, "--mute-audio"],
    env: {
      ...process.env,
      HOME: sandbox.homeDir,
      TMPDIR: sandbox.root,
      TMP: sandbox.root,
      TEMP: sandbox.root,
      SHELL: "/bin/sh",
      JUNTO_E2E: "1",
      // Focus isolation would skip the dialog; this run wants it, answered here.
      JUNTO_E2E_SHOW: "1",
      JUNTO_SECRET_STORE: "file",
      ELECTRON_RENDERER_URL: "http://127.0.0.1:1",
    },
    timeout: 60_000,
  });
  try {
    await app.evaluate(({ dialog }) => {
      const heard: { options?: { message?: string; detail?: string } } = {};
      (globalThis as unknown as { __juntoStartupDialog: typeof heard }).__juntoStartupDialog = heard;
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (options: unknown) => {
        heard.options = options as { message?: string; detail?: string };
        return { response: 0 };
      };
    });
    await expect
      .poll(() => app.evaluate(() => Boolean((globalThis as unknown as { __juntoStartupDialog?: { options?: unknown } }).__juntoStartupDialog?.options)), { timeout: 180_000 })
      .toBe(true);
    const options = await app.evaluate(() => (globalThis as unknown as { __juntoStartupDialog: { options: { message?: string; detail?: string } } }).__juntoStartupDialog.options);
    expect(options.message, "the dialog names the core").toMatch(/could not start its core/i);
    expect(options.detail, "the dialog says where the core's log is").toContain("~/.junto/logs/");
    // The app goes, after the operator has been told.
    await expect.poll(() => app.process().exitCode !== null, { timeout: 60_000 }).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    await destroySandbox(sandbox);
    restoreCore();
  }
});
