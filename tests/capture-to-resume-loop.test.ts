/**
 * The capture-to-resume loop, end to end:
 *
 *   a capture harness announces an id → proof against its own state →
 *   the seat's node stores it → the next wake resumes that exact session,
 *   with argv shaped by whether the harness can be re-briefed at all.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_TEMPLATE,
  HARNESS_IDS,
  KIMI_TEMPLATE,
  MANAGED_TERMINAL_TEMPLATES,
  reinjectableOnResume,
  templateFor,
  type HarnessId,
} from "../src/shared/managed-terminal-templates";
import { resolveManagedLaunch } from "../src/shared/managed-terminal-launch";
import {
  __setSessionExistenceHomeForTest,
  harnessSessionExists,
  shouldResumeHarnessSession,
} from "../src/main/vellum/term/session-existence";
import {
  __setCapturedSessionWriterForTest,
  persistCapturedSessionId,
  resetCapturedSessionPersistForTest,
  scheduleCapturedSessionPersist,
  usesCapturedSession,
  type CapturedSeatSession,
} from "../src/main/vellum/term/session-capture-persist";

const temps: string[] = [];

const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vellum-capture-resume-"));
  temps.push(dir);
  return dir;
};

afterEach(() => {
  __setSessionExistenceHomeForTest(undefined);
  __setCapturedSessionWriterForTest(undefined);
  resetCapturedSessionPersistForTest();
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ── The reinjectability ledger ─────────────────────────────────────────────

/** Probe receipts, 2026-08. Anything not listed here is deliberately absent. */
const RE_PASS: readonly HarnessId[] = [
  "claude",
  "grok",
  "pi",
  "cursor",
  "agy",
  "muse",
  "hermes",
];
const FROZEN: readonly HarnessId[] = ["codex", "kimi"];

describe("per-harness reinjectability matrix", () => {
  it("every template declares its class, and the probed ones match the receipts", () => {
    for (const id of HARNESS_IDS) {
      expect(
        MANAGED_TERMINAL_TEMPLATES[id].argvSpec.resumeReinjection,
      ).toMatch(/^(re-pass|frozen|unprobed)$/);
    }
    for (const id of RE_PASS) {
      expect(templateFor(id).argvSpec.resumeReinjection).toBe("re-pass");
      expect(reinjectableOnResume(templateFor(id))).toBe(true);
    }
    for (const id of FROZEN) {
      expect(templateFor(id).argvSpec.resumeReinjection).toBe("frozen");
      expect(reinjectableOnResume(templateFor(id))).toBe(false);
    }
  });

  it("an unprobed harness is treated as frozen, never as re-pass", () => {
    for (const id of HARNESS_IDS) {
      if (templateFor(id).argvSpec.resumeReinjection !== "unprobed") continue;
      expect(reinjectableOnResume(templateFor(id))).toBe(false);
    }
  });
});

describe("resume argv per reinjectability class", () => {
  it("a re-pass harness carries the injection flag on resume when asked", () => {
    const argv = resolveManagedLaunch(
      "grok",
      { resumeId: "SID", systemPrompt: "DOCTRINE", cwd: "/x" },
    ).argv!;
    expect(argv).toContain("-r");
    expect(argv).toContain("SID");
    expect(argv).toContain("--rules");
    expect(argv).toContain("DOCTRINE");
  });

  it("a frozen harness drops the injection flag on resume, and only on resume", () => {
    // Kimi refuses `--agent-file` alongside `--session` outright; Codex accepts
    // re-passed instructions and silently ignores them. Either way the flag on
    // a resume argv is a claim the seat was re-briefed when it was not.
    const kimiFresh = resolveManagedLaunch("kimi", {
      systemPrompt: "DOCTRINE",
      agentFile: "/tmp/agent.md",
    }).argv!;
    const kimiResume = resolveManagedLaunch("kimi", {
      resumeId: "ses_abc",
      systemPrompt: "DOCTRINE",
      agentFile: "/tmp/agent.md",
    }).argv!;
    expect(kimiResume).toContain("-S");
    expect(kimiResume).toContain("ses_abc");
    expect(kimiResume).not.toContain("/tmp/agent.md");
    expect(kimiResume).not.toContain("DOCTRINE");
    // A fresh Kimi seat DOES take the carrier (`--agent-file` is its Tier-A
    // route); the point is that a resume drops it, because the flag cannot
    // combine with `--session` at all.
    expect(kimiFresh).toContain("--agent-file");
    expect(kimiFresh).toContain("/tmp/agent.md");

    const codexResume = resolveManagedLaunch("codex", {
      resumeId: "0199-thread",
      systemPrompt: "DOCTRINE",
    }).argv!;
    expect(codexResume.slice(0, 3)).toEqual(["codex", "resume", "0199-thread"]);
    expect(codexResume).not.toContain("DOCTRINE");
  });

  it("hermes re-passes -m on resume (or the model silently reverts)", () => {
    const argv = resolveManagedLaunch("hermes", {
      resumeId: "SID",
      model: "sonnet",
    }).argv!;
    expect(argv).toContain("-r");
    expect(argv).toContain("-m");
    expect(argv).toContain("sonnet");
  });
});

