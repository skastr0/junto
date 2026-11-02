/**
 * A real seat, spawned by the app's own terminal plane, calls the browser
 * control socket with the generation credential from its own environment: it
 * is admitted while its generation is live, and the same credential is refused
 * once the operator stops the seat and the core revokes the generation.
 *
 * Every call in this spec is the seat's own. The seat's process presents the
 * credential the app injected into it; a detached child of that seat, carrying
 * the same environment, keeps presenting it until the door refuses, so the call
 * after the generation ends is still the seat's, not the harness's. No spec
 * code reads a credential value and none reaches the window: the seat records
 * the shape of what it holds and the answers it got.
 *
 * The switch that makes this reachable is the build, not a product flag:
 * `bun run build:bundles` under JUNTO_FEATURE_PROFILE=all-on (the e2e lanes'
 * own build) compiles BROWSER_ENABLED in. Ship builds keep it off, and this
 * spec is a proof of the door, not a way to turn it on for users.
 */
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  browserSeatProbePath,
  installBrowserSeatProbe,
  readSeatProbeFile,
  type SeatProbeAnswer,
  type SeatProbeIdentity,
} from "../harness/browser-seat-probe";
import { waitForControlDoctor, readSandboxControlToken, sandboxControlSocketPath } from "../harness/browser-control-client";
import { launchJunto } from "../harness/launch";
import { installModelFixture, modelFixture, modelNode, modelSeat, modelWire } from "../harness/model";
import { OFFBOARDED_SESSION_MESSAGE } from "../../src/main/junto/process-identity-facts";

/** The canvas this scenario installs into when the app has none yet. */
const CANVAS_FALLBACK = "browser-seat-credential";
const SEAT = "a1";
const PAGE = "p1";
const PAGE_URL = "https://example.com/";
const PROFILE = "personal";
/** `modelSeat`'s default binding for this node: the operator's Stop takes it. */
const BINDING = `local:${SEAT}`;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** One line per control answer the seat's own processes saw. */
interface SeatAttempt {
  readonly from: "seat" | "replay";
  readonly at: number;
  readonly status: number;
  readonly ok: boolean;
  readonly error: { readonly _tag: string; readonly message: string } | null;
  readonly nodeIds: ReadonlyArray<string | null> | null;
}

