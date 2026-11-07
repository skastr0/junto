/**
 * Real app: a work socket path over the Unix limit must refuse with a dialog
 * naming the path and the limit, not quit silently.
 *
 * The core's work socket is `<home>/.junto/work/control.sock`. The
 * platform's `sockaddr_un.sun_path` limit (104 bytes on macOS, 108 on Linux,
 * the trailing NUL included) is the app's own, so this launch uses a
 * deliberately long sandbox home and expects that limit in the dialog. The
 * dialog copy is written to a probe file and held until this spec releases
 * it: the failure is immediate, before any window exists, and a native dialog
 * would race the harness.
 *
 * Run through `scripts/run-e2e.sh` under the app-run lock.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { _electron as electron } from "playwright-core";
import { expect, test } from "../harness/launch";
import { inheritedEnvForLaunch } from "../harness/launch-env";
import { createSandbox, destroySandbox } from "../harness/sandbox";
import { unixSocketPathLimit } from "../../src/node/work/socket-path";

const ELECTRON_BINARY = createRequire(import.meta.url)("electron") as string;
const REPO_ROOT = process.cwd();

test("a work socket path over the Unix limit shows the startup dialog, then quits", async () => {
  test.setTimeout(120_000);
  const sandbox = await createSandbox({ longHome: true });
  const socket = join(sandbox.homeDir, ".junto", "work", "control.sock");
  const probe = join(sandbox.root, "startup-dialog.json");
  const release = join(sandbox.root, "startup-dialog.release");
  const limit = unixSocketPathLimit();
  expect(Buffer.byteLength(socket, "utf8"), "the fixture must exceed the limit").toBeGreaterThan(limit);

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
      JUNTO_E2E_SHOW: "1",
      JUNTO_E2E_STARTUP_DIALOG_FILE: probe,
      JUNTO_E2E_STARTUP_DIALOG_RELEASE: release,
      JUNTO_SECRET_STORE: "file",
      ELECTRON_RENDERER_URL: "http://127.0.0.1:1",
    },
    timeout: 60_000,
  });
  const exited = (): boolean => {
    try {
      return app.process().exitCode !== null;
    } catch {
      return true;
    }
  };
  try {
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(probe, "utf8")) as unknown;
        } catch {
          return undefined;
        }
      }, { timeout: 60_000 })
      .toBeTruthy();
    const dialog = JSON.parse(readFileSync(probe, "utf8")) as {
      readonly title: string;
      readonly message: string;
      readonly detail: string;
      readonly buttons: readonly string[];
    };
    expect(dialog.title).toBe("Could not start");
    expect(dialog.message).toMatch(/work socket/i);
    expect(dialog.detail).toContain(socket);
    expect(dialog.detail).toContain(`${limit}-byte limit`);
    expect(dialog.detail).toMatch(/shorter path/i);
    expect(dialog.buttons).toEqual(["Quit"]);

    writeFileSync(release, "1");
    await expect.poll(exited, { timeout: 60_000 }).toBe(true);
  } finally {
    if (!exited()) await app.close().catch(() => undefined);
    await destroySandbox(sandbox);
  }
});
