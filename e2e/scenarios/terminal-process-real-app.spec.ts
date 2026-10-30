/**
 * Real app with JUNTO_TERMINAL_PROCESS=1 (protect the main thread, 0.11.7):
 * the shell runs under the Junto Terminals utility process, never main, and
 * its view types and echoes over its surface port. Each check is reported on
 * its own:
 *   - the shell's parent is the terminal process;
 *   - a key typed while main's event loop is held echoes before main is free
 *     (the control launch, flag off, echoes only after: the check can tell);
 *   - a view hidden past the grace parks; shown again it catches up, every
 *     line in order, and still types over its port;
 *   - a second view takes control: the first says so, the second's keys land;
 *   - Stop process, then Reopen: a new shell, still under the terminal process;
 *   - quit drains: the shell and the terminal process are gone after close.
 *   bun run test:e2e:fast e2e/scenarios/terminal-process-real-app.spec.ts
 */
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import { modelFixture, modelTerminal } from "../harness/model";
import { terminalRows } from "../harness/term-ready";

const CANVAS = "terminal-process-real-app";
const BINDING = "local:terminal-process-real-app";
const SURFACE = ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface";
const HOLD_MS = 1_500;

type Result = { row: string; pass: boolean; detail?: string };

const parentOf = (pid: number): { readonly ppid: number; readonly command: string } | undefined => {
  try {
    const line = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const match = /^(\d+)\s+(.*)$/u.exec(line);
    return match ? { ppid: Number(match[1]), command: match[2]! } : undefined;
  } catch {
    return undefined;
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const launch = (terminalProcess: boolean): Promise<JuntoHandle> =>
  launchJunto({
    windowContentSize: { width: 1400, height: 880 },
    // Main refuses to start with the core in its own process and the terminals
    // in main, so the control turns both off.
    extraEnv: terminalProcess ? { JUNTO_TERMINAL_PROCESS: "1" } : { JUNTO_TERMINAL_PROCESS: "0", JUNTO_CORE_PROCESS: "0" },
    seedModels: { [CANVAS]: modelFixture([modelTerminal({ id: "term", bindingId: BINDING, label: "Shell", x: 520, y: 60 })]) },
  });

const has = async (page: Page, row: string): Promise<boolean> => (await terminalRows(page, BINDING)).some((r) => r.trim() === row);

const type = async (page: Page, line: string): Promise<void> => {
  await page.locator(SURFACE).locator(".xterm-screen").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
};

/** The shell's pid, as it says it. */
const shellPid = async (page: Page, tag: string): Promise<number> => {
  await type(page, `echo ${tag}-$$`);
  let pid = 0;
  await expect.poll(async () => {
    const row = (await terminalRows(page, BINDING)).map((r) => r.trim()).find((r) => new RegExp(`^${tag}-\\d+$`, "u").test(r));
    pid = row === undefined ? 0 : Number(row.slice(tag.length + 1));
    return pid;
  }, { timeout: 15_000 }).toBeGreaterThan(0);
  return pid;
};

/**
 * Main busy-loops HOLD_MS from a moment just ahead; the view's own keys are
 * put into xterm inside the hold, from the renderer, so nothing on the way
 * in waits on main. Answers when the echo was on screen, against the hold.
 */
const echoUnderHold = async (junto: JuntoHandle, tag: string): Promise<{ readonly echoAt: number; readonly start: number; readonly end: number }> => {
  const { start, end } = await junto.app.evaluate((_electron, holdMs) => {
    const begin = Date.now() + 400;
    setTimeout(() => {
      const until = begin + holdMs;
      while (Date.now() < until) { /* hold main's loop */ }
    }, 400);
    return { start: begin, end: begin + holdMs };
  }, HOLD_MS);
  const echoAt = await junto.page.evaluate(async ({ start: from, tag: label, binding, surface }) => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    while (Date.now() < from + 200) await pause(5);
    const keys = document.querySelector(`${surface} .xterm-helper-textarea`);
    if (keys === null) return -2;
    keys.dispatchEvent(new InputEvent("input", { data: `echo ${label}-$((6*7))\r`, inputType: "insertText", bubbles: true }));
    const read = (window as unknown as { __juntoTermScreenText?: Map<string, () => string> }).__juntoTermScreenText?.get(binding);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (read?.().split("\n").some((row) => row.replace(/ /gu, " ").trim() === `${label}-42`)) return Date.now();
      await pause(5);
    }
    return -1;
  }, { start, tag, binding: BINDING, surface: SURFACE });
  return { echoAt, start, end };
};

