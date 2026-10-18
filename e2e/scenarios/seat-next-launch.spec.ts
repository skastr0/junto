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
import { modelFixture, modelSeat, modelSeatSession } from "../harness/model";
import { readSeatSession } from "../harness/seat-session";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "seat-next-launch");
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
  await mkdir(SHOTS, { recursive: true });
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
    const result = await page.evaluate(
      (input) => window.junto!.seatOffboardRun!(input),
      { canvasName: CANVAS, seatIds: ["rested"], action: "now" as const },
    );
    console.log("offboard now", JSON.stringify(result));
    await expect(line(page, "rested")).toContainText("fresh next", { timeout: 20_000 });

    // At fit-all each line reads whole: none is cut by an ellipsis.
    for (const [id, text] of [["holds", "not running"], ["rested", "fresh next"], ["fresh", "fresh next"]] as const) {
      const label = line(page, id).getByText(text, { exact: true });
      await expect(label).toBeVisible();
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth), `${id}: the line is not clipped`).toBe(true);
    }
    for (const theme of ["Dark", "Bright"] as const) {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      const choice = page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: new RegExp(theme) });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-checked", "true");
      await page.locator(".settings-panel__close").click();
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.mouse.move(4, 600);
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(SHOTS, `three-lines-${theme.toLowerCase()}.png`) });
    }
    console.log("lines", JSON.stringify(await Promise.all(["holds", "rested", "fresh"].map(async (id) => `${id}: ${(await line(page, id).innerText()).replace(/\n/g, " | ")}`))));

    // A start takes the same path as a ping: the held seat resumes its session.
    expect(readSeatSession(sandbox, "holds", holds.bindingId)).toBe(HELD);
    await page.evaluate(() => window.junto!.modelStart({ canvas: "seat-next-launch", id: "holds" }));
    await expect.poll(async () => (await readFile(argvLog, "utf8").catch(() => "")), { timeout: 30_000 }).toContain(HELD);
    expect(readSeatSession(sandbox, "holds", holds.bindingId)).toBe(HELD);

    // The offboarded seat starts a new session: the closed id is not passed.
    await page.evaluate(() => window.junto!.modelStart({ canvas: "seat-next-launch", id: "rested" }));
    await expect.poll(async () => (await readFile(argvLog, "utf8")).split("\n").filter((l) => l.includes("rested")).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const restedStart = (await readFile(argvLog, "utf8")).split("\n").find((l) => l.includes("rested")) ?? "";
    console.log("argv", JSON.stringify((await readFile(argvLog, "utf8")).split("\n")));
    expect(restedStart).not.toContain(RESTED);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, "after-start.png") });
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
  await mkdir(SHOTS, { recursive: true });
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
      await mkdir(join(sandbox.homeDir, ".junto", "seats"), { recursive: true });
      await writeFile(
        join(sandbox.homeDir, ".junto", "seats", "offboard-clock.json"),
        JSON.stringify({
          savedAt: movedAt,
          seats: {
            [short.bindingId]: { movedAt, workMs: WORKED_MS, sessionId: SHORT },
            [long.bindingId]: { movedAt, workMs: WORKED_MS, sessionId: LONG },
          },
        }),
      );
    },
  });
  try {
    const { page } = junto;
    const launchState = (id: string) =>
      page.evaluate((input) => window.junto!.modelSeatLaunchState(input), { canvas: CANVAS, id });
    const setCodexWindow = async (minutes: number | null) => {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Offboard" }).first().click();
      const section = page.getByTestId("offboard-settings");
      await expect(section).toBeVisible({ timeout: 10_000 });
      const row = section.getByTestId("offboard-harness-codex");
      if (minutes === null) {
        await row.getByRole("button", { name: "Remove the Codex window" }).click();
        await expect(row).toHaveCount(0, { timeout: 10_000 });
      } else {
        if ((await row.count()) === 0) {
          await section.getByRole("button", { name: "Add a window for a harness" }).click();
          await page.getByRole("option", { name: "Codex", exact: true }).click();
          await expect(row).toBeVisible({ timeout: 10_000 });
        }
        const field = row.getByLabel("Codex cache window, minutes");
        await field.click();
        await field.fill(String(minutes));
        await field.press("Tab");
        await expect
          .poll(async () => (await page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard))?.harness?.codex?.cacheWindowMinutes, { timeout: 10_000 })
          .toBe(minutes);
      }
      await page.screenshot({ path: join(SHOTS, `codex-window-${minutes ?? "removed"}-settings.png`) });
      await page.locator(".settings-panel__close").click();
      await page.getByRole("button", { name: /fit all/i }).first().click();
    };

    await expect(line(page, "short")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /fit all/i }).first().click();

    // The installation's window, 60 minutes: both sessions are still warm and both resume.
    await expect.poll(async () => (await launchState("short")).nextTurn, { timeout: 20_000 })
      .toEqual({ fresh: false, freshAt: movedAt + 60 * 60_000 });
    expect((await launchState("long")).nextTurn).toEqual({ fresh: false, freshAt: movedAt + 60 * 60_000 });
    for (const id of ["short", "long"]) {
      await expect(line(page, id)).toContainText("not running");
      await expect(line(page, id)).not.toContainText("fresh next");
    }

    // Codex's own window, 5 minutes: the codex session has been still past it.
    await setCodexWindow(5);
    await expect(line(page, "short")).toContainText("fresh next", { timeout: 20_000 });
    expect((await launchState("short")).nextTurn).toEqual({ fresh: true });
    expect((await launchState("long")).nextTurn).toEqual({ fresh: false, freshAt: movedAt + 60 * 60_000 });
    await expect(line(page, "long")).not.toContainText("fresh next");
    await page.mouse.move(4, 600);
    await page.screenshot({ path: join(SHOTS, "codex-window-5.png") });

    // 15 minutes: still warm, and it goes cold 15 minutes after it last moved.
    await setCodexWindow(15);
    await expect(line(page, "short")).not.toContainText("fresh next", { timeout: 20_000 });
    expect((await launchState("short")).nextTurn).toEqual({ fresh: false, freshAt: movedAt + 15 * 60_000 });

    // No window of its own: codex follows the installation's again.
    await setCodexWindow(null);
    await expect.poll(async () => (await launchState("short")).nextTurn, { timeout: 20_000 })
      .toEqual({ fresh: false, freshAt: movedAt + 60 * 60_000 });
    await expect(line(page, "short")).not.toContainText("fresh next");
    console.log("lines", JSON.stringify(await Promise.all(["short", "long"].map(async (id) => `${id}: ${(await line(page, id).innerText()).replace(/\n/g, " | ")}`))));
  } finally {
    await junto.close();
  }
});
