/**
 * A seat that offboarded leaves its old process winding down in the same
 * working directory, still writing its session file. The fresh session must
 * never take that id for its own.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  write: vi.fn(async (_input: { readonly sessionId: string }) => ({ ok: true as const })),
}));

// The canvas write is recorded; every discovery reads real files in a temp
// folder and every capture decision runs through the production service.
vi.mock("../src/main/junto/term/seat-session-id", () => ({
  writeSeatSessionId: persistence.write,
}));

import { SeatSessionCapture } from "../src/main/junto/term/seat-session-capture";
import {
  __setCapturedSessionWriterForTest,
  persistCapturedSessionId,
  scheduleCapturedSessionPersist,
  resetCapturedSessionPersistForTest,
} from "../src/main/junto/term/session-capture-persist";
import { __setSessionExistenceHomeForTest } from "../src/main/junto/term/session-existence";
import { discoverCodexSessionId } from "../src/main/junto/term/templates/codex-session";
import { FX_INDEX_SCHEMA_VERSION, discoverFxSessionId } from "../src/main/junto/term/templates/fx-session";
import { discoverOmpSessionId, ompSessionsDir } from "../src/main/junto/term/templates/omp-session";

const temps: string[] = [];
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

afterEach(() => {
  persistence.write.mockClear();
  __setCapturedSessionWriterForTest(undefined);
  __setSessionExistenceHomeForTest(undefined);
  resetCapturedSessionPersistForTest();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DRAINING = "01a0e983-aaaa-7ff2-97db-b10259aa4d84";
const FRESH = "01a0e983-bbbb-7ff2-97db-b10259aa4d84";

const pad = (n: number): string => String(n).padStart(2, "0");

/** One Codex rollout file, as Codex writes its first line. */
const codexRollout = (home: string, at: Date, id: string, cwd: string): string => {
  const dir = join(
    home,
    ".codex",
    "sessions",
    String(at.getFullYear()),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-x-${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: at.toISOString(),
      type: "session_meta",
      payload: { id, session_id: id, timestamp: at.toISOString(), cwd, source: "cli", thread_source: "user" },
    })}\n`,
  );
  utimesSync(path, at, at);
  return path;
};

describe("codex: two rollouts in one directory, the older one still growing", () => {
  const scene = () => {
    const home = temp("drain-codex-home-");
    const cwd = temp("drain-codex-cwd-");
    const freshSpawn = Date.now() - 30_000;
    // The old session started one second before the fresh one: the rotation
    // is immediate, so it sits inside the fresh seat's start-time tolerance.
    const oldPath = codexRollout(home, new Date(freshSpawn - 1_000), DRAINING, cwd);
    codexRollout(home, new Date(freshSpawn + 4_000), FRESH, cwd);
    // The draining process keeps writing its file.
    appendFileSync(oldPath, '{"type":"event_msg"}\n');
    return { home, cwd, freshSpawn };
  };

  it("without the exclusion the fresh seat would be handed the draining session", () => {
    const { home, cwd, freshSpawn } = scene();
    expect(discoverCodexSessionId({ cwd, spawnedAtMs: freshSpawn, home })).toBe(DRAINING);
  });

  it("with it, the draining id is skipped and the seat's own session is found behind it", () => {
    const { home, cwd, freshSpawn } = scene();
    expect(
      discoverCodexSessionId({ cwd, spawnedAtMs: freshSpawn, home, exclude: new Set([DRAINING]) }),
    ).toBe(FRESH);
  });

  it("the seat's capture never stores the draining id, before or after its own exists", async () => {
    const home = temp("drain-codex-home-");
    const cwd = temp("drain-codex-cwd-");
    const freshSpawn = Date.now() - 30_000;
    const oldPath = codexRollout(home, new Date(freshSpawn - 1_000), DRAINING, cwd);
    const capture = new SeatSessionCapture(() => home);
    capture.watch({
      bindingId: "bind-1",
      harness: "codex",
      canvasName: "factory",
      nodeId: "agent-1",
      cwd,
      spawnedAtMs: freshSpawn,
      excludeSessionIds: [DRAINING],
    });
    // Only the draining file exists so far, and it is still growing.
    appendFileSync(oldPath, '{"type":"event_msg"}\n');
    expect(await capture.attempt("bind-1")).toBeUndefined();
    expect(persistence.write).not.toHaveBeenCalled();
    expect(capture.pending()).toEqual(["bind-1"]);

    // The fresh session writes its own rollout; the old one grows again.
    codexRollout(home, new Date(freshSpawn + 4_000), FRESH, cwd);
    appendFileSync(oldPath, '{"type":"event_msg"}\n');
    expect(await capture.attempt("bind-1")).toBe(FRESH);
    expect(persistence.write).toHaveBeenCalledTimes(1);
    expect(persistence.write.mock.calls[0]![0].sessionId).toBe(FRESH);
  });
});

describe("the other harnesses that mint an id without printing it", () => {
  it("omp: an excluded file is never chosen, however new it is", () => {
    const home = temp("drain-omp-home-");
    const dir = ompSessionsDir("/work/repo", home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-08-28T09-18-18-179Z_${FRESH}.jsonl`), "{}\n");
    // Written last, so it is the newest file in the directory.
    const old = join(dir, `2026-08-28T09-18-17-000Z_${DRAINING}.jsonl`);
    writeFileSync(old, "{}\n");
    appendFileSync(old, "{}\n");
    const input = { cwd: "/work/repo", spawnedAtMs: 0, home };
    expect(discoverOmpSessionId(input)).toBe(DRAINING);
    expect(discoverOmpSessionId({ ...input, exclude: new Set([DRAINING]) })).toBe(FRESH);
    expect(
      discoverOmpSessionId({ ...input, exclude: new Set([DRAINING, FRESH]) }),
    ).toBeUndefined();
  });

  it("fx: two sessions in one workspace are ambiguous until the draining one is excluded", () => {
    const home = temp("drain-fx-home-");
    const root = join(home, ".fx", "sessions");
    mkdirSync(root, { recursive: true });
    const old = "1787761861883-1787761861883720000-7afaf80c8f5acd35";
    const fresh = "1787761862883-1787761862883720000-97d25f70d04d6c5e";
    const spawn = 1787761861000;
    writeFileSync(
      join(root, "index.json"),
      JSON.stringify({
        schema_version: FX_INDEX_SCHEMA_VERSION,
        sessions: [old, fresh].map((id) => ({
          id,
          created_at_ms: spawn + 1000,
          workspace_root: "/work/shared",
        })),
      }),
    );
    const input = { cwd: "/work/shared", spawnedAtMs: spawn, home };
    expect(discoverFxSessionId(input)).toBeUndefined();
    expect(discoverFxSessionId({ ...input, exclude: new Set([old]) })).toBe(fresh);
  });
});