const readAttempts = async (home: string): Promise<ReadonlyArray<SeatAttempt>> => {
  const raw = await readFile(browserSeatProbePath(home, "attempts.ndjson"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SeatAttempt);
};

test("a real seat is admitted with its own credential, and refused once its generation ends", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({
    seedHarnessInstalls: ["codex"],
    afterSeed: installBrowserSeatProbe,
  });
  const { page, sandbox } = junto;
  const home = sandbox.homeDir;

  try {
    // The door is up before the seat is started, so a refusal later is the
    // generation's and never a socket that had not opened yet.
    await waitForControlDoctor(
      sandboxControlSocketPath(home),
      await readSandboxControlToken(home),
    );

    // The seat's machine is the app's own name, read from the app: a seat
    // assigned to another machine never drives a page here. Settings is where
    // main puts it (renderer/lib/machines.ts thisMachineName).
    const machine = await page.evaluate(async () => {
      const read = await window.junto!.settingsGet();
      return read.ok ? (read.settings?.machine.name ?? "") : "";
    });
    expect(machine, "this machine has a name the app knows").not.toBe("");

    const nodes = [
      modelSeat({ id: SEAT, label: "credential seat", host: machine, x: 0, y: 0 }),
      // A page node as the model has it: the page is local by nature, so it
      // names no machine.
      modelNode({
        kind: "page", id: PAGE, url: PAGE_URL, profile: PROFILE, onRemove: "kill-session",
        x: 300, y: 0, width: 240, height: 80, z: 0,
      }),
    ];
    const canvas = await installModelFixture(
      page,
      modelFixture(nodes, [modelWire("e1", SEAT, PAGE, "navigates", nodes)]),
      CANVAS_FALLBACK,
    );

    const started = await page.evaluate(
      ([name, id]) => window.junto!.modelStart({ canvas: name, id }),
      [canvas, SEAT] as const,
    );
    expect(started, "the operator's start of the seat").toBeTruthy();

    // The seat's own call, with the credential in its own environment.
    await expect
      .poll(async () => (await readSeatProbeFile<SeatProbeIdentity>(home, "seat.json")) !== undefined, {
        message: "the spawned seat reports itself",
        timeout: 60_000,
      })
      .toBe(true);
    const identity = (await readSeatProbeFile<SeatProbeIdentity>(home, "seat.json"))!;
    expect(identity.credentialShape, JSON.stringify(identity)).toBe(true);
    expect(identity.nodeRef, "the seat knows its node").toBe(`${canvas}:${SEAT}`);
    expect(identity.seat, "the seat knows its key").toBe(BINDING);

    await expect
      .poll(async () => await readSeatProbeFile<SeatProbeAnswer | null>(home, "admitted.json"), {
        message: "the seat's own call is answered",
        timeout: 60_000,
      })
      .not.toBeUndefined();
    const admitted = (await readSeatProbeFile<SeatProbeAnswer | null>(home, "admitted.json"))!;
    if (admitted === null) {
      throw new Error(
        `the seat was never admitted: ${JSON.stringify((await readAttempts(home)).slice(-4))}`,
      );
    }
    expect(admitted.error, "no refusal for a live seat").toBeNull();
    expect(admitted.status, "the seat's own call, admitted").toBe(200);
    expect(admitted.ok).toBe(true);
    // Admitted as this seat, and only for the page its edge names.
    const rows = admitted.data as ReadonlyArray<{ readonly canvas: string; readonly nodeId: string; readonly url: string; readonly profile: string }>;
    expect(rows.map((row) => row.nodeId), "the page this seat's edge reaches").toEqual([PAGE]);
    expect(rows[0]).toMatchObject({ canvas, url: PAGE_URL, profile: PROFILE });

    // No credential value reaches the window, in the page or in any text.
    const leaked = await page.evaluate(() =>
      /junto-seat-[A-Za-z0-9_-]{43}/u.test(document.documentElement.outerHTML),
    );
    expect(leaked, "no credential value in the window").toBe(false);

    // The seat's detached child is already presenting the same credential, so
    // the refusal below is the same credential's, not a fresh process's.
    await expect
      .poll(
        async () => (await readAttempts(home)).some((attempt) => attempt.from === "replay" && attempt.ok),
        { message: "the seat's replayer is admitted before the stop", timeout: 30_000 },
      )
      .toBe(true);

    // The operator's Stop ends the generation, and the core revokes it.
    const stoppedAt = Date.now();
    await page.evaluate((bindingId) => window.junto!.terminalKill(bindingId), BINDING);
    await expect
      .poll(() => pidAlive(identity.pid), {
        message: "the seat's process after the operator's stop",
        timeout: 30_000,
      })
      .toBe(false);

    // The same credential, presented again by the seat's own detached child.
    await expect
      .poll(async () => await readSeatProbeFile<SeatProbeAnswer>(home, "refused.json"), {
        message: "the revoked credential is refused",
        timeout: 60_000,
      })
      .not.toBeUndefined();
    const refused = (await readSeatProbeFile<SeatProbeAnswer>(home, "refused.json"))!;
    expect(refused.status, "a revoked generation is unauthorized").toBe(401);
    expect(refused.ok).toBe(false);
    expect(refused.error?._tag).toBe("unauthorized");
    expect(refused.error?.message, "the seat hears the offboarded sentence").toBe(
      OFFBOARDED_SESSION_MESSAGE,
    );
    expect(refused.at, "the refusal comes after the stop").toBeGreaterThanOrEqual(stoppedAt);

    // The refusing process is the one that was admitted before the stop: same
    // credential, same environment, admitted then refused.
    const attempts = await readAttempts(home);
    const replayed = attempts.filter((attempt) => attempt.from === "replay");
    expect(
      replayed.some((attempt) => attempt.ok && attempt.at < stoppedAt),
      "the replaying process was admitted before the stop",
    ).toBe(true);
    expect(
      replayed.filter((attempt) => !attempt.ok).map((attempt) => attempt.error?._tag),
      "and every refusal after it is the offboarded sentence",
    ).toContain("unauthorized");
  } finally {
    await junto.close();
  }
});
