/**
 * Mail wakes a cold seat — the demand-signal contract, end to end.
 *   bun run test:e2e:fast e2e/scenarios/mail-wakes-cold-seat.spec.ts
 *
 * A topology with hundreds of agents only works if delivery starts seats:
 * nobody clicks terminals open. Two laws, one real app, one real harness:
 *   1. cold wake — a seat that was NEVER opened spawns and receives when a
 *      notice lands in its mailbox
 *   2. stop then mail — a seat the operator stopped ALSO revives on the next
 *      delivery. One rule, no stop provenance: mail wakes seats.
 *
 * The fixture is written into the canvas the app boots on (playing that
 * canvas from the top bar is then the same canvas delivery consults) and
 * authored at runtime through the app — same gestures as a live session.
 */
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasDoc } from "../../src/shared/canvas";
import { resolveManagedLaunch } from "../../src/shared/managed-terminal-launch";
import { expect, launchJunto, test } from "../harness/launch";

const SEAT_ID = "agent-wake-target";
/** Resolved at runtime: the canvas the app booted on. */
let CANVAS = "";

// The seat's folder. Main refuses a managed agent seat with no working
// directory (its cwd would otherwise fall back to the operator home), and the
// canvas is played before the first edge lands, so the seat can be woken while
// still unconnected — it needs the same document launch the authoring path
// writes, argv included.
const SEAT_CWD = tmpdir();
const seatLaunch = {
  ...resolveManagedLaunch(
    "claude",
    { cwd: SEAT_CWD, injection: { seatBound: false, connected: false } },
    {},
  ),
  cwd: SEAT_CWD,
};

const seatDoc: CanvasDoc = {
  nodes: [
    {
      id: SEAT_ID,
      type: "text",
      text: "Wake target",
      x: 360,
      y: 40,
      width: 240,
      height: 96,
      ether: {
        entity: { kind: "agent", name: "local:wake-target" },
        host: "local",
        terminal: {
          bindingId: "wake-target-binding",
          harness: "claude",
          launch: seatLaunch,
        },
      },
    },
    ...[1, 2, 3].map((n) => ({
      id: `sink${String(n)}`,
      type: "text" as const,
      text: `tasks ${String(n)}`,
      x: 40,
      y: 40 + (n - 1) * 200,
      width: 240,
      height: 120,
      ether: { entity: { kind: "task" as const }, tasks: { items: [] } },
    })),
  ],
  edges: [],
};

const stateDb = (appHome: string): string =>
  join(appHome, ".junto", "state", "junto.db");