const openView = async (page: Page): Promise<void> => {
  await page.locator('.react-flow__node[data-id="term"]').dblclick();
  await expect(page.locator(SURFACE)).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await terminalRows(page, BINDING)).some((r) => r.trim() !== ""), { timeout: 30_000 }).toBe(true);
};

const closeView = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Close view" }).first().click();
  await expect(page.locator(".native-terminal-surface:visible")).toHaveCount(0, { timeout: 10_000 });
};

test("the shell runs in the terminal process and its view types over the port through park, takeover, restart and quit", async () => {
  test.setTimeout(300_000);
  const junto = await launch(true);
  const results: Result[] = [];
  const check = async (row: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 5).join(" ") });
    }
  };
  let shells: number[] = [];
  let terminalHost: number | undefined;
  let closed = false;
  try {
    const { page } = junto;
    const mainPid = await junto.app.evaluate(() => process.pid);
    await openView(page);

    const first = await shellPid(page, "pid");
    shells.push(first);
    const parent = parentOf(first);
    terminalHost = parent?.ppid;
    console.log("TP-PARENT", JSON.stringify({ mainPid, shell: first, parent }));
    await check("the shell's parent is the terminal process, not main", () => {
      expect(parent, "the shell's parent row").toBeDefined();
      expect(parent!.ppid).not.toBe(mainPid);
      expect(parentOf(parent!.ppid)?.ppid, "the terminal process is main's child").toBe(mainPid);
      expect(parentOf(parent!.ppid)?.command ?? "").toContain("--type=utility");
    });

    const held = await echoUnderHold(junto, "port");
    console.log("TP-HOLD", JSON.stringify({ ...held, echoAfterStartMs: held.echoAt - held.start }));
    await check("a key typed while main is held echoes before main is free", () => {
      expect(held.echoAt, "the echo arrived").toBeGreaterThan(0);
      expect(held.echoAt).toBeLessThan(held.end);
    });

    // Park and unpark: hidden past the grace while the shell prints.
    await type(page, "clear; for i in $(seq 1 60); do echo park-$i; sleep 0.1; done; echo park-done");
    await expect.poll(() => has(page, "park-2"), { timeout: 15_000 }).toBe(true);
    await closeView(page);
    await page.waitForTimeout(4_500);
    await openView(page);
    await check("a view hidden past the grace catches up, every line in order", async () => {
      await expect.poll(() => has(page, "park-done"), { timeout: 30_000 }).toBe(true);
      const numbers = (await terminalRows(page, BINDING)).map((r) => r.trim())
        .filter((r) => r.startsWith("park-") && r !== "park-done").map((r) => Number(r.slice(5)));
      expect(numbers.at(-1), JSON.stringify(numbers.slice(-6))).toBe(60);
      for (let at = 1; at < numbers.length; at += 1) expect(numbers[at], JSON.stringify(numbers)).toBe(numbers[at - 1]! + 1);
    });
    const unparked = await echoUnderHold(junto, "unparked");
    console.log("TP-HOLD-UNPARKED", JSON.stringify(unparked));
    await check("shown again, it still types over its port", () => {
      expect(unparked.echoAt).toBeGreaterThan(0);
      expect(unparked.echoAt).toBeLessThan(unparked.end);
    });

    // Takeover: a second control view of the same seat, as a view attaches.
    const second = await page.evaluate(async (bindingId) => {
      const answer = await window.junto!.terminalAttach({ bindingId, mode: "control", takeover: true, surface: true } as never);
      const find = (value: unknown): string | undefined => {
        if (value === null || typeof value !== "object") return undefined;
        const record = value as Record<string, unknown>;
        if (typeof record.leaseId === "string") return record.leaseId;
        for (const inner of Object.values(record)) {
          const found = find(inner);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      return find(answer);
    }, BINDING);
    console.log("TP-TAKEOVER", JSON.stringify({ second }));
    await check("the first view says another view has control", () =>
      expect(page.locator(SURFACE).getByText("Another view has control of this seat", { exact: false })).toBeVisible({ timeout: 10_000 }));
    await check("the second view's keys reach the shell", async () => {
      expect(second, "the second lease").toBeDefined();
      await page.evaluate(([leaseId]) => window.junto!.terminalWrite(leaseId!, "echo second-$((6*8))\r"), [second] as const);
      await expect.poll(async () => {
        const text = await page.evaluate((binding) =>
          (window as unknown as { __juntoTermTranscriptText?: Map<string, () => string> }).__juntoTermTranscriptText?.get(binding)?.() ?? "", BINDING);
        // The first view no longer controls, but it still shows the screen.
        return text.includes("second-48");
      }, { timeout: 10_000 }).toBe(true);
    });
    if (second !== undefined) await page.evaluate((leaseId) => window.junto!.terminalRelease(leaseId), second);

    // Reopen takes control back; then Stop process and Reopen.
    await closeView(page);
    await openView(page);
    const surface = page.locator(SURFACE);
    await surface.getByRole("button", { name: "Stop this terminal's process", exact: true }).click();
    await surface.getByRole("button", { name: "Confirm: stop this terminal's process", exact: true }).click();
    await check("Stop process ends the shell", async () => {
      await expect(surface.getByText("Process stopped")).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => alive(first), { timeout: 15_000 }).toBe(false);
    });
    await surface.getByRole("button", { name: "Reopen" }).first().click();
    await expect(page.locator(SURFACE)).toBeVisible({ timeout: 30_000 });
    const restarted = await shellPid(page, "again");
    shells.push(restarted);
    const restartedParent = parentOf(restarted);
    console.log("TP-RESTART", JSON.stringify({ restarted, restartedParent }));
    await check("Reopen starts a new shell, under the terminal process", () => {
      expect(restarted).not.toBe(first);
      expect(restartedParent?.ppid).not.toBe(mainPid);
      expect(parentOf(restartedParent!.ppid)?.command ?? "").toContain("--type=utility");
    });
    terminalHost = restartedParent?.ppid ?? terminalHost;
    const after = await echoUnderHold(junto, "restarted");
    console.log("TP-HOLD-RESTARTED", JSON.stringify(after));
    await check("the restarted shell types over its port", () => {
      expect(after.echoAt).toBeGreaterThan(0);
      expect(after.echoAt).toBeLessThan(after.end);
    });

    // Quit drain.
    await junto.close();
    closed = true;
    await check("quit drains: the shell and the terminal process are gone", async () => {
      await expect.poll(() => shells.filter(alive), { timeout: 15_000 }).toEqual([]);
      if (terminalHost !== undefined) await expect.poll(() => alive(terminalHost!), { timeout: 15_000 }).toBe(false);
    });
  } finally {
    console.log("TP", JSON.stringify(results));
    if (!closed) await junto.close();
    shells = [];
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});

test("control: with the flag off, a key typed while main is held echoes only after", async () => {
  test.setTimeout(120_000);
  const junto = await launch(false);
  try {
    await openView(junto.page);
    const held = await echoUnderHold(junto, "ipc");
    console.log("TP-CONTROL", JSON.stringify({ ...held, echoAfterEndMs: held.echoAt - held.end }));
    expect(held.echoAt, "the echo arrived").toBeGreaterThan(0);
    expect(held.echoAt).toBeGreaterThanOrEqual(held.end);
  } finally {
    await junto.close();
  }
});
