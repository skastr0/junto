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
    // Signal captures (tests/pty-e2e/signal-capture.ts): amp could not create
    // its thread. After retries or a refusal the unsent prompt stays above the
    // box and the box reads unreadable, so mail holds; out of credits it is
    // written into a seat that cannot answer until pack rules land.
    "retry-overloaded": "unreadable",
    "retry-rate": "unreadable",
    "usage-limit": "written",
    "error-auth": "unreadable",
    "error-server": "unreadable",
  },
  agy: {
    // Signal captures (tests/pty-e2e/signal-capture.ts). No screen rules read
    // this harness's limits or auth errors yet, so mail is typed into a seat
    // that cannot answer it until pty-state's pack rules land.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    "usage-limit": "written",
    "error-auth": "written",
    "error-server": "written",
    "error-context": "written",
    "compaction-manual": "written",
  },
  claude: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written", // mid-turn, empty prompt box
    "working-turn": "written",
    // Recorded while logged out: the login-method picker. The seat reads idle.
    "mail-notice": "unreadable",
    // Signal captures (tests/pty-e2e/signal-capture.ts): the turn has ended on
    // an error, a retry that recovered, or a compaction, and the box is empty.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    // Not logged in: the seat cannot take mail until someone logs it in.
    "error-auth": "dialog",
    "error-server": "written",
    "error-context": "written",
    "compaction-manual": "written",
    // The 5h limit waits with the box open and continues by itself at the
    // reset: blocked on the limit until then, mail holds.
    "usage-limit": "dialog",
    // The weekly limit asks what to do: stop, wait, or upgrade.
    "usage-limit-weekly": "dialog",
  },
  codex: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written", // mid-turn, empty prompt box
    "working-turn": "written",
    // Recorded with a broken home: an error and no TUI at all.
    "mail-notice": "unreadable",
    // Signal captures (tests/pty-e2e/signal-capture.ts): the turn has ended on
    // an error, a retry that recovered, or a compaction, and the box is empty.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    // 401 Unauthorized: the seat cannot take mail until its credentials are fixed.
    "error-auth": "dialog",
    "error-server": "written",
    "error-context": "written",
    "compaction-manual": "written",
    "compaction-auto": "written",
    // Both limits end on Codex's "Switch to gpt-6-luna?" model picker
    // (enter select, esc back): the seat is blocked on the limit, mail holds.
    "usage-limit": "dialog",
    "usage-limit-weekly": "dialog",
  },
  cursor: {
    // Signal captures (tests/pty-e2e/signal-capture.ts). No screen rules read
    // this harness's limits or auth errors yet, so mail is typed into a seat
    // that cannot answer it until pty-state's pack rules land.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    "usage-limit": "written",
    "error-auth": "written",
    "error-server": "written",
  },
  devin: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written",
    "working-turn": "written",
    "mail-notice": "written",
    "startup-trust": "dialog",
    // Signal captures (tests/pty-e2e/signal-capture.ts). No screen rules read
    // this harness's limits or auth errors yet, so mail is typed into a seat
    // that cannot answer it until pty-state's pack rules land.
    // Devin cannot be answered, so retries end in errors; it has its own limit kinds.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    "error-auth": "written",
    "error-server": "written",
    "usage-limit-monthly": "written",
    "usage-limit-org": "written",
    "usage-paused": "written",
  },
  fx: {
    // Signal captures (tests/pty-e2e/signal-capture.ts). No screen rules read
    // this harness's limits or auth errors yet, so mail is typed into a seat
    // that cannot answer it until pty-state's pack rules land.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    "usage-limit": "written",
    "usage-limit-weekly": "written",
    "error-auth": "written",
    "error-server": "written",
    "error-context": "written",
  },
  grok: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written", // mid-turn, empty prompt box
    "working-turn": "written",
    "permission-returns-idle": "written",
    // Signal captures (tests/pty-e2e/signal-capture.ts). No screen rules read
    // this harness's limits or auth errors yet, so mail is typed into a seat
    // that cannot answer it until pty-state's pack rules land.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    "usage-limit": "written",
    "usage-limit-weekly": "written",
    "error-auth": "written",
    "error-server": "written",
    "error-context": "written",
    "compaction-manual": "written",
  },
  hermes: {
    // Recorded logged out: Hermes asks for attention ("No Codex credentials").
    "startup-idle": "dialog",
    "type-echo": "dialog",
    // A multiline paste Hermes never collapses: the box is not readable.
    "paste-chip": "unreadable",
    // Signal captures (tests/pty-e2e/signal-capture.ts). No screen rules read
    // this harness's limits or auth errors yet, so mail is typed into a seat
    // that cannot answer it until pty-state's pack rules land.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    "usage-limit": "written",
    "usage-limit-weekly": "written",
    "error-auth": "written",
    "error-server": "written",
    "error-context": "written",
    "compaction-manual": "written",
  },
  kimi: {
    // Recorded with no model configured: Kimi asks for attention.
    "startup-idle": "dialog",
    "type-echo": "dialog",
    // Signal captures (tests/pty-e2e/signal-capture.ts): the turn has ended on
    // an error, a retry that recovered, or a compaction, and the box is empty.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    // A usage limit kimi keeps retrying: blocked on the limit, mail holds.
    "usage-limit": "dialog",
    "usage-limit-weekly": "dialog",
    // A rejected API key: the seat cannot take mail until it is fixed.
    "error-auth": "dialog",
    // Still retrying the 500s when the recording ends; the box stays open.
    "error-server": "written",
    "error-context": "written",
    "compaction-manual": "written",
  },
  muse: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written",
    "working-turn": "written",
    // Signal captures (tests/pty-e2e/signal-capture.ts). No screen rules read
    // this harness's limits or auth errors yet, so mail is typed into a seat
    // that cannot answer it until pty-state's pack rules land.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    "usage-limit": "written",
    "usage-limit-weekly": "written",
    "error-auth": "written",
    "error-server": "written",
    "error-context": "written",
    "compaction-auto": "written",
    "compaction-manual": "written",
  },
  omp: {
    "startup-idle": "written",
    "type-echo": "written",
    "paste-chip": "written", // mid-turn, empty prompt box
    "working-turn": "written",
    // Signal captures (tests/pty-e2e/signal-capture.ts). No screen rules read
    // this harness's limits or auth errors yet, so mail is typed into a seat
    // that cannot answer it until pty-state's pack rules land.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    "usage-limit": "written",
    "usage-limit-weekly": "written",
    "error-auth": "written",
    "error-context": "written",
    "compaction-auto": "written",
    "compaction-manual": "written",
    // Ends mid-retry with omp's status line over the box: unreadable, mail holds.
    "error-server": "unreadable",
  },
  "prime-agent": {
    // Signal captures (tests/pty-e2e/signal-capture.ts). No screen rules read
    // this harness's limits or auth errors yet, so mail is typed into a seat
    // that cannot answer it until pty-state's pack rules land.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    "usage-limit": "written",
    "usage-limit-weekly": "written",
    "error-auth": "written",
    "error-server": "written",
    "error-context": "written",
    "compaction-auto": "written",
    "compaction-manual": "written",
  },
  pi: {
    "startup-idle": "written",
    "type-echo": "written",
    // Signal captures (tests/pty-e2e/signal-capture.ts). No screen rules read
    // this harness's limits or auth errors yet, so mail is typed into a seat
    // that cannot answer it until pty-state's pack rules land.
    "retry-overloaded": "written",
    "retry-rate": "written",
    "retry-network": "written",
    "usage-limit": "written",
    "usage-limit-weekly": "written",
    "error-auth": "written",
    "error-server": "written",
    "error-context": "written",
    "compaction-auto": "written",
    "compaction-manual": "written",
  },
};