// ── Badges vs the ledger ───────────────────────────────────────────────────

describe("capability badges match what the code can actually do", () => {
  it("codex is a capture harness with cold resume, not 'unavailable'", () => {
    expect(CODEX_TEMPLATE.capabilityBadges.sessionId).toBe("capture");
    expect(CODEX_TEMPLATE.capabilityBadges.labels).not.toContain(
      "no cold resume",
    );
    expect(CODEX_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["capture session", "doctrine at creation"]),
    );
    expect(KIMI_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["doctrine at creation"]),
    );
  });

  it("no template claims a session capability the probes cannot prove", () => {
    const home = tempHome();
    const sid = "e2b4c1a0-7f6d-4c3b-9a8e-5d4c3b2a1f09";
    for (const id of HARNESS_IDS) {
      const badge = templateFor(id).capabilityBadges.sessionId;
      if (badge !== "capture") continue;
      // A capture badge is a promise that an id can be proven from harness
      // state. An empty home proves nothing for anyone — the per-harness
      // fixtures below show each one turning true.
      expect(
        harnessSessionExists({ harness: id, sessionId: sid, home }),
      ).toBe(false);
      expect(usesCapturedSession(id)).toBe(true);
    }
  });
});

// ── Cold resume per capture harness ────────────────────────────────────────

type Fixture = {
  readonly harness: HarnessId;
  readonly sessionId: string;
  readonly cwd?: string;
  readonly seed: (home: string, sessionId: string) => void;
};

const CAPTURE_FIXTURES: readonly Fixture[] = [
  {
    // Hermes keeps sessions only in state.db; the jsonl tree is retired.
    harness: "hermes",
    sessionId: "20260825_140355_9f3ab1",
    seed: (home, sid) => {
      mkdirSync(join(home, ".hermes"), { recursive: true });
      const db = new DatabaseSync(join(home, ".hermes", "state.db"));
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY);");
      db.prepare("INSERT INTO sessions (id) VALUES (?)").run(sid);
      db.close();
    },
  },
  {
    harness: "codex",
    sessionId: "0199a0b1-c2d3-4e5f-8a9b-0c1d2e3f4a5b",
    seed: (home, sid) => {
      const dir = join(home, ".codex", "sessions", "2026", "08", "25");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `rollout-2026-08-25T10-00-00-${sid}.jsonl`), "");
    },
  },
  {
    harness: "prime-agent",
    sessionId: "3f2e1d0c-9b8a-4756-8413-2a1b0c9d8e7f",
    seed: (home, sid) => {
      const dir = join(home, ".prime", "agent", "sessions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sid}.jsonl`), "");
    },
  },
  {
    harness: "kimi",
    sessionId: "ses_7c6b5a49382716",
    seed: (home, sid) => {
      mkdirSync(join(home, ".kimi-code", "sessions", "workdir-key", sid), {
        recursive: true,
      });
    },
  },
  {
    harness: "muse",
    sessionId: "b1a2c3d4-e5f6-4718-9a0b-1c2d3e4f5061",
    seed: (home, sid) => {
      mkdirSync(
        join(home, ".local", "share", "muse", "sessions", "2026", "08", "25", sid),
        { recursive: true },
      );
    },
  },
  {
    harness: "devin",
    sessionId: "sample-session",
    seed: (home, sid) => {
      const dir = join(home, ".local", "share", "devin", "cli", "transcripts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sid}.json`), "{}");
    },
  },
  {
    harness: "agy",
    sessionId: "conv-9f8e7d6c5b4a",
    seed: (home, sid) => {
      const dir = join(
        home,
        ".gemini",
        "antigravity-cli",
        "brain",
        sid,
        ".system_generated",
        "logs",
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "transcript.jsonl"), "");
    },
  },
];

