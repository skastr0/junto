/**
 * Hermes cold resume rests on one file: `~/.hermes/state.db`.
 *
 * The jsonl transcripts the old probe looked for are retired — v0.20.4 writes
 * nothing under `~/.hermes/sessions/`, so a filesystem probe would report "not
 * proven" for every live session and every wake would open a new one. These
 * cases build a real database, prove a real id against it, and check that the
 * cold wake carries both the conversation and the model it was running.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  HERMES_TEMPLATE,
  templateFor,
} from "../src/shared/managed-terminal-templates";
import { resolveManagedLaunch } from "../src/shared/managed-terminal-launch";
import {
  __setSessionExistenceHomeForTest,
  harnessSessionExists,
  isHermesSessionId,
  shouldResumeHarnessSession,
} from "../src/main/vellum-command/term/session-existence";
import { launchForManagedSpawn } from "../src/main/vellum-command/term/managed-spawn-plan";
import type { CanvasDoc } from "../src/shared/canvas";

const temps: string[] = [];
const originalVellumHome = process.env.JUNTO_HOME;

const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vellum-hermes-statedb-"));
  temps.push(dir);
  return dir;
};

const SESSION_ID = "20260825_140355_9f3ab1";

/** A state.db shaped like the one Hermes writes: sessions + messages. */
const seedStateDb = (
  home: string,
  sessionIds: readonly string[],
  idColumn: "id" | "session_id" = "id",
): string => {
  const dir = join(home, ".hermes");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.db");
  const db = new DatabaseSync(path);
  db.exec(
    `CREATE TABLE sessions (${idColumn} TEXT PRIMARY KEY, created_at TEXT);`,
  );
  db.exec(
    "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, body TEXT);",
  );
  for (const id of sessionIds) {
    const insert = db.prepare(
      `INSERT INTO sessions (${idColumn}, created_at) VALUES (?, ?)`,
    );
    insert.run(id, "2026-08-25T14:03:55Z");
  }
  db.close();
  return path;
};

afterEach(() => {
  if (originalVellumHome === undefined) delete process.env.JUNTO_HOME;
  else process.env.JUNTO_HOME = originalVellumHome;
  __setSessionExistenceHomeForTest(undefined);
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ── The id shape ───────────────────────────────────────────────────────────

describe("hermes session ids", () => {
  it("accepts the harness's own %Y%m%d_%H%M%S_<hex6> shape and nothing else", () => {
    expect(isHermesSessionId(SESSION_ID)).toBe(true);
    expect(isHermesSessionId("20260825_140355_9F3AB1")).toBe(true);
    // Anything scraped off a terminal that is not this shape never reaches the
    // database at all.
    expect(isHermesSessionId("eacbbdbf-e813-5648-927c-a357e5eddaad")).toBe(false);
    expect(isHermesSessionId("20260825_140355")).toBe(false);
    expect(isHermesSessionId("20260825_140355_zzzzzz")).toBe(false);
    expect(isHermesSessionId("")).toBe(false);
  });
});

// ── Proof from the database ────────────────────────────────────────────────

describe("hermes session existence via state.db", () => {
  it("proves a session that the database holds", () => {
    const home = tempHome();
    expect(
      harnessSessionExists({ harness: "hermes", sessionId: SESSION_ID, home }),
    ).toBe(false);
    seedStateDb(home, [SESSION_ID]);
    expect(
      harnessSessionExists({ harness: "hermes", sessionId: SESSION_ID, home }),
    ).toBe(true);
  });

  it("refuses an id the database does not hold", () => {
    const home = tempHome();
    seedStateDb(home, ["20260101_010101_aaaaaa"]);
    expect(
      harnessSessionExists({ harness: "hermes", sessionId: SESSION_ID, home }),
    ).toBe(false);
  });

  it("ignores the retired jsonl tree entirely", () => {
    const home = tempHome();
    // A stale transcript from the era when Hermes still wrote these.
    const sessions = join(home, ".hermes", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `${SESSION_ID}.jsonl`), "");
    expect(
      harnessSessionExists({ harness: "hermes", sessionId: SESSION_ID, home }),
    ).toBe(false);
  });

  it("falls back to a session_id column before giving up", () => {
    const home = tempHome();
    seedStateDb(home, [SESSION_ID], "session_id");
    expect(
      harnessSessionExists({ harness: "hermes", sessionId: SESSION_ID, home }),
    ).toBe(true);
  });

  it("treats an unreadable or foreign database as not proven, never a throw", () => {
    const home = tempHome();
    const dir = join(home, ".hermes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.db"), "this is not a database");
    expect(() =>
      harnessSessionExists({ harness: "hermes", sessionId: SESSION_ID, home }),
    ).not.toThrow();
    expect(
      harnessSessionExists({ harness: "hermes", sessionId: SESSION_ID, home }),
    ).toBe(false);
  });

  it("never writes to the database it reads", () => {
    const home = tempHome();
    const path = seedStateDb(home, [SESSION_ID]);
    harnessSessionExists({ harness: "hermes", sessionId: SESSION_ID, home });
    // A read-only open creates no journal siblings next to the file.
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {
      n: number | bigint;
    };
    db.close();
    expect(Number(row.n)).toBe(1);
  });

  it("gates resume on that proof", () => {
    const home = tempHome();
    const probe = { harness: "hermes", sessionId: SESSION_ID, home };
    expect(shouldResumeHarnessSession(true, probe)).toBe(false);
    seedStateDb(home, [SESSION_ID]);
    expect(shouldResumeHarnessSession(true, probe)).toBe(true);
    expect(shouldResumeHarnessSession(false, probe)).toBe(false);
  });
});

