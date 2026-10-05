/**
 * Mail is typed only into an available input box, per harness, on real bytes.
 *
 * Every recording in the corpus is fed through the REAL SessionObserver and
 * SeatStateRuntime (rule packs and composer probes), and the REAL
 * ManagedTerminalDrive is asked to type one mail notice into the screen the
 * recording ends on. The table below is the whole corpus: a new recording
 * fails this test until someone says what mail does on its last screen.
 *
 * "written" means the paste and its CR were sent; anything else is a hold
 * with nothing typed. No operator input is simulated, so text in the box is
 * never the operator's here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CR,
  ManagedTerminalDrive,
  OperatorInterlock,
  encodeBracketedPaste,
} from "../../../src/main/junto/term/drive";
import { SessionObserver } from "../../../src/main/junto/term/observer/session-observer";
import { SeatStateRuntime } from "../../../src/main/junto/term/agent-state/runtime";
import { composerAvailability } from "../../../src/shared/composer-availability";
import { chunkEvents, corpusRoot, loadFixture, type FixtureEvent } from "../runner";

const BINDING = "seat-1";
const NOTICE = "mail from A";

type Outcome = "written" | "draft" | "dialog" | "unreadable";

/** What mail does on the last screen of each recording. */
const LAST_SCREEN: Readonly<Record<string, Readonly<Record<string, Outcome>>>> = {
  amp: {
    "startup-idle": "written",
    "type-echo": "written",
    // Mid-turn: Amp's steering box holds our own earlier paste. Still a composer.
    "paste-chip": "written",
    "working-turn": "written",
  },
  claude: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written", // mid-turn, empty prompt box
    "working-turn": "written",
    // Recorded while logged out: the login-method picker. The seat reads idle.
    "mail-notice": "unreadable",
  },
  codex: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written", // mid-turn, empty prompt box
    "working-turn": "written",
    // Recorded with a broken home: an error and no TUI at all.
    "mail-notice": "unreadable",
  },
  devin: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written",
    "working-turn": "written",
    "mail-notice": "written",
    "startup-trust": "dialog",
  },
  grok: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written", // mid-turn, empty prompt box
    "working-turn": "written",
    "permission-returns-idle": "written",
  },
  hermes: {
    // Recorded logged out: Hermes asks for attention ("No Codex credentials").
    "startup-idle": "dialog",
    "type-echo": "dialog",
    // A multiline paste Hermes never collapses: the box is not readable.
    "paste-chip": "unreadable",
  },
  kimi: {
    // Recorded with no model configured: Kimi asks for attention.
    "startup-idle": "dialog",
    "type-echo": "dialog",
  },
  muse: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written",
    "working-turn": "written",
  },
  omp: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written", // mid-turn, empty prompt box
    "working-turn": "written",
  },
  pi: {
    "startup-idle": "written",
    "type-echo": "written",
  },
};

/**
 * What the input box read as on every recorded frame where the seat was
 * mid-turn. "available" and "draft" (not the operator's) are typed into;
 * "unreadable" holds. A harness with no entry has no mid-turn recording.
 */
const MID_TURN: Readonly<Record<string, ReadonlyArray<string>>> = {
  amp: ["draft", "unreadable"],
  claude: ["available"],
  codex: ["available", "unreadable"],
  devin: ["draft"],
  grok: ["available"],
  muse: ["unreadable"],
  omp: ["available", "draft", "unreadable"],
};

const recordings = (): ReadonlyArray<{ harness: string; scenario: string }> => {
  const out: Array<{ harness: string; scenario: string }> = [];
  for (const harness of readdirSync(corpusRoot()).sort()) {
    let files: string[];
    try {
      files = readdirSync(join(corpusRoot(), harness));
    } catch {
      continue;
    }
    for (const file of files.filter((name) => name.endsWith(".jsonl")).sort()) {
      out.push({ harness, scenario: file.replace(/\.jsonl$/u, "") });
    }
  }
  return out;
};

