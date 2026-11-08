/**
 * A seat that is not running says "fresh next" when its next turn starts
 * fresh, and nothing more when it continues. Three codex seats
 * in a sandboxed home: one with a captured session codex still holds on disk,
 * one offboarded with rest, one never started. The fake codex only records its
 * argv and stays up, so no model is reached. Frames land in
 * test-results/seat-next-launch/.
 *   bun run test:e2e:fast e2e/scenarios/seat-next-launch.spec.ts
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { modelFixture, modelSeat, modelSeatSession } from "../harness/model";
import { offboardNowFromPanel } from "../harness/offboard-panel";
import { readSeatSession } from "../harness/seat-session";
import { terminalRows } from "../harness/term-ready";
import { expect, launchJunto, test } from "../harness/launch";
import { writeFixtureOffboardClock } from "../harness/sandbox";

const CANVAS = "seat-next-launch";
const HELD = "0198f2a1-0000-7000-8000-000000000001";
const RESTED = "0198f2a1-0000-7000-8000-000000000002";

const seat = (id: string, label: string, x: number) =>
  modelSeat({ id, label, harness: "codex", cwd: "/tmp", x });
const holds = seat("holds", "holds", 40);
const rested = seat("rested", "rested", 340);
const fresh = seat("fresh", "fresh", 640);

const rollout = (home: string, id: string) =>
  writeFile(
    join(home, ".codex", "sessions", "2026", "10", "17", `rollout-2026-10-17T00-00-00-${id}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/tmp", timestamp: "2026-10-17T00:00:00.000Z", thread_source: "user" } })}\n`,
  );

const line = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

test("a seat that is not running says fresh next only when its next turn starts fresh", async () => {
  test.setTimeout(180_000);
  let argvLog = "";
  const junto = await launchJunto({
    seedModels: {
      [CANVAS]: modelFixture([holds, rested, fresh], [], [modelSeatSession(holds, HELD), modelSeatSession(rested, RESTED)]),
    },
    seedHarnessInstalls: ["codex"],
    afterSeed: async (sandbox) => {
      argvLog = join(sandbox.homeDir, "codex-argv.log");
      const fake = join(seededHarnessBinDir(sandbox), "codex");
      await writeFile(fake, `#!/bin/sh\necho "$JUNTO_NODE_REF $*" >> '${argvLog}'\nexec sleep 3600\n`);
      await chmod(fake, 0o755);
      await mkdir(join(sandbox.homeDir, ".codex", "sessions", "2026", "10", "17"), { recursive: true });
      await rollout(sandbox.homeDir, HELD);
      await rollout(sandbox.homeDir, RESTED);
    },
  });
  try {
    const { page, sandbox } = junto;
    await expect(line(page, "holds")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /fit all/i }).first().click();

    await expect(line(page, "fresh")).toContainText("fresh next", { timeout: 20_000 });
    await expect(line(page, "holds")).toContainText("not running");
    await expect(line(page, "holds")).not.toContainText("fresh next");
    await expect(line(page, "rested")).not.toContainText("fresh next");

    // Offboard the third seat with rest: its session closes at an offboard.
    await offboardNowFromPanel(page, "rested");
    await expect(line(page, "rested")).toContainText("fresh next", { timeout: 20_000 });

    // A start takes the same path as a ping: the held seat resumes its session.
    expect(readSeatSession(sandbox, "holds", holds.bindingId)).toBe(HELD);
    await page.evaluate(() => window.junto!.modelStart({ canvas: "seat-next-launch", id: "holds" }));
    await expect.poll(async () => (await readFile(argvLog, "utf8").catch(() => "")), { timeout: 30_000 }).toContain(HELD);
    expect(readSeatSession(sandbox, "holds", holds.bindingId)).toBe(HELD);

    // The offboarded seat starts a new session: the closed id is not passed.
    await page.evaluate(() => window.junto!.modelStart({ canvas: "seat-next-launch", id: "rested" }));
    await expect.poll(async () => (await readFile(argvLog, "utf8")).split("\n").filter((l) => l.includes("rested")).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const restedStart = (await readFile(argvLog, "utf8")).split("\n").find((l) => l.includes("rested")) ?? "";
    expect(restedStart).not.toContain(RESTED);
    await page.waitForTimeout(500);
  } finally {
    await junto.close();
  }
});

/**
 * The cut's threshold is each harness's own cache window, and the card says
 * so at that window. Two seats that are not running, each holding a session
 * that has worked 31 minutes and sat still for 10 (the motion clock is seeded
 * on disk, so no product time passes): a codex seat and a claude seat. The
 * installation's window is 60 minutes, so both continue. A codex window of 5
 * set in Settings turns the codex card to "fresh next" and leaves the claude
 * card as it was; a codex window of 15 keeps it continuing until 15 minutes
 * after it last moved; removing the window puts it back.
 */
