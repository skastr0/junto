import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverCodexSessionId,
  isCodexSessionId,
} from "../src/main/junto/term/templates/codex-session";
import { discoversSessionAfterSpawn } from "../src/main/junto/term/seat-session-capture";

const ROOT_ID = "01a0e983-fee2-7ff2-97db-b10259aa4d84";
const CHILD_ID = "01a0e983-aaaa-7ff2-97db-b10259aa4d84";
const OLD_ID = "01a0e983-bbbb-7ff2-97db-b10259aa4d84";
const OTHER_ID = "01a0e983-cccc-7ff2-97db-b10259aa4d84";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const pad = (n: number): string => String(n).padStart(2, "0");

const rollout = (
  home: string,
  at: Date,
  meta: { id: string; cwd: string; threadSource?: string; source?: unknown },
): void => {
  const dir = join(
    home,
    ".codex",
    "sessions",
    String(at.getFullYear()),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-x-${meta.id}.jsonl`);
  const line = JSON.stringify({
    timestamp: at.toISOString(),
    type: "session_meta",
    payload: {
      id: meta.id,
      session_id: meta.id,
      timestamp: at.toISOString(),
      cwd: meta.cwd,
      source: meta.source ?? "cli",
      thread_source: meta.threadSource ?? "user",
      // The real first line carries ~20KB of instructions.
      base_instructions: { text: "x".repeat(100_000) },
    },
  });
  writeFileSync(path, `${line}\n{"type":"event_msg"}\n`);
  utimesSync(path, at, at);
};

describe("codex session discovery", () => {
  it("finds the root thread this seat started in its workspace", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    homes.push(home);
    const cwd = mkdtempSync(join(tmpdir(), "codex-seat-"));
    homes.push(cwd);
    const spawnedAtMs = Date.now() - 60_000;
    rollout(home, new Date(spawnedAtMs - 3_600_000), { id: OLD_ID, cwd });
    rollout(home, new Date(spawnedAtMs + 5_000), { id: OTHER_ID, cwd: "/elsewhere" });
    rollout(home, new Date(spawnedAtMs + 10_000), { id: ROOT_ID, cwd });
    rollout(home, new Date(spawnedAtMs + 20_000), { id: CHILD_ID, cwd, threadSource: "subagent" });
    rollout(home, new Date(spawnedAtMs + 1_000), {
      id: "01a0e983-dddd-7ff2-97db-b10259aa4d84",
      cwd,
      source: { subagent: { thread_spawn: { parent_thread_id: ROOT_ID } } },
    });
    expect(discoverCodexSessionId({ cwd, spawnedAtMs, home })).toBe(ROOT_ID);
  });

  it("answers undefined until Codex has written a rollout", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    homes.push(home);
    expect(discoverCodexSessionId({ cwd: "/tmp", spawnedAtMs: Date.now(), home })).toBeUndefined();
  });

  it("is watched after spawn and recognises its own ids", () => {
    expect(discoversSessionAfterSpawn("codex")).toBe(true);
    expect(isCodexSessionId(ROOT_ID)).toBe(true);
    expect(isCodexSessionId("not-a-thread")).toBe(false);
  });
});
