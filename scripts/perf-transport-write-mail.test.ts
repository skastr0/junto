/** Wall-clock cost of the real managed-mail write path on recorded idle and mid-turn terminal states. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { ManagedTerminalDrive, OperatorInterlock } from "../src/core/term/drive";
import { admitMail } from "../src/core/term/drive/mail-admission";
import { harnessCapabilitiesFor } from "../src/shared/harness-capabilities";
import { SessionObserver } from "../src/core/term/observer/session-observer";
import { SeatStateRuntime } from "../src/core/term/agent-state/runtime";
import { chunkEvents, corpusRoot, loadFixture } from "../tests/pty-e2e/runner";

const BINDING = "seat-1";
const NOTICE = "mail from A: the answer is ready\n\nPlease continue with the migration and report back.";
const REPS = 9;

const ptySize = (harness: string): { cols: number; rows: number } => {
  const manifest = JSON.parse(readFileSync(join(corpusRoot(), harness, "manifest.json"), "utf8")) as {
    pty?: { cols?: number; rows?: number };
  };
  return { cols: manifest.pty?.cols ?? 80, rows: manifest.pty?.rows ?? 24 };
};

const median = (values: ReadonlyArray<number>): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const round = (value: number): number => Math.round(value * 100) / 100;

const measureOne = async (harness: string, scenario: string, stopAtWorking = false) => {
  const fixture = loadFixture(harness, scenario);
  const observer = new SessionObserver({ bindingId: BINDING, epoch: "e1", ...ptySize(harness) });
  const runtime = new SeatStateRuntime({ now: () => 1_000, turnProgressWatch: false });
  runtime.bindHarness(BINDING, harness, "e1");
  const writes: string[] = [];
  const interlock = new OperatorInterlock(() => 1_000);
  const drive = new ManagedTerminalDrive({
    write: (_bindingId, data) => {
      writes.push(data);
      return true;
    },
    isSeatIdle: () => runtime.isSeatIdle(BINDING),
    composerVerdict: () => runtime.composerVerdict(BINDING),
    seatState: () => runtime.getState(BINDING),
    harnessFor: () => harness,
    operatorInput: interlock,
    stallWatch: false,
    mailAdmission: () => admitMail(runtime.snapshot(BINDING), harnessCapabilitiesFor(harness)),
  });
  try {
    let stoppedAt: number | undefined;
    let position = 0;
    for (const chunk of chunkEvents(fixture.events, "whole")) {
      position += 1;
      observer.feed(chunk.data, chunk.seq);
      runtime.observe(await observer.snapshot());
      if (stopAtWorking && runtime.getState(BINDING) === "working") {
        stoppedAt = position;
        break;
      }
    }
    const times: number[] = [];
    const outcomes: string[] = [];
    for (let rep = 0; rep < REPS; rep += 1) {
      writes.length = 0;
      const at = performance.now();
      const outcome = await drive.writeMail(BINDING, NOTICE);
      times.push(performance.now() - at);
      outcomes.push(outcome);
    }
    return {
      harness,
      scenario,
      state: runtime.getState(BINDING),
      stoppedAt,
      eventCount: chunkEvents(fixture.events, "whole").length,
      verdict: runtime.composerVerdict(BINDING),
      outcomes: [...new Set(outcomes)],
      writesPerMail: writes.length,
      medianMs: round(median(times)),
      bestMs: round(Math.min(...times)),
      maxMs: round(Math.max(...times)),
    };
  } finally {
    drive.resetForTest();
    runtime.stop();
    observer.dispose();
  }
};

it("measures transport.writeMail on real recorded terminal states", async () => {
  const cases = [
    ["claude", "startup-idle"],
    ["claude", "working-turn"],
    ["claude", "paste-chip"],
    ["codex", "startup-idle"],
    ["codex", "working-turn"],
    ["codex", "paste-chip"],
    ["devin", "startup-idle"],
    ["devin", "working-turn"],
    ["devin", "paste-chip"],
  ] as const;
  const rows = [];
  for (const [harness, scenario] of cases) rows.push(await measureOne(harness, scenario, scenario !== "startup-idle"));
  console.log(JSON.stringify(rows, null, 2));
}, 120_000);