describe("an id announced by a generation that is no longer the seat's is not stored", () => {
  const SID = "0199a0b1-c2d3-4e5f-8a9b-0c1d2e3f4a5b";
  const seedCodex = (home: string): void => {
    const dir = join(home, ".codex", "sessions", "2026", "08", "25");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-${SID}.jsonl`), "");
  };
  const seat = { canvasName: "factory", nodeId: "agent-1", harness: "codex", sessionId: SID };

  it("refuses before the write when the generation has been replaced", async () => {
    const home = temp("drain-persist-");
    seedCodex(home);
    __setSessionExistenceHomeForTest(home);
    let writes = 0;
    __setCapturedSessionWriterForTest(async () => {
      writes += 1;
      return "written";
    });
    expect(await persistCapturedSessionId({ ...seat, isCurrent: () => false })).toBe("not-current");
    expect(writes).toBe(0);
    expect(await persistCapturedSessionId({ ...seat, isCurrent: () => true })).toBe("written");
    // No claim made: written as before.
    expect(await persistCapturedSessionId(seat)).toBe("written");
    expect(writes).toBe(2);
  });

  it("a proof ladder already running stops when the seat moves on", async () => {
    const home = temp("drain-persist-");
    __setSessionExistenceHomeForTest(home);
    let writes = 0;
    __setCapturedSessionWriterForTest(async () => {
      writes += 1;
      return "written";
    });
    let current = true;
    // First probe finds nothing (the file is not on disk yet); then the seat
    // offboards, and only then does the old session's file appear.
    const ladder = scheduleCapturedSessionPersist(
      "bind-1@e1",
      { ...seat, isCurrent: () => current },
      [0, 20, 20],
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    current = false;
    seedCodex(home);
    expect(await ladder).toBe("not-current");
    expect(writes).toBe(0);
  });
});
