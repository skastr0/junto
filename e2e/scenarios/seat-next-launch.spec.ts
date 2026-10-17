/**
 * A seat that is not running says what its next start does. Three codex seats
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

test("a seat that is not running says whether it will resume or start fresh", async () => {
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

    await expect(line(page, "holds")).toContainText("not running, will resume", { timeout: 20_000 });
    await expect(line(page, "fresh")).toContainText("not running, starts fresh");
    await expect(line(page, "rested")).toContainText("not running, will resume");

    // Offboard the third seat with rest: its session closes at an offboard.
    const result = await page.evaluate(
      (input) => window.junto!.seatOffboardRun!(input),
      { canvasName: CANVAS, seatIds: ["rested"], action: "now" as const },
    );
    console.log("offboard now", JSON.stringify(result));
    await expect(line(page, "rested")).toContainText("offboarded, starts fresh", { timeout: 20_000 });

    await page.mouse.move(4, 600);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(SHOTS, "three-lines.png") });
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
