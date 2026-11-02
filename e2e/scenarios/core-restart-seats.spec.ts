/**
 * Real app: a running seat keeps its terminal across a core crash [fake-tui].
 *
 * A PTY lives in the Junto terminal process, not in the core, so a SIGKILL of
 * the core must not reach an agent: the next core adopts every PTY the
 * terminal process kept (`pty.adopt`), rebuilds each seat's session from the
 * meta its spawn carried, publishes the generation credential the running
 * seat still presents, seeds the journal and headless grid from the output the
 * old core had handled, and lets windows re-attach.
 *
 * The contract, measured before and after the kill:
 *   1. the seat keeps its process — same pid, alive
 *   2. its `junto` CLI reaches the new core (the credential is admitted)
 *   3. typing reaches its PTY
 *   4. its state reaches the window
 *   5. mail sent after the restart is typed into it
 *   6. nothing it printed is lost: what the old core handled is on screen
 *      again after the view is reopened, and what it printed while no core
 *      ran arrives after the adoption
 *
 * A PTY the adoption cannot claim is part of the contract too, and the host
 * holds it: one whose spawn meta this build cannot read, or whose binding the
 * new core already has, is left running with a warning (never hung up on a
 * guess). Reconcile then reports that seat gone while its process still runs —
 * a core that cannot name a terminal must not claim it — and an orderly quit's
 * `pty.hangupAll` is what reaches it. This app run cannot plant such a meta;
 * the host-level contract is in local-host.test.ts.
 *
 *   bun run cli:build && bun run test:e2e:fast e2e/scenarios/core-restart-seats.spec.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
  installCrewSeatHarness,
  type CrewSeat,
} from "../harness/crew-fixture";
import { crashCoreNow } from "../harness/crash-core";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelMessagesWire, modelSeat } from "../harness/model";

const CANVAS = "corerestartseats";
const SENDER = modelSeat({ id: "sender", label: "Sender", x: 160, y: 40 });
const OVERSEER = modelSeat({ id: "overseer", label: "Overseer", x: 480, y: 40 });
const SURFACE = ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const coreLog = (dir: string): string => {
  try {
    return readdirSync(dir)
      .sort()
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
};

const pidsIn = (log: string): ReadonlyArray<number> =>
  [...log.matchAll(/\[core\] pid (\d+)/gu)].map((match) => Number(match[1]));

/** A process is there if signal 0 is admitted; ESRCH means it is gone. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The whole visible buffer of every open terminal (WebGL paints no DOM text). */
const transcriptText = (page: import("@playwright/test").Page): Promise<string> =>
  page.evaluate(() => {
    const registry = (window as unknown as { __juntoTermTranscriptText?: Map<string, () => string> })
      .__juntoTermTranscriptText;
    return registry ? Array.from(registry.values(), (read) => read()).join("\n") : "";
  });

const squash = (text: string): string => text.replace(/\s+/gu, "");

/** The seat's live session as the window reads it: status, pid and epoch. */
const sessionOf = (page: import("@playwright/test").Page, nodeId: string) =>
  page
    .evaluate((bindingId) => window.junto!.terminalGet(bindingId), `local:${nodeId}`)
    .catch(() => undefined);

const seatStateOf = (page: import("@playwright/test").Page, nodeId: string): Promise<string> =>
  page.evaluate(async (bindingId) => {
    const events = await window.junto!.agentSeatStateSnapshot();
    const list = Array.isArray(events) ? events : [];
    return list.find((event) => (event as { bindingId?: string }).bindingId === bindingId)?.state ?? "none";
  }, `local:${nodeId}`);

const workOp = async (seat: CrewSeat, op: string, args?: unknown): Promise<boolean> =>
  seat.op(op, args, { awaitMs: 20_000 }).then((answer) => answer.ok, () => false);

const cliPing = async (seat: CrewSeat): Promise<{ ok: boolean; exitCode: number; stderr: string }> =>
  seat.cli(["ping"], { awaitMs: 20_000 }).then(
    (result) => ({ ok: result.ok, exitCode: result.exitCode, stderr: result.stderr.slice(0, 240) }),
    (error: unknown) => ({ ok: false, exitCode: -1, stderr: String(error) }),
  );