const countRows = (appHome: string, sql: string): number => {
  const db = new DatabaseSync(stateDb(appHome), { readOnly: true });
  try {
    const row = db.prepare(sql).get(CANVAS, SEAT_ID) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
};

const receiptCount = (appHome: string): number =>
  countRows(
    appHome,
    "SELECT count(*) AS n FROM work_delivery_receipts WHERE delivered_canvas_name = ? AND delivered_node_id = ?",
  );

const inboxCount = (appHome: string): number =>
  countRows(
    appHome,
    "SELECT count(*) AS n FROM work_messages WHERE canvas_name = ? AND node_id = ?",
  );

/** Pid of the seat's harness process (argv carries the seat brief). */
const seatPid = (): number | null => {
  try {
    const out = execFileSync("pgrep", ["-f", SEAT_ID], { encoding: "utf8" });
    const pids = out
      .split("\n")
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
    return pids[0] ?? null;
  } catch {
    return null;
  }
};

test("mail wakes a cold seat and honors an operator stop", async () => {
  test.setTimeout(420_000);
  const junto = await launchJunto({
    // Sandbox HOME and state stay isolated. PATH is the one deliberate
    // opening: the fakes-only sandbox PATH has no real harness binary, and
    // this test exists to spawn one. Claude auth rides the macOS keychain,
    // not HOME.
    extraEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const appHome = junto.sandbox.homeDir;

  // The sandbox app's own main log is the diagnosis channel: every wake
  // refusal names itself there ([wake] / [delivery] lines).
  const mainLog: string[] = [];
  const proc = junto.app.process();
  proc.stdout?.on("data", (chunk: Buffer) => mainLog.push(String(chunk)));
  proc.stderr?.on("data", (chunk: Buffer) => mainLog.push(String(chunk)));
  const wakeLog = (): string =>
    mainLog
      .join("")
      .split("\n")
      .filter((line) => line.includes("[wake]") || line.includes("[delivery]"))
      .join("\n");

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    // Author into the BOOT canvas — the one the renderer (and its Play
    // button) is actually on. Writing a second canvas and playing the first
    // holds delivery on the pause plane forever, correctly and silently.
    CANVAS = await page.evaluate(
      (doc) =>
        (async () => {
          const api = (window as unknown as {
            junto: {
              listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
              readCanvas: (n: string) => Promise<{ doc: CanvasDoc; revision: string }>;
              writeCanvas: (n: string, d: CanvasDoc, r: string) => Promise<unknown>;
            };
          }).junto;
          const name = (await api.listCanvases())[0]!.name;
          const read = await api.readCanvas(name);
          await api.writeCanvas(name, doc as CanvasDoc, read.revision);
          return name;
        })(),
      seatDoc,
    );
    await expect(page.locator(`.react-flow__node[data-id="${SEAT_ID}"]`)).toBeVisible({
      timeout: 20_000,
    });

    // Born paused — first play is an explicit operator confirmation.
    await page.getByRole("button", { name: "Play crew" }).click();
    const dialog = page.getByRole("dialog", { name: /start|first|play|crew/i });
    await dialog.getByRole("button", { name: "play" }).click();
    await expect(page.getByRole("button", { name: "Pause crew" })).toBeVisible({
      timeout: 15_000,
    });

    const appendEdge = async (id: string, from: string): Promise<void> => {
      await page.evaluate(
        ([name, eid, fromId, toId]) =>
          (async () => {
            const api = (window as unknown as {
              junto: {
                readCanvas: (n: string) => Promise<{ doc: CanvasDoc; revision: string }>;
                writeCanvas: (n: string, d: CanvasDoc, r: string) => Promise<unknown>;
              };
            }).junto;
            const read = await api.readCanvas(name!);
            await api.writeCanvas(
              name!,
              {
                ...read.doc,
                edges: [
                  ...read.doc.edges,
                  {
                    id: eid!,
                    fromNode: fromId!,
                    toNode: toId!,
                    fromSide: "right",
                    toSide: "left",
                    ether: { verb: "works" },
                  },
                ],
              },
              read.revision,
            );
          })(),
        [CANVAS, id, from, SEAT_ID] as const,
      );
    };

    // Law 1 — cold wake. The seat was never opened; the notice must spawn it
    // and land a durable delivery receipt (spawn, boot, idle, paste, ack).
    expect(seatPid()).toBeNull();
    await appendEdge("e-wake-1", "sink1");
    // Producer proof first: the notice must exist as an inbox row.
    await expect
      .poll(() => inboxCount(appHome), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => receiptCount(appHome), {
        timeout: 150_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toBeGreaterThanOrEqual(1)
      .catch((cause: unknown) => {
        throw new Error(`cold wake never receipted.\n[main log]\n${wakeLog()}`, {
          cause,
        });
      });
    await expect.poll(() => seatPid(), { timeout: 15_000 }).not.toBeNull();
    // Law 2 — stop then mail. The operator stops the seat from its terminal;
    // the next delivery revives it anyway. One rule: mail wakes seats.
    await page.locator(`.react-flow__node[data-id="${SEAT_ID}"]`).dblclick();
    const surface = page.locator(
      ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface",
    );
    await expect(surface).toBeVisible({ timeout: 20_000 });
    const stop = surface.getByRole("button", { name: /stop/i }).first();
    await stop.click(); // arm
    await stop.click(); // fire
    await expect(surface.locator(".native-terminal-surface__dead")).toBeVisible({
      timeout: 30_000,
    });
    await surface
      .locator(".native-terminal-surface__dead")
      .getByRole("button", { name: "Close view" })
      .click();
    await expect.poll(() => seatPid(), { timeout: 20_000 }).toBeNull();

    const receiptsBeforeStopLeg = receiptCount(appHome);
    await appendEdge("e-wake-2", "sink2");
    await expect
      .poll(() => receiptCount(appHome), {
        timeout: 150_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toBeGreaterThan(receiptsBeforeStopLeg)
      .catch((cause: unknown) => {
        throw new Error(`revival after operator stop never receipted.\n[main log]\n${wakeLog()}`, {
          cause,
        });
      });
    await expect.poll(() => seatPid(), { timeout: 15_000 }).not.toBeNull();
  } finally {
    await junto.close();
  }
});