const SHORT = "0198f2a1-0000-7000-8000-000000000003";
const LONG = "0198f2a1-0000-7000-8000-000000000004";
const short = seat("short", "short", 40);
const long = modelSeat({ id: "long", label: "long", harness: "claude", cwd: "/tmp", x: 340 });
const STILL_MS = 10 * 60_000;
const WORKED_MS = 31 * 60_000;

test("a seat whose harness has a shorter cache window says fresh next at its own window", async () => {
  test.setTimeout(180_000);
  const movedAt = Date.now() - STILL_MS;
  const junto = await launchJunto({
    seedModels: {
      [CANVAS]: modelFixture([short, long], [], [modelSeatSession(short, SHORT), modelSeatSession(long, LONG)]),
    },
    seedHarnessInstalls: ["codex", "claude"],
    afterSeed: async (sandbox) => {
      await mkdir(join(sandbox.homeDir, ".codex", "sessions", "2026", "10", "17"), { recursive: true });
      await rollout(sandbox.homeDir, SHORT);
      // Claude keeps a session at ~/.claude/projects/<cwd, slashes as dashes>/<id>.jsonl.
      await mkdir(join(sandbox.homeDir, ".claude", "projects", "-tmp"), { recursive: true });
      await writeFile(join(sandbox.homeDir, ".claude", "projects", "-tmp", `${LONG}.jsonl`), "{}\n");
      // The clock as Junto saves it: both seats still since `movedAt`, each with a session worth cutting.
      await writeFixtureOffboardClock(sandbox, {
        savedAt: movedAt,
        seats: {
          [short.bindingId]: { idleSince: movedAt, workMs: WORKED_MS, sessionId: SHORT },
          [long.bindingId]: { idleSince: movedAt, workMs: WORKED_MS, sessionId: LONG },
        },
      });
    },
  });
  try {
    const { page } = junto;
    const setCodexWindow = async (minutes: number | null) => {
      // Settings, Cache window, under this machine: a row per harness it has, each with a switch.
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.getByRole("button", { name: "Cache window", exact: true }).click();
      const section = page.getByTestId("offboard-settings");
      await expect(section).toBeVisible({ timeout: 10_000 });
      const row = section.getByTestId("offboard-harness-codex");
      await expect(row).toBeVisible({ timeout: 10_000 });
      const own = row.getByRole("switch", { name: "Codex has its own window" });
      const field = row.getByLabel("Codex cache window, minutes");
      if (minutes === null) {
        await own.click();
        await expect(field).toHaveCount(0, { timeout: 10_000 });
        await expect
          .poll(async () => (await page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard))?.harness?.codex, { timeout: 10_000 })
          .toBeUndefined();
      } else {
        if ((await field.count()) === 0) {
          await own.click();
          await expect(field).toBeVisible({ timeout: 10_000 });
        }
        await field.click();
        await field.fill(String(minutes));
        await field.press("Tab");
        await expect
          .poll(async () => (await page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard))?.harness?.codex?.cacheWindowMinutes, { timeout: 10_000 })
          .toBe(minutes);
      }
      await page.getByRole("button", { name: "Close settings" }).click();
      await page.getByRole("button", { name: /fit all/i }).first().click();
    };

    await expect(line(page, "short")).toBeVisible({ timeout: 30_000 });
    // The auto mode: an open starts a cold session fresh. The default, hybrid,
    // resumes whatever the operator opens, so its card never says when.
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("button", { name: "Cache window", exact: true }).click();
    const auto = page.getByRole("radiogroup", { name: "Cache mode" }).getByRole("radio", { name: /^Auto/ });
    await auto.click();
    await expect(auto).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: /fit all/i }).first().click();

    // The installation's window, 60 minutes: both sessions are still warm and both resume.
    for (const id of ["short", "long"]) {
      await expect(line(page, id)).toContainText("not running");
      await expect(line(page, id)).not.toContainText("fresh next");
    }

    // Codex's own window, 5 minutes: the codex session has been still past it.
    await setCodexWindow(5);
    await expect(line(page, "short")).toContainText("fresh next", { timeout: 20_000 });
    await expect(line(page, "long")).not.toContainText("fresh next");
    await page.mouse.move(4, 600);

    // 15 minutes: still warm.
    await setCodexWindow(15);
    await expect(line(page, "short")).not.toContainText("fresh next", { timeout: 20_000 });

    // No window of its own: codex follows the installation's again.
    await setCodexWindow(null);
    await expect(line(page, "short")).not.toContainText("fresh next");
  } finally {
    await junto.close();
  }
});

/**
 * A running seat at rest (T1, T2). Five fake codex seats, each on a session
 * that worked 31 minutes and came to rest 10 minutes ago (the clock is seeded
 * on disk; a start leaves it there). They start under the machine's 60
 * minute window, so the wake cuts nothing, and the window then drops to 5:
 *   rests   idle, nothing holds it: fresh next (cut at the minute pass or not)
 *   viewed  its terminal is shown here: nothing, then fresh next once closed
 *   typed   a key, then closed: nothing, and main names the moment a window
 *           after the key, which warms it as a turn does (the card's timer at
 *           that moment is held by tests/seat-fresh-next-timer.test.tsx; no
 *           test waits it out)
 *   dialog  on a dialog, needs you: nothing
 *   raised  its agent ran junto blocked: nothing
 */
