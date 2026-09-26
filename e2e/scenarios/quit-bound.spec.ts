/**
 * Quit bound: a fresh Junto quits cleanly, and quickly, when asked.
 *
 * Every e2e and the installer's soft quit rely on the app leaving on its own
 * once asked. This launches a fresh station, waits for the canvas, and times
 * Playwright's own close (app.quit, then the inspector lets go) against
 * QUIT_BOUND_MS. Everything main prints from the first `[quit]` phase on is
 * kept and printed, so a stuck phase names itself; when every phase is done
 * and `will-quit` is the last line, the stall is below Junto (Electron's
 * native teardown), not in the quit sequence.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright-core";
import { expect, launchJunto, test } from "../harness/launch";

const QUIT_BOUND_MS = 15_000;

/** Close an app and wait for its process to leave, or report the bound. */
const quitWithin = async (
  close: () => Promise<void>,
  child: import("node:child_process").ChildProcess,
): Promise<{ readonly exited: boolean; readonly ms: number }> => {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  const asked = Date.now();
  return Promise.race([
    Promise.all([close(), exited]).then(() => ({ exited: true, ms: Date.now() - asked })),
    new Promise<{ exited: boolean; ms: number }>((resolve) =>
      setTimeout(() => resolve({ exited: false, ms: QUIT_BOUND_MS }), QUIT_BOUND_MS),
    ),
  ]);
};

// Control: when a bare Electron window cannot quit either, the machine is
// wedged below Electron and the Junto result below says nothing about Junto.
test("control: a bare Electron window quits within the bound", async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), "junto-quit-control-"));
  const app = await electron.launch({
    args: [join(process.cwd(), "e2e/fakes/bare-electron"), `--user-data-dir=${userData}`],
  });
  const child = app.process();
  try {
    await app.firstWindow();
    const outcome = await quitWithin(() => app.close(), child);
    expect(outcome.exited, "a bare Electron window did not quit: the machine, not Junto").toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(userData, { recursive: true, force: true });
  }
});

test("a fresh station quits within the bound", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({});
  const lines: string[] = [];
  let quitting = false;
  const keep = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.includes("[quit]")) quitting = true;
      // From the first quit phase on, keep everything main says.
      if (quitting && line.trim() !== "") lines.push(line.trim().slice(0, 300));
    }
  };
  const child = junto.app.process();
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let closed = false;
  try {
    await expect(junto.page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const outcome = await quitWithin(() => junto.app.close(), child);
    closed = outcome.exited;
    console.log(`quit ${outcome.exited ? "exited" : "still running"} after ${String(outcome.ms)}ms\n${lines.join("\n")}`);
    expect(outcome.exited, `quit phases:\n${lines.join("\n")}`).toBe(true);
  } finally {
    // The harness proves termination and removes the sandbox either way.
    if (!closed) await junto.close();
    else await junto.close().catch(() => undefined);
  }
});
