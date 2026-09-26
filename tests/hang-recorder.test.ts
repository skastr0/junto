import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HANG_STACK_MAX_FRAMES,
  startHangRecorder,
  trimStack,
  type HangRecorder,
} from "../src/main/junto/observability/hang-recorder";

// Vitest's default forks pool runs this file on its process's main thread,
// which is the thread the recorder's worker attaches to, as in the app.

let dir = "";
let recorder: HangRecorder | undefined;

afterEach(async () => {
  await recorder?.stop();
  recorder = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readRecords = (path: string): Array<Record<string, unknown>> => {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
};

const waitFor = async <T>(read: () => T | undefined, ms: number): Promise<T | undefined> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(50);
  }
  return read();
};

function spinTheMainThreadOnPurpose(ms: number): number {
  const end = Date.now() + ms;
  let turns = 0;
  while (Date.now() < end) turns += 1;
  return turns;
}

const start = (logPath: string, extra: { maxBytes?: number } = {}): HangRecorder =>
  startHangRecorder({
    version: "test",
    logPath,
    stallMs: 300,
    heartbeatMs: 50,
    stackTimeoutMs: 1_500,
    ...extra,
  });

describe("hang recorder", () => {
  it("writes the main thread's stack while it is stalled, then how long it lasted", async () => {
    dir = mkdtempSync(join(tmpdir(), "junto-hangs-"));
    const logPath = join(dir, "logs", "hangs.jsonl");
    recorder = start(logPath);
    await sleep(300);

    spinTheMainThreadOnPurpose(1_500);

    const end = await waitFor(() => readRecords(logPath).find((row) => row.kind === "main-stall-end"), 3_000);
    const rows = readRecords(logPath);
    const stall = rows.find((row) => row.kind === "main-stall");
    expect(stall, JSON.stringify(rows)).toBeDefined();
    expect(stall?.stack).toContain("spinTheMainThreadOnPurpose");
    // Frames name their file, resolved from the inspector's script table.
    expect(stall?.stack).toMatch(/spinTheMainThreadOnPurpose \(\S*hang-recorder\.test\.ts:\d+:\d+\)/u);
    expect(Number(stall?.ms)).toBeGreaterThanOrEqual(300);
    expect(stall?.version).toBe("test");
    expect(end).toBeDefined();
    expect(Number(end?.ms)).toBeGreaterThanOrEqual(1_000);
    // Owner-only, like the other logs beside it.
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it("stays quiet while main keeps turning", async () => {
    dir = mkdtempSync(join(tmpdir(), "junto-hangs-"));
    const logPath = join(dir, "hangs.jsonl");
    recorder = start(logPath);
    await sleep(1_200);
    expect(readRecords(logPath)).toEqual([]);
  });

  it("writes records posted from main, and keeps the file bounded", async () => {
    dir = mkdtempSync(join(tmpdir(), "junto-hangs-"));
    const logPath = join(dir, "hangs.jsonl");
    writeFileSync(logPath, `${"x".repeat(2_000)}\n`, { mode: 0o600 });
    recorder = start(logPath, { maxBytes: 1_000 });
    recorder.record({ kind: "renderer-responsive", ms: 21_000 });
    const row = await waitFor(() => readRecords(logPath).find((r) => r.kind === "renderer-responsive"), 2_000);
    expect(row?.ms).toBe(21_000);
    // The oversized file rotated out to .1 and the new file starts fresh.
    expect(readFileSync(`${logPath}.1`, "utf8").length).toBe(2_001);
    expect(readRecords(logPath)).toHaveLength(1);
  });

  it("trims a stack to its innermost frames", () => {
    const stack = ["", ...Array.from({ length: 100 }, (_, i) => `    at frame${String(i)} (file:///x.js:${String(i)}:1)`)].join("\n");
    const trimmed = trimStack(stack).split("\n");
    expect(trimmed).toHaveLength(HANG_STACK_MAX_FRAMES);
    expect(trimmed[0]).toContain("frame0");
  });
});