const RUNNING = ["rests", "viewed", "typed", "dialog", "raised"] as const;
const runningSeat = (id: string, i: number) =>
  modelSeat({ id, label: id, harness: "codex", cwd: "/tmp", x: 40 + (i % 3) * 300, y: 40 + Math.floor(i / 3) * 200 });
const runningSessionOf = (i: number) => `0198f2a1-0000-7000-8000-00000000001${String(i)}`;

test("a running seat at rest says fresh next past its window, and not while held, blocked or waiting on you", async () => {
  test.setTimeout(240_000);
  const seats = RUNNING.map(runningSeat);
  const restedAt = Date.now() - STILL_MS;
  const junto = await launchJunto({
    seedModels: {
      [CANVAS]: modelFixture(seats, [], seats.map((node, i) => modelSeatSession(node, runningSessionOf(i)))),
    },
    afterSeed: async (sandbox) => {
      await installCrewSeatHarness(sandbox);
      await mkdir(join(sandbox.homeDir, ".codex", "sessions", "2026", "10", "17"), { recursive: true });
      for (const i of seats.keys()) await rollout(sandbox.homeDir, runningSessionOf(i));
      await writeFixtureOffboardClock(sandbox, {
        savedAt: restedAt,
        seats: Object.fromEntries(seats.map((node, i) => [node.bindingId, {
          activitySince: restedAt - WORKED_MS, idleSince: restedAt, workMs: WORKED_MS, sessionId: runningSessionOf(i),
        }])),
      });
    },
  });
  try {
    const { page, sandbox } = junto;
    const seatState = async (id: string) =>
      ((await page.evaluate(() => window.junto!.agentSeatStateSnapshot())) as ReadonlyArray<{ bindingId: string; state: string }>)
        .find((event) => event.bindingId === `local:${id}`)?.state ?? "none";
    const closeView = () => page.getByRole("button", { name: "Close view", exact: true }).click();
    const crew = Object.fromEntries(RUNNING.map((id) => [id, crewSeat(sandbox, CANVAS, id)]));

    await expect(line(page, "rests")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    for (const [i, id] of RUNNING.entries()) {
      await crewOccupySeat(page, CANVAS, seats[i]!, crew[id]!);
      await expect.poll(() => seatState(id), { message: `${id} idle`, timeout: 30_000 }).toBe("idle");
      expect((await crew[id]!.op("onboard", {})).ok, `${id} onboards`).toBe(true);
    }
    await page.getByRole("button", { name: /fit all/i }).first().click();

    // The 60 minute window: every seat continues, and says nothing.
    for (const id of RUNNING) await expect(line(page, id)).not.toContainText("fresh next");

    await crew.dialog!.control({ screen: { mode: "attention" } });
    await expect.poll(() => seatState("dialog"), { timeout: 30_000 }).toBe("attention");
    const raised = await crew.raised!.cli(["blocked", "needs the prod password"]);
    expect(raised.ok, `${raised.stdout}${raised.stderr}`).toBe(true);

    // typed: shown, one key (Shift: nothing reaches the agent), closed. Its hold runs 30 s from the key.
    await line(page, "typed").dblclick();
    // Attached: the view holds its lease once the seat's screen is drawn, and only then is a key the operator's.
    // Under WebGL the DOM holds no rows; the surface's registered text does (harness/term-ready.ts).
    await expect
      .poll(async () => (await terminalRows(page, "local:typed")).join("").trim().length, { message: "typed's screen is drawn", timeout: 20_000 })
      .toBeGreaterThan(0);
    await page.locator(".xterm").first().click();
    const typedAt = Date.now();
    await page.keyboard.press("Shift");
    await closeView();
    // viewed: shown, and left open.
    await line(page, "viewed").dblclick();
    await expect(page.getByRole("button", { name: "Close view", exact: true })).toBeVisible({ timeout: 20_000 });

    // The operator shortens the machine's cache window to 5 minutes, in Settings.
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("button", { name: "Cache window", exact: true }).click();
    const minutes = page.getByLabel("Cache window, minutes", { exact: true });
    await minutes.fill("5");
    await minutes.press("Enter");
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(line(page, "rests")).toContainText("fresh next", { timeout: 20_000 });
    expect(Date.now() - typedAt, "the typed hold is still running").toBeLessThan(30_000);
    for (const id of ["viewed", "typed", "dialog", "raised"]) await expect(line(page, id)).not.toContainText("fresh next");

    // Closing the view lets go: viewed goes cold at once, the card asking on the close itself
    // (a cut at the minute pass would also turn it; still idle means it was not that).
    await closeView();
    await expect(line(page, "viewed")).toContainText("fresh next", { timeout: 5_000 });
    for (const id of ["dialog", "raised"]) await expect(line(page, id)).not.toContainText("fresh next");
    await page.mouse.move(4, 600);
  } finally {
    await junto.close();
  }
});