/**
 * Rows whose last screen is a running turn on a harness that steers with a
 * second Enter (HARNESS_FOLLOW_UP): mail is the paste, its CR and that Enter.
 * Devin 3000.11.92, run live against the stub provider on the network retry
 * screen: the first Enter already lands the mail in the conversation and
 * restarts the retry, and the second Enter on the emptied box adds nothing,
 * no second message, no new turn, no dialog. Cursor 2026.10.14, the same run:
 * the first Enter puts the mail in the follow-ups box ("enter steer"), the
 * second marks it steering; only a third Enter would interrupt and send.
 */
const STEERED: ReadonlySet<string> = new Set([
  "devin/retry-overloaded",
  "devin/retry-network",
  "cursor/retry-network",
]);

/**
 * What the input box read as on every recorded frame where the seat was
 * mid-turn. "available" and "draft" (not the operator's) are typed into;
 * "unreadable" holds. A harness with no entry has no mid-turn recording.
 */
const MID_TURN: Readonly<Record<string, ReadonlyArray<string>>> = {
  agy: ["available"],
  amp: ["draft", "unreadable"],
  claude: ["available"],
  codex: ["available", "unreadable"],
  cursor: ["available", "draft", "unreadable"],
  devin: ["draft"],
  grok: ["available"],
  hermes: ["draft"],
  kimi: ["available"],
  muse: ["available", "unreadable"],
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
    mailUnreadableGraceMs: 0,
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
        const steer = STEERED.has(`${harness}/${scenario}`) ? [CR] : [];
        expect(writes).toEqual(
          expected === "written" ? [encodeBracketedPaste(NOTICE), CR, ...steer] : [],
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

describe("a seat that reads idle before its input box is painted", () => {
  // What a codex seat puts on the wire at startup (and what the e2e fake
  // codex in e2e/harness/crew-fixture.ts writes): bracketed paste on and an
  // idle title first, the composer a moment later. Between the two the seat
  // is idle with an unread box; mail sent then is typed, not answered queued.
  it("codex: mail sent in that gap is typed once the composer paints", async () => {
    const observer = new SessionObserver({ bindingId: BINDING, epoch: "e1", cols: 120, rows: 32 });
    const runtime = new SeatStateRuntime({ turnProgressWatch: false });
    runtime.bindHarness(BINDING, "codex", "e1");
    const writes: string[] = [];
    const drive = new ManagedTerminalDrive({
      write: (_bindingId, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => runtime.isSeatIdle(BINDING),
      composerVerdict: () => runtime.composerVerdict(BINDING),
      seatState: () => runtime.getState(BINDING),
      harnessFor: () => "codex",
      operatorInput: new OperatorInterlock(),
      stallWatch: false,
      pasteToCrSettleMs: 0,
    });
    disposers.push(() => {
      drive.resetForTest();
      runtime.stop();
      observer.dispose();
    });
    const feed = async (data: string, seq: bigint) => {
      observer.feed(data, seq);
      await observer.snapshot();
      runtime.observe(await observer.snapshot());
    };
    await feed("\x1b[?2004h\x1b]0;codex\x07", 1n);
    expect(runtime.isSeatIdle(BINDING)).toBe(true);
    expect(runtime.composerVerdict(BINDING)).toBeNull();

    const mail = drive.writeMail(BINDING, NOTICE);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(writes).toEqual([]);
    await feed("\x1b[2J\x1b[999;1H\u203a Ask Codex to do anything\r\n", 2n);
    await expect(mail).resolves.toBe("written");
    expect(writes).toEqual([encodeBracketedPaste(NOTICE), CR]);
  });
});
