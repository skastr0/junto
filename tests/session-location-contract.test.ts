/**
 * Session location under the harness contract: every record declares where
 * its harness keeps sessions, main's store agrees with the declaration, a
 * lookup always answers (a location, or why there is none), and a path the
 * harness reports is kept only inside its own store on this machine.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reportedLocationAdmissible, type SessionHolds } from "../src/shared/harness-domain";
import { HARNESS_RECORDS } from "../src/shared/harness-records";
import { HARNESS_IDS } from "../src/shared/managed-terminal-templates";
import { harnessRuntimeRecordFor } from "../src/main/junto/term/harness-record";
import { SeatStateMachine, type SessionReport } from "../src/main/junto/term/agent-state/seat-state-machine";
import {
  __setSessionExistenceHomeForTest,
  admitReportedSessionLocation,
  encodeClaudeProjectCwd,
  locateHarnessSession,
  type SessionMatch,
} from "../src/main/junto/term/session-existence";

const temps: string[] = [];
afterEach(() => {
  __setSessionExistenceHomeForTest(undefined);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "junto-session-location-"));
  temps.push(dir);
  __setSessionExistenceHomeForTest(dir);
  return dir;
};

const cwd = "/Users/me/proj";
const claudeTranscript = (home: string, sessionId: string): string => {
  const project = join(home, ".claude", "projects", encodeClaudeProjectCwd(cwd));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sessionId}.jsonl`), "{}\n");
  return join(project, `${sessionId}.jsonl`);
};

const holdsOf = (match: SessionMatch): SessionHolds => {
  switch (match.kind) {
    case "database":
      return "database";
    case "dir":
    case "dirNamed":
      return "folder";
    case "file":
    case "entryIncludes":
    case "treeIncludes":
      return "transcript";
  }
};

describe("the record declares where each harness keeps its sessions", () => {
  it("as main's store finds them, and none where main keeps no store", () => {
    for (const harness of HARNESS_IDS) {
      const declared = HARNESS_RECORDS[harness].sessions;
      const store = harnessRuntimeRecordFor(harness)!.session;
      if (store === undefined) {
        expect(declared, harness).toEqual({ level: "none" });
        continue;
      }
      expect(declared.level, harness).toBe("store");
      const found = new Set(store.places.flatMap((place) => place.match.map(holdsOf)));
      expect(declared.level === "store" ? [...declared.holds].sort() : [], harness).toEqual([...found].sort());
    }
  });
});

describe("a session lookup always answers", () => {
  it("with the location and its source when the store has the session", () => {
    const home = tempHome();
    const path = claudeTranscript(home, "s1");
    expect(locateHarnessSession({ harness: "claude", sessionId: "s1", cwd })).toEqual({
      _tag: "Located",
      location: { path, source: "store" },
    });
  });

  it("with none when the store has nothing under the id", () => {
    tempHome();
    expect(locateHarnessSession({ harness: "claude", sessionId: "s1", cwd })).toEqual({ _tag: "Missing", missing: "none" });
  });

  it("with unsearchable when Junto cannot look", () => {
    tempHome();
    // Junto's own seat keeps no store, an unknown harness names none, and
    // Oh My Pi's store is the session's folder, which this probe does not name.
    for (const harness of ["junto-overseer", "not-a-harness"]) {
      expect(locateHarnessSession({ harness, sessionId: "s1" }), harness).toEqual({ _tag: "Missing", missing: "unsearchable" });
    }
    expect(locateHarnessSession({ harness: "omp", sessionId: "0b2c6c4e-6a1f-4d8e-9f2a-3c5d7e9f1a2b" })).toEqual({
      _tag: "Missing",
      missing: "unsearchable",
    });
  });
});

describe("a location the harness reports", () => {
  const report = (path: string, channel: "report" | "screen" = "report") =>
    ({ path, channel, fidelity: channel === "screen" ? ("screen" as const) : ("native" as const) });

  it("is kept inside the harness's own store, as the channel that said it", () => {
    const home = tempHome();
    const path = claudeTranscript(home, "s1");
    // Kept as the file it resolves to: the path that was checked.
    expect(admitReportedSessionLocation({ harness: "claude", sessionId: "s1", cwd }, report(path))).toEqual({
      path: realpathSync(path),
      source: "report",
    });
  });

  it("is refused outside the store, through a link out of it, or naming another session", () => {
    const home = tempHome();
    const outside = join(home, "secret-s1.txt");
    writeFileSync(outside, "not a transcript");
    claudeTranscript(home, "s2");
    const link = join(home, ".claude", "projects", encodeClaudeProjectCwd(cwd), "s1.jsonl");
    symlinkSync(outside, link);
    const probe = { harness: "claude", sessionId: "s1", cwd };
    expect(admitReportedSessionLocation(probe, report("/etc/passwd"))).toBeUndefined();
    expect(admitReportedSessionLocation(probe, report(outside))).toBeUndefined();
    expect(admitReportedSessionLocation(probe, report(link))).toBeUndefined();
    expect(
      admitReportedSessionLocation(probe, report(join(home, ".claude", "projects", encodeClaudeProjectCwd(cwd), "s2.jsonl"))),
    ).toBeUndefined();
  });

  it("is refused when read off the screen, relative, or for a harness with no store", () => {
    const home = tempHome();
    const path = claudeTranscript(home, "s1");
    expect(admitReportedSessionLocation({ harness: "claude", sessionId: "s1", cwd }, report(path, "screen"))).toBeUndefined();
    expect(reportedLocationAdmissible({ path: "projects/s1.jsonl", channel: "report", fidelity: "native" })).toBe(false);
    expect(admitReportedSessionLocation({ harness: "junto-overseer", sessionId: "s1" }, report(path))).toBeUndefined();
  });
});

describe("the seat state machine", () => {
  it("passes on every session a harness names, with its channel and fidelity", () => {
    const machine = new SeatStateMachine({ now: () => 1_000 });
    machine.bind("bind-a", { harness: "claude" });
    const reports: SessionReport[] = [];
    const off = machine.subscribeSessionReports((report) => reports.push(report));
    machine.note("bind-a", {
      signal: { _tag: "SessionIdentified", sessionId: "s1", transcriptPath: "/x/s1.jsonl" },
      source: "report",
      fidelity: "native",
    });
    machine.note("bind-a", { signal: { _tag: "SessionIdentified", sessionId: "s2" }, source: "screen", fidelity: "screen" });
    off();
    machine.note("bind-a", { signal: { _tag: "SessionIdentified", sessionId: "s3" }, source: "report", fidelity: "native" });
    expect(reports).toEqual([
      { bindingId: "bind-a", sessionId: "s1", transcriptPath: "/x/s1.jsonl", source: "report", fidelity: "native" },
      { bindingId: "bind-a", sessionId: "s2", source: "screen", fidelity: "screen" },
    ]);
  });
});
