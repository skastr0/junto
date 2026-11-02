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
 * Each launch names its own core entry (JUNTO_E2E_CORE_ENTRY, honored only in
 * an E2E run) in its throwaway sandbox. Nothing in out/ is swapped, so a spec
 * that runs after this one launches the real core whatever this one did.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright-core";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import { inheritedEnvForLaunch } from "../harness/launch-env";
import { createSandbox, destroySandbox, type Sandbox } from "../harness/sandbox";
import { modelFixture, modelSeat } from "../harness/model";

type StartupDialogProbe = {
  options?: { message?: string; detail?: string };
  release?: () => void;
};

const ELECTRON_BINARY = createRequire(import.meta.url)("electron") as string;
const REPO_ROOT = process.cwd();
const REAL_CORE = pathToFileURL(join(REPO_ROOT, "out", "main", "core-process.js")).href;

const CANVAS = "corebootfailure";
const O = modelSeat({ id: "overseer", label: "Overseer", x: 480, y: 40 });

/**
 * A core entry in the launch's own sandbox. `once` exits 1 on the first fork
 * and then runs the real core; `always` never starts and exits 1 after a
 * moment, so the harness can watch the dialog first.
 */
const failingCoreEntry = (sandbox: Sandbox, mode: "once" | "always"): string => {
  const entry = join(sandbox.root, `core-process-${mode}.mjs`);
  const body = mode === "once"
    ? `
import fs from "node:fs";
import path from "node:path";

const marker = path.join(import.meta.dirname, ".core-failed-once");
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, "1");
  process.exit(1);
}
await import(${JSON.stringify(REAL_CORE)});
`
    : `
setTimeout(() => { process.exit(1); }, 3000);
`;
  writeFileSync(entry, body);
  return entry;
};

test("a core that fails once is retried and the window still opens", async () => {
  test.setTimeout(180_000);
  const sandbox = await createSandbox();
  const entry = failingCoreEntry(sandbox, "once");
  let junto: JuntoHandle | undefined;
  try {
    junto = await launchJunto({
      sandbox,
      windowContentSize: { width: 1400, height: 880 },
      seedModels: { [CANVAS]: modelFixture([O]) },
      extraEnv: { JUNTO_E2E_CORE_ENTRY: entry },
    });
    await expect(junto.page.locator('.react-flow__node[data-id="overseer"]')).toBeVisible({ timeout: 90_000 });
  } finally {
    await junto?.close().catch(() => undefined);
    await destroySandbox(sandbox);
  }
});

test("a core that never starts shows the startup dialog, then quits", async () => {
  test.setTimeout(240_000);
  const sandbox = await createSandbox();
  const entry = failingCoreEntry(sandbox, "always");
  // No window is ever created on this path, so this launch is raw: the harness
  // waits for a first window, and a boot failure by definition has none.
  const app = await electron.launch({
    executablePath: ELECTRON_BINARY,
    args: [REPO_ROOT, `--user-data-dir=${sandbox.userDataDir}`, "--mute-audio"],
    env: {
      // A seat runs this spec: none of its JUNTO_* variables may reach the app.
      ...inheritedEnvForLaunch(process.env),
      HOME: sandbox.homeDir,
      TMPDIR: sandbox.root,
      TMP: sandbox.root,
      TEMP: sandbox.root,
      SHELL: "/bin/sh",
      JUNTO_E2E: "1",
      // Focus isolation would skip the dialog; this run wants it, answered here.
      JUNTO_E2E_SHOW: "1",
      JUNTO_E2E_CORE_ENTRY: entry,
      JUNTO_SECRET_STORE: "file",
      ELECTRON_RENDERER_URL: "http://127.0.0.1:1",
    },
    timeout: 60_000,
  });
  const exited = (): boolean => {
    try {
      return app.process().exitCode !== null;
    } catch {
      // Playwright has already let the application object go.
      return true;
    }
  };
  try {
    // The dialog is held open until the test has read it: the app quits the
    // moment the operator answers, and a connection to it would go away.
    await app.evaluate(({ dialog }) => {
      const probe = {} as StartupDialogProbe;
      (globalThis as unknown as { __juntoStartupDialog: StartupDialogProbe }).__juntoStartupDialog = probe;
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (options: StartupDialogProbe["options"]) => {
        probe.options = options;
        await new Promise<void>((resolve) => {
          probe.release = resolve;
        });
        return { response: 0 };
      };
    });
    await expect
      .poll(() => app.evaluate(() => Boolean((globalThis as unknown as { __juntoStartupDialog?: StartupDialogProbe }).__juntoStartupDialog?.options)), { timeout: 180_000 })
      .toBe(true);
    const options = await app.evaluate(() => (globalThis as unknown as { __juntoStartupDialog: StartupDialogProbe }).__juntoStartupDialog.options);
    expect(options?.message, "the dialog names the core").toMatch(/could not start its core/i);
    expect(options?.detail, "the dialog says where the core's log is").toContain("~/.junto/logs/");
    // Answering Quit lets the app go, after the operator has been told.
    await app.evaluate(() => (globalThis as unknown as { __juntoStartupDialog: StartupDialogProbe }).__juntoStartupDialog.release?.());
    await expect.poll(exited, { timeout: 60_000 }).toBe(true);
  } finally {
    if (!exited()) await app.close().catch(() => undefined);
    await destroySandbox(sandbox);
  }
});
