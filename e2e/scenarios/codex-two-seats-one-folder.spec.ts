/**
 * Two Codex seats in one folder [fake-tui]: each binds the rollout its own
 * process holds open, and its offboard names that session.
 *
 * Codex 0.166 mints its thread when the TUI starts, writes the rollout only
 * when the first turn starts, and holds it open for the session's life. So
 * the second seat's rollout can land first, and the first seat's rollout
 * sits inside the second seat's start window. By folder and start time the
 * two seats cannot be told apart; by the file each process holds they can.
 * The seats are the crew fixture's fake codex, which writes and holds the
 * rollout the spec names, the way codex does.
 *
 *   scripts/run-e2e.sh e2e/scenarios/codex-two-seats-one-folder.spec.ts
 */
import { join } from "node:path";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";
import { readSeatSession } from "../harness/seat-session";
import {
  type CrewSeat,
  type CrewSeatReady,
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
  installCrewSeatHarness,
  type WorkEnvelope,
} from "../harness/crew-fixture";

const CANVAS = "codex-one-folder";
const FIRST = "01a19e22-ce4c-7f73-8a02-2c8bdc5abf8a";
const SECOND = "01a19e22-e07d-76a0-845f-47b748e059ea";

// No cwd: both seats open in the same folder (the machine's temp directory).
const first = modelSeat({ id: "seat-lookout", key: "local:seat-lookout", label: "lookout", x: 80, y: 80 });
const second = modelSeat({ id: "seat-scout", key: "local:seat-scout", label: "scout", x: 420, y: 80 });

/** The folder a seat opens in; the rollout records it. */
const folderOf = (seat: typeof first): string => {
  const cwd = seat.launch?.cwd;
  if (!cwd) throw new Error(`seat ${seat.id} has no launch folder`);
  return cwd;
};

const data = (envelope: WorkEnvelope): Record<string, any> => {
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  return (envelope as { data?: Record<string, any> }).data ?? {};
};

/** The rollout codex writes when the seat's first turn starts: minted at spawn, stamped then. */
const rollout = (home: string, id: string, ready: CrewSeatReady, cwd: string) => {
  const minted = new Date(ready.at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dir = join(home, ".codex", "sessions", String(minted.getFullYear()), pad(minted.getMonth() + 1), pad(minted.getDate()));
  return {
    path: join(dir, `rollout-${minted.getTime()}-${id}.jsonl`),
    line: `${JSON.stringify({ type: "session_meta", payload: { id, timestamp: minted.toISOString(), cwd, source: "cli", thread_source: "user" } })}\n`,
  };
};

test("two Codex seats in one folder each bind their own rollout, and offboard names it", async ({}, testInfo) => {
  test.setTimeout(240_000);
  expect(folderOf(first), "the two seats share one folder").toBe(folderOf(second));
  const junto = await launchJunto({
    seedModels: { [CANVAS]: modelFixture([first, second]) },
    afterSeed: installCrewSeatHarness,
  });
  const mainLog: string[] = [];
  const appendLog = (chunk: Buffer) => mainLog.push(String(chunk));
  const appProcess = junto.app.process();
  appProcess.stdout?.on("data", appendLog);
  appProcess.stderr?.on("data", appendLog);
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(`.react-flow__node[data-id="${second.id}"]`)).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const lookout = crewSeat(sandbox, CANVAS, first.id);
    const scout = crewSeat(sandbox, CANVAS, second.id);
    // The first seat spawns, then the second, inside its start window.
    const lookoutReady = await crewOccupySeat(page, CANVAS, first, lookout);
    const scoutReady = await crewOccupySeat(page, CANVAS, second, scout);
    expect(scoutReady.at - lookoutReady.at, "the second seat starts within seconds of the first").toBeLessThan(15_000);

    const boundary = async (seat: CrewSeat) => {
      await seat.control({ screen: { mode: "working" } });
      await seat.control({ screen: { mode: "idle" } });
    };

    // The second seat's first turn starts first: its rollout is the only one
    // in the folder, and the first seat must not take it.
    await scout.control({ rollout: rollout(sandbox.homeDir, SECOND, scoutReady, folderOf(second)) });
    await boundary(lookout);
    await boundary(scout);
    await expect.poll(() => readSeatSession(sandbox, second.id),
      { message: "the second seat bound its own rollout", timeout: 30_000 }).toBe(SECOND);
    expect(readSeatSession(sandbox, first.id), "the first seat took nothing that is not its own").toBeUndefined();

    // The first seat's rollout lands, stamped before the second's.
    await lookout.control({ rollout: rollout(sandbox.homeDir, FIRST, lookoutReady, folderOf(first)) });
    await boundary(lookout);
    await expect.poll(() => readSeatSession(sandbox, first.id),
      { message: "the first seat bound its own rollout", timeout: 30_000 }).toBe(FIRST);
    expect(readSeatSession(sandbox, second.id)).toBe(SECOND);

    // Offboard knows each seat's session.
    expect(data(await lookout.op("offboard", { notes: "# Lookout done\n\n- Nothing owed." }))).toMatchObject({ session_id: FIRST });
    expect(data(await scout.op("offboard", { notes: "# Scout done\n\n- Nothing owed." }))).toMatchObject({ session_id: SECOND });
  } finally {
    try {
      await testInfo.attach("app-main-capture.log", { body: mainLog.join("").slice(-100_000), contentType: "text/plain" });
    } finally {
      appProcess.stdout?.off("data", appendLog);
      appProcess.stderr?.off("data", appendLog);
      await junto.close();
    }
  }
});
