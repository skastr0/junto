import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectProcessTreePids,
  devinSessionIdForPids,
  devinSessionLocksDir,
  discoverDevinSessionId,
  isDevinSessionSlug,
  readDevinLocks,
} from "../src/main/junto/term/devin-session-capture";
import {
  __setSessionExistenceHomeForTest,
  harnessSessionExists,
  isHarnessResumeFailureText,
} from "../src/main/junto/term/session-existence";

/**
 * Devin prints no session id. It writes `session_locks/<slug>.lock` holding a
 * bare PID — from a DESCENDANT of the spawned process, because
 * `~/.local/bin/devin` is a launcher shim (observed on 3000.4.16: spawned pid
 * 40454, lock held 40532).
 */
describe("devin session capture — lock file names it, the process tree claims it", () => {
  const temps: string[] = [];

  afterEach(() => {
    __setSessionExistenceHomeForTest(undefined);
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const homeWithLocks = (
    locks: ReadonlyArray<{ slug: string; pid: number; ageMs?: number }>,
  ): string => {
    const home = mkdtempSync(join(tmpdir(), "junto-devin-"));
    temps.push(home);
    const dir = devinSessionLocksDir(home);
    mkdirSync(dir, { recursive: true });
    for (const lock of locks) {
      const path = join(dir, `${lock.slug}.lock`);
      writeFileSync(path, `${lock.pid}\n`, "utf8");
      if (lock.ageMs) {
        const when = new Date(Date.now() - lock.ageMs);
        utimesSync(path, when, when);
      }
    }
    return home;
  };

  it("accepts devin slugs and rejects path-shaped ids", () => {
    expect(isDevinSessionSlug("ionized-pluto")).toBe(true);
    expect(isDevinSessionSlug("sample-session")).toBe(true);
    expect(isDevinSessionSlug("../../etc/passwd")).toBe(false);
    expect(isDevinSessionSlug("")).toBe(false);
    expect(isDevinSessionSlug("Has Spaces")).toBe(false);
  });

  it("matches the lock whose PID is in the spawn's process tree", () => {
    const home = homeWithLocks([
      { slug: "ionized-pluto", pid: 40532 },
      { slug: "generated-gerbil", pid: 97184 },
    ]);
    // 40454 is the spawned shim; 40532 is its child, which wrote the lock.
    expect(devinSessionIdForPids(new Set([40454, 40532]), home)).toBe(
      "ionized-pluto",
    );
    // The spawned pid alone never matches — that was the bug in the premise.
    expect(devinSessionIdForPids(new Set([40454]), home)).toBeUndefined();
    expect(devinSessionIdForPids(new Set(), home)).toBeUndefined();
  });

  it("prefers the newest lock when a dead one holds a recycled PID", () => {
    // Locks are never removed, so an old session can name a PID the OS has
    // since handed to our own tree.
    const home = homeWithLocks([
      { slug: "stale-relic", pid: 40532, ageMs: 30 * 24 * 60 * 60 * 1000 },
      { slug: "ionized-pluto", pid: 40532 },
    ]);
    expect(readDevinLocks(home)[0]?.sessionId).toBe("ionized-pluto");
    expect(devinSessionIdForPids(new Set([40532]), home)).toBe("ionized-pluto");
  });

  it("ignores unreadable, non-numeric, and non-lock entries", () => {
    const home = mkdtempSync(join(tmpdir(), "junto-devin-"));
    temps.push(home);
    const dir = devinSessionLocksDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken-lock.lock"), "not-a-pid\n", "utf8");
    writeFileSync(join(dir, "notes.txt"), "12345\n", "utf8");
    expect(readDevinLocks(home)).toEqual([]);
    expect(devinSessionIdForPids(new Set([12345]), home)).toBeUndefined();
  });

  it("walks the whole tree, not one generation", async () => {
    // 10 → 11 → 12: the lock-writer can be a grandchild.
    const ps = async () => ({ stdout: "  1  0\n 10  1\n 11 10\n 12 11\n 99  1\n" });
    const tree = await collectProcessTreePids(10, ps);
    expect([...tree].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(tree.has(99)).toBe(false);
  });

  it("survives ps failing — the seat still runs, it just has no id", async () => {
    const tree = await collectProcessTreePids(10, async () => {
      throw new Error("ps unavailable");
    });
    expect([...tree]).toEqual([10]);
  });

  it("stops laddering when the generation is gone", async () => {
    const home = homeWithLocks([{ slug: "ionized-pluto", pid: 40532 }]);
    const found = await discoverDevinSessionId({
      pid: 40532,
      home,
      delays: [0],
      stillRunning: () => false,
    });
    expect(found).toBeUndefined();
  });

  it("finds the id when the lock names a live tree member", async () => {
    const home = homeWithLocks([{ slug: "ionized-pluto", pid: process.pid }]);
    const found = await discoverDevinSessionId({
      pid: process.pid,
      home,
      delays: [0],
    });
    expect(found).toBe("ionized-pluto");
  });
});

/**
 * Proof is the `sessions` row, because that is what `-r` reads. A lock-only
 * slug is refused by the CLI itself: `No session found matching '<slug>'`.
 */
describe("devin proof is the sessions row, not the lock", () => {
  const temps: string[] = [];

  afterEach(() => {
    __setSessionExistenceHomeForTest(undefined);
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const devinHome = (): { home: string; root: string } => {
    const home = mkdtempSync(join(tmpdir(), "junto-devin-proof-"));
    temps.push(home);
    const root = join(home, ".local", "share", "devin", "cli");
    mkdirSync(join(root, "session_locks"), { recursive: true });
    mkdirSync(join(root, "transcripts"), { recursive: true });
    return { home, root };
  };

  const writeSessionsDb = (root: string, ids: readonly string[]): void => {
    // node:sqlite is the same reader session-existence uses.
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(root, "sessions.db"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT)");
    for (const id of ids) {
      db.prepare("INSERT INTO sessions (id, working_directory) VALUES (?, ?)").run(
        id,
        "/private/tmp",
      );
    }
    db.close();
  };

  it("a lock alone is not proof — the CLI refuses to resume it", () => {
    const { home, root } = devinHome();
    writeFileSync(join(root, "session_locks", "muddled-fear.lock"), "40532\n");
    writeSessionsDb(root, ["ionized-pluto"]);

    expect(
      harnessSessionExists({ harness: "devin", sessionId: "muddled-fear", home }),
    ).toBe(false);
    expect(
      harnessSessionExists({ harness: "devin", sessionId: "ionized-pluto", home }),
    ).toBe(true);
    expect(
      harnessSessionExists({ harness: "devin", sessionId: "never-existed", home }),
    ).toBe(false);
  });

  it("keeps the legacy transcript as a fallback proof", () => {
    const { home, root } = devinHome();
    writeFileSync(
      join(root, "transcripts", "generated-gerbil.json"),
      '{"schema_version":"1.7"}',
    );
    expect(
      harnessSessionExists({
        harness: "devin",
        sessionId: "generated-gerbil",
        home,
      }),
    ).toBe(true);
  });

  it("reads devin's own resume refusal as a dead resume", () => {
    expect(
      isHarnessResumeFailureText("Error: No session found matching 'muddled-fear'"),
    ).toBe(true);
    expect(isHarnessResumeFailureText("welcome to devin")).toBe(false);
  });
});