const ptySize = (harness: string): { cols: number; rows: number } => {
  const manifest = JSON.parse(
    readFileSync(join(corpusRoot(), harness, "manifest.json"), "utf8"),
  ) as { pty?: { cols?: number; rows?: number } };
  return { cols: manifest.pty?.cols ?? 80, rows: manifest.pty?.rows ?? 24 };
};

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** Feed one corpus recording; report each frame's reading and the final mail outcome. */
const replay = (harness: string, scenario: string) =>
  replayEvents(harness, loadFixture(harness, scenario).events, ptySize(harness));

const replayEvents = async (
  harness: string,
  events: ReadonlyArray<FixtureEvent>,
  size: { cols: number; rows: number },
) => {
  const fixture = { harness, events };
  const observer = new SessionObserver({ bindingId: BINDING, epoch: "e1", ...size });
  const runtime = new SeatStateRuntime({ now: () => 1_000, turnProgressWatch: false });
  runtime.bindHarness(BINDING, fixture.harness, "e1");
  const writes: string[] = [];
  const drive = new ManagedTerminalDrive({
    write: (_bindingId, data) => {
      writes.push(data);
      return true;
    },
    isSeatIdle: () => runtime.isSeatIdle(BINDING),
    composerVerdict: () => runtime.composerVerdict(BINDING),
    seatState: () => runtime.getState(BINDING),
    harnessFor: () => fixture.harness,
    operatorInput: new OperatorInterlock(),
    stallWatch: false,
    pasteToCrSettleMs: 0,
  });
  disposers.push(() => {
    drive.resetForTest();
    runtime.stop();
    observer.dispose();
  });
  const midTurn = new Set<string>();
  for (const chunk of chunkEvents(fixture.events, "whole")) {
    observer.feed(chunk.data, chunk.seq);
    await observer.snapshot();
    runtime.observe(await observer.snapshot());
    if (runtime.getState(BINDING) === "working") {
      midTurn.add(composerAvailability(runtime.composerVerdict(BINDING), "working"));
    }
  }
  const outcome = await drive.writeMail(BINDING, NOTICE);
  return { outcome, writes, midTurn, state: runtime.getState(BINDING) };
};

describe("mail on the last screen of every recording", () => {
  it("the table names every recording in the corpus, and nothing else", () => {
    const inCorpus = recordings().map((r) => `${r.harness}/${r.scenario}`);
    const inTable = Object.entries(LAST_SCREEN).flatMap(([harness, rows]) =>
      Object.keys(rows).map((scenario) => `${harness}/${scenario}`),
    );
    expect([...inTable].sort()).toEqual([...inCorpus].sort());
  });

  for (const [harness, rows] of Object.entries(LAST_SCREEN)) {
    for (const [scenario, expected] of Object.entries(rows)) {
      it(`${harness}/${scenario}: ${expected}`, async () => {
        const { outcome, writes } = await replay(harness, scenario);
        expect(outcome).toBe(expected);
        expect(writes).toEqual(
          expected === "written" ? [encodeBracketedPaste(NOTICE), CR] : [],
        );
      });
    }
  }
});

describe("the input box mid-turn, per harness", () => {
  it("reads as recorded on every mid-turn frame", async () => {
    const seen: Record<string, Set<string>> = {};
    for (const { harness, scenario } of recordings()) {
      const { midTurn } = await replay(harness, scenario);
      if (midTurn.size === 0) continue;
      seen[harness] ??= new Set();
      for (const reading of midTurn) seen[harness].add(reading);
    }
    const observed = Object.fromEntries(
      Object.entries(seen).map(([harness, readings]) => [harness, [...readings].sort()]),
    );
    expect(observed).toEqual(MID_TURN);
  });
});

describe("Claude's folder-trust dialog", () => {
  // tests/pty-e2e/recordings/claude-startup-trust.jsonl: the dialog whose
  // default option is "No, exit". A mail notice typed here quits Claude.
  const events = readFileSync(
    join(__dirname, "..", "recordings", "claude-startup-trust.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureEvent);

  it("holds mail and types nothing, though the seat does not read as attention", async () => {
    const { outcome, writes, state } = await replayEvents("claude", events, { cols: 120, rows: 32 });
    // The seat state does not see this dialog; the unread input box does.
    expect(state).not.toBe("attention");
    expect(outcome).toBe("unreadable");
    expect(writes).toEqual([]);
  });
});