describe("cold resume is proven per capture harness", () => {
  it("covers every harness whose badge says capture", () => {
    const badged = HARNESS_IDS.filter(
      (id) => templateFor(id).capabilityBadges.sessionId === "capture",
    );
    expect([...CAPTURE_FIXTURES.map((f) => f.harness)].sort()).toEqual(
      [...badged].sort(),
    );
  });

  for (const fixture of CAPTURE_FIXTURES) {
    it(`${fixture.harness}: unproven id refuses resume, proven id allows it`, () => {
      const home = tempHome();
      const probe = {
        harness: fixture.harness,
        sessionId: fixture.sessionId,
        home,
        ...(fixture.cwd ? { cwd: fixture.cwd } : {}),
      };
      expect(shouldResumeHarnessSession(true, probe)).toBe(false);
      fixture.seed(home, fixture.sessionId);
      expect(shouldResumeHarnessSession(true, probe)).toBe(true);
      // Wanting resume is still required — proof alone never forces it.
      expect(shouldResumeHarnessSession(false, probe)).toBe(false);
    });
  }
});

// ── Capture → proof → canvas ───────────────────────────────────────────────

const seat = (over: Partial<CapturedSeatSession> = {}): CapturedSeatSession => ({
  canvasName: "factory",
  nodeId: "agent-1",
  harness: "codex",
  sessionId: "0199a0b1-c2d3-4e5f-8a9b-0c1d2e3f4a5b",
  ...over,
});

const seedCodex = (home: string, sid: string): void => {
  const dir = join(home, ".codex", "sessions", "2026", "08", "25");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-${sid}.jsonl`), "");
};

describe("persisting a captured session id", () => {
  it("refuses to write an id the harness cannot prove", async () => {
    __setSessionExistenceHomeForTest(tempHome());
    let writes = 0;
    __setCapturedSessionWriterForTest(async () => {
      writes += 1;
      return "written";
    });
    expect(await persistCapturedSessionId(seat())).toBe("unverified");
    expect(writes).toBe(0);
  });

  it("writes once the harness's own state proves the id", async () => {
    const home = tempHome();
    __setSessionExistenceHomeForTest(home);
    const input = seat();
    seedCodex(home, input.sessionId);
    const seen: CapturedSeatSession[] = [];
    __setCapturedSessionWriterForTest(async (written) => {
      seen.push(written);
      return "written";
    });
    expect(await persistCapturedSessionId(input)).toBe("written");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      canvasName: "factory",
      nodeId: "agent-1",
      sessionId: input.sessionId,
    });
  });

  it("never overwrites a pin or provisioned harness's own id", async () => {
    const home = tempHome();
    __setSessionExistenceHomeForTest(home);
    let writes = 0;
    __setCapturedSessionWriterForTest(async () => {
      writes += 1;
      return "written";
    });
    for (const harness of ["claude", "grok", "pi", "amp"] as const) {
      expect(usesCapturedSession(harness)).toBe(false);
      expect(await persistCapturedSessionId(seat({ harness }))).toBe(
        "not-captured",
      );
    }
    expect(writes).toBe(0);
  });

  it("keeps retrying while the harness has not flushed its session file yet", async () => {
    const home = tempHome();
    __setSessionExistenceHomeForTest(home);
    const input = seat();
    let writes = 0;
    __setCapturedSessionWriterForTest(async () => {
      writes += 1;
      return "written";
    });
    // First attempt finds nothing; the file lands before the second.
    const ladder = [0, 5, 5];
    const flight = scheduleCapturedSessionPersist("b@1", input, ladder);
    seedCodex(home, input.sessionId);
    expect(await flight).toBe("written");
    expect(writes).toBe(1);
  });

  it("gives up quietly when the id is never proven", async () => {
    __setSessionExistenceHomeForTest(tempHome());
    __setCapturedSessionWriterForTest(async () => "written");
    expect(await scheduleCapturedSessionPersist("b@2", seat(), [0, 0])).toBe(
      "unverified",
    );
  });

  it("reports a failed canvas write instead of throwing into the PTY path", async () => {
    const home = tempHome();
    __setSessionExistenceHomeForTest(home);
    const input = seat();
    seedCodex(home, input.sessionId);
    __setCapturedSessionWriterForTest(async () => {
      throw new Error("canvas unavailable");
    });
    expect(await persistCapturedSessionId(input)).toBe("failed");
  });
});
