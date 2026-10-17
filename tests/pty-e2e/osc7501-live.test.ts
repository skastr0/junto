/**
 * Live proof: a real omp seat on the production host, process plane, observer
 * and seat state runtime, reporting over OSC 7501.
 *
 * Spends one small turn on the operator's own omp login, so it runs only when
 * asked:
 *
 *   JUNTO_LIVE_OSC7501=1 bunx vitest run tests/pty-e2e/osc7501-live.test.ts
 *
 * Optional: JUNTO_LIVE_OSC7501_MODEL (default haiku), and
 * JUNTO_LIVE_OSC7501_OUT, a file the published timeline is written to.
 *
 * The seat runs with `--approval-mode always-ask` in a fresh folder and is
 * asked to run one shell command, so the turn passes through a real
 * permission prompt. Every published seat state must equal the projection of
 * the snapshot it was published from.
 */
import { seedThisMachine, clearMachines } from "../support/seed-this-machine";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { LocalSessionHost } from "../../src/main/junto/term/local-host";
import { createAppProcessPlane } from "../../src/main/junto/app-process-plane";
import { seatStateRuntime } from "../../src/main/junto/term/agent-state";
import { projectAgentSeatState } from "../../src/main/junto/term/agent-state/projection";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import type { SeatSnapshot } from "../../src/shared/harness-domain";

const LIVE = process.env.JUNTO_LIVE_OSC7501 === "1";
const MODEL = process.env.JUNTO_LIVE_OSC7501_MODEL ?? "haiku";
const BINDING = "live-osc7501-omp";

type Published = {
  readonly t: number;
  readonly state: AgentSeatStateEvent["state"];
  readonly reason: string;
  readonly status: SeatSnapshot["status"];
  readonly statusSource: SeatSnapshot["statusSource"];
  readonly projection: AgentSeatStateEvent["state"];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (what: string, ms: number, check: () => boolean): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe.skipIf(!LIVE)("OSC 7501 live: a real omp seat", () => {
  const host = new LocalSessionHost(createAppProcessPlane(), {});
  afterAll(async () => {
    await host.shutdownAll("test_cleanup");
    seatStateRuntime.stop();
    clearMachines();
  });

  it("publishes a turn, a permission and idle that agree with the snapshot", async () => {
    seedThisMachine();
    seatStateRuntime.start();
    const cwd = mkdtempSync(join(tmpdir(), "junto-osc7501-"));
    writeFileSync(join(cwd, "README.md"), "osc7501 live proof\n");
    const omp = execFileSync("/bin/sh", ["-lc", "command -v omp"]).toString().trim();

    const t0 = Date.now();
    const timeline: Published[] = [];
    const off = seatStateRuntime.subscribe((event) => {
      if (event.bindingId !== BINDING) return;
      const snapshot = seatStateRuntime.snapshot(BINDING);
      if (snapshot === undefined) return;
      timeline.push({
        t: Date.now() - t0,
        state: event.state,
        reason: event.reason,
        status: snapshot.status,
        statusSource: snapshot.statusSource,
        projection: projectAgentSeatState(snapshot),
      });
    });
    const owned = (tag: SeatSnapshot["status"]["_tag"], reason?: string) =>
      timeline.some(
        (entry) =>
          entry.statusSource === "osc7501" &&
          entry.status._tag === tag &&
          (reason === undefined ||
            (entry.status._tag === "Blocked" && entry.status.reason._tag === reason)),
      );

    try {
      host.createAgentSeat({
        bindingId: BINDING,
        harness: "omp",
        agentKey: `local:${BINDING}`,
        launch: {
          kind: "harness",
          argv: [omp, "--model", MODEL, "--approval-mode", "always-ask"],
          cwd,
        },
        cols: 120,
        rows: 32,
      });

      await until("omp to report idle", 30_000, () => owned("Idle"));
      await sleep(1_500);
      host.writeManagedSeat(BINDING, "Use the bash tool to run exactly: ls. Then reply with only the word done.");
      await sleep(500);
      host.writeManagedSeat(BINDING, "\r");

      await until("a working report", 30_000, () => owned("Working"));
      await until("the permission prompt", 60_000, () => owned("Blocked", "Permission"));
      await sleep(800);
      host.writeManagedSeat(BINDING, "\r");
      await until("the turn to finish", 90_000, () =>
        timeline.some(
          (entry, index) =>
            index > timeline.findIndex((e) => e.status._tag === "Blocked") &&
            entry.statusSource === "osc7501" &&
            entry.status._tag === "Idle",
        ),
      );
      await sleep(1_000);
    } finally {
      off();
      if (process.env.JUNTO_LIVE_OSC7501_OUT) {
        writeFileSync(
          process.env.JUNTO_LIVE_OSC7501_OUT,
          JSON.stringify({ model: MODEL, timeline, final: seatStateRuntime.snapshot(BINDING) }, null, 1),
        );
      }
    }

    expect(owned("Working")).toBe(true);
    expect(owned("Blocked", "Permission")).toBe(true);
    expect(owned("Idle")).toBe(true);
    expect(seatStateRuntime.snapshot(BINDING)?.turnUnseen?.outcome).toBe("completed");
    for (const entry of timeline) expect(entry.state).toBe(entry.projection);
  }, 240_000);
});