// ── The badge ──────────────────────────────────────────────────────────────

describe("hermes badges match state.db reality", () => {
  it("is a capture harness with cold resume", () => {
    expect(HERMES_TEMPLATE.capabilityBadges.sessionId).toBe("capture");
    expect(HERMES_TEMPLATE.capabilityBadges.labels).not.toContain(
      "no cold resume",
    );
    expect(HERMES_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["capture session"]),
    );
    expect(HERMES_TEMPLATE.argvSpec.providerFlag).toBe("--provider");
    // Resume is a FLAG. The `hermes resume` subcommand lifts an ESTOP sentinel
    // and is not session resume.
    expect(HERMES_TEMPLATE.argvSpec.resumeMode).toBe("flag");
    expect(HERMES_TEMPLATE.argvSpec.resumeSubcommand).toBeUndefined();
    // A Junto seat is a visible TUI on a real PTY.
    expect(HERMES_TEMPLATE.argvSpec.prefix).toEqual(["chat", "--tui"]);
  });
});

// ── Cold wake keeps continuity AND model ───────────────────────────────────

describe("hermes cold wake", () => {
  it("re-passes model and provider next to the resume id", () => {
    const argv = resolveManagedLaunch("hermes", {
      resumeId: SESSION_ID,
      model: "kimi-k2-thinking",
      provider: "moonshot",
    }).argv!;
    expect(argv).toContain("-r");
    expect(argv[argv.indexOf("-r") + 1]).toBe(SESSION_ID);
    expect(argv).toContain("-m");
    expect(argv).toContain("kimi-k2-thinking");
    expect(argv).toContain("--provider");
    expect(argv).toContain("moonshot");
  });

  it("recovers model and provider from the authored argv on replan", () => {
    delete process.env.JUNTO_HOME;
    const home = tempHome();
    seedStateDb(home, [SESSION_ID]);
    __setSessionExistenceHomeForTest(home);

    const nodeId = "agent-hermes-1";
    const doc: CanvasDoc = {
      nodes: [
        {
          id: nodeId,
          type: "text",
          text: "hermes seat",
          x: 0,
          y: 0,
          ether: {
            entity: { kind: "agent" },
            terminal: {
              harness: "hermes",
              sessionId: SESSION_ID,
              launch: {
                kind: "harness",
                argv: [
                  "hermes",
                  "chat",
                  "--tui",
                  "-m",
                  "kimi-k2-thinking",
                  "--provider",
                  "moonshot",
                ],
              },
            },
          },
        },
      ],
      edges: [],
    } as unknown as CanvasDoc;

    const { launch } = launchForManagedSpawn({
      doc,
      nodeId,
      harness: "hermes",
      documentLaunch: (doc.nodes[0] as { ether: { terminal: { launch: unknown } } })
        .ether.terminal.launch as never,
      resume: true,
    });
    const argv = launch!.argv ?? [];
    // Continuity…
    expect(argv).toContain("-r");
    expect(argv).toContain(SESSION_ID);
    // …and the model it was running. Without these two the model reverts and
    // the only trace is a session_model_usage row.
    expect(argv).toContain("-m");
    expect(argv).toContain("kimi-k2-thinking");
    expect(argv).toContain("--provider");
    expect(argv).toContain("moonshot");
  });

  it("does not invent a provider for a seat that never had one", () => {
    const argv = resolveManagedLaunch("hermes", {
      resumeId: SESSION_ID,
      model: "kimi-k2-thinking",
    }).argv!;
    expect(argv).not.toContain("--provider");
    expect(argv).toContain("-m");
  });

  it("leaves harnesses without a provider slot alone", () => {
    expect(templateFor("claude").argvSpec.providerFlag).toBeUndefined();
    const argv = resolveManagedLaunch("claude", {
      model: "opus",
      provider: "anthropic",
    }).argv!;
    expect(argv).not.toContain("--provider");
    expect(argv).not.toContain("anthropic");
  });
});