test("a running seat keeps its terminal across a core crash", async () => {
  test.setTimeout(300_000);
  mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
  const logDir = mkdtempSync(join(process.cwd(), "test-results", "core-restart-seats-"));
  process.env.JUNTO_E2E_MAIN_LOG = logDir;
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 880 },
    seedModels: {
      [CANVAS]: modelFixture(
        [SENDER, OVERSEER],
        [modelMessagesWire("sender-messages-overseer", SENDER.id, OVERSEER.id, [SENDER, OVERSEER])],
      ),
    },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="overseer"]')).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const sender = crewSeat(junto.sandbox, CANVAS, SENDER.id);
    const seat = crewSeat(junto.sandbox, CANVAS, OVERSEER.id);
    await crewOccupySeat(page, CANVAS, SENDER, sender);
    await crewOccupySeat(page, CANVAS, OVERSEER, seat);
    // The overseer's view stays open across the kill: its surface port belongs
    // to the terminal process, and the adoption has to keep it fed.
    await page.locator('.react-flow__node[data-id="overseer"]').dblclick();
    await expect(page.locator(SURFACE)).toBeVisible({ timeout: 30_000 });
    const surface = page.locator(SURFACE);
    const terminal = surface.locator(".xterm").first();
    await expect(terminal).toBeVisible({ timeout: 30_000 });

    const typeInto = async (text: string): Promise<{ grew: boolean; arrived: boolean }> => {
      const before = (await seat.stdinLog()).length;
      await terminal.click();
      await page.keyboard.type(`${text} `);
      await sleep(900);
      const stdin = await seat.stdinLog();
      return { grew: stdin.length > before, arrived: stdin.includes(text) };
    };

    const measure = async (phase: string) => {
      const session = await sessionOf(page, OVERSEER.id);
      const typed = await typeInto(`typed-${phase}`);
      await seat.print(`state-${phase}`);
      await expect
        .poll(async () => seatStateOf(page, OVERSEER.id), { message: `seat state after ${phase}`, timeout: 30_000 })
        .not.toBe("none");
      return {
        phase,
        status: session?.status,
        pid: session?.pid,
        epoch: session?.epoch,
        op: await workOp(seat, "ping"),
        cli: await cliPing(seat),
        typing: typed,
        state: await seatStateOf(page, OVERSEER.id),
      };
    };

    // A line the old core handled: after the crash only the seeded history can
    // put it back on a reopened view.
    await seat.print("before-crash-line");
    await expect
      .poll(async () => squash(await transcriptText(page)), { message: "the pre-crash line is on screen", timeout: 30_000 })
      .toContain(squash("before-crash-line"));
    const before = await measure("before");

    await page.evaluate(() => {
      const heard: { restarted: number } = { restarted: 0 };
      (window as unknown as { __restart: typeof heard }).__restart = heard;
      window.junto!.onCoreRestarted(() => { heard.restarted += 1; });
    });
    const killed = await crashCoreNow(junto, logDir);
    // Printed while no core runs: the terminal process keeps it unacknowledged
    // and the next core must deliver it, not drop it.
    await seat.print("while-no-core-line");
    await expect
      .poll(() => pidsIn(coreLog(logDir)).some((pid) => pid !== killed), { timeout: 90_000 })
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __restart: { restarted: number } }).__restart.restarted), { timeout: 150_000 })
      .toBeGreaterThan(0);

    // Mail after the restart, before anything is typed into the seat: a draft
    // holds delivery back by design, and this proof is about admission and the
    // adopted terminal, not about the draft rule. The sender's own credential
    // is admitted, and the mail reaches the running receiver's PTY.
    const MAIL = "mail-after-the-restart";
    const sent = await sender.op("msg.send", { target: OVERSEER.id, text: MAIL }, { awaitMs: 20_000 });
    await expect
      .poll(async () => seat.stdinLog(), { message: "the mail is typed into the running seat", timeout: 60_000 })
      .toContain(MAIL);

    const after = await measure("after");

    // Nothing printed is lost: the pre-crash line comes back only from the
    // seeded history, and the gap line arrives with the adopted handle.
    await expect
      .poll(async () => squash(await transcriptText(page)), { message: "the open view still shows the seat's screen", timeout: 30_000 })
      .toContain(squash("while-no-core-line"));
    // Reopen: a view attached after the crash paints the screen a new core rebuilt.
    await surface.getByRole("button", { name: "Close view" }).first().click();
    await expect(page.locator(SURFACE)).toHaveCount(0);
    await page.locator('.react-flow__node[data-id="overseer"]').dblclick();
    await expect(page.locator(SURFACE)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => squash(await transcriptText(page)), { message: "a view reopened after the crash paints the rebuilt screen", timeout: 30_000 })
      .toContain(squash("before-crash-line"));
    expect(squash(await transcriptText(page)), "the gap output is on the reopened screen").toContain(squash("while-no-core-line"));

    const seatPid = (await seat.ready()).pid;
    const report = {
      killed,
      pids: pidsIn(coreLog(logDir)),
      seatPid,
      seatAliveAfter: alive(seatPid),
      before,
      after,
      mail: { sent: sent.ok, arrived: (await seat.stdinLog()).includes(MAIL) },
      screen: squash(await transcriptText(page)).includes(squash("before-crash-line")),
    };
    writeFileSync(join(process.cwd(), "test-results", "seat-restart.json"), `${JSON.stringify(report, null, 1)}\n`);
    await test.info().attach("seat-restart.json", { body: JSON.stringify(report, null, 1), contentType: "application/json" });

    // The contract: the seat never lost its process or any way into Junto.
    expect(before.status, "the seat is running before the kill").toBe("running");
    expect(before.pid, "the core named the seat's pid before the kill").toBeGreaterThan(0);
    expect(before.op, "the seat's own socket answers before the kill").toBe(true);
    expect(before.cli, "the seat's CLI reaches the core before the kill").toMatchObject({ ok: true, exitCode: 0 });
    expect(before.typing.grew, "the seat's terminal takes keys before the kill").toBe(true);

    expect(after.status, "the seat is running after the kill").toBe("running");
    expect(after.pid, "the new core names the same pid the old one did").toBe(before.pid);
    expect(after.epoch, "the generation is the same one, not a replacement").toBe(before.epoch);
    expect(after.op, "the seat's own socket answers after the kill").toBe(true);
    expect(after.cli, "the seat's CLI reaches the new core").toMatchObject({ ok: true, exitCode: 0 });
    expect(after.typing.grew, "the seat's terminal still takes keys after the kill").toBe(true);
    expect(after.state, "the seat's state still reaches the window after the kill").not.toBe("none");
    expect(sent.ok, "a seat's mail is admitted after the restart").toBe(true);
    expect(alive(seatPid), "the seat's process outlived the core").toBe(true);
  } finally {
    await junto.close().catch(() => undefined);
  }
});
