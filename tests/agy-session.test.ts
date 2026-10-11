import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agyBrainRoot,
  agyHistoryPath,
  discoverAgySessionId,
  isAgySessionId,
} from "../src/main/junto/term/templates/agy-session";

let home: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "junto-agy-session-test-"));
});

afterEach(() => {
  if (home) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const seedAgySession = (
  sessionId: string,
  atMs?: number,
): string => {
  const dir = join(agyBrainRoot(home!), sessionId, ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "transcript.jsonl");
  writeFileSync(file, '{"step_index":0}\n', "utf8");
  return dir;
};

describe("isAgySessionId", () => {
  it("validates standard UUIDs", () => {
    expect(isAgySessionId("91c17023-0075-4eda-b4bc-afea69088130")).toBe(true);
    expect(isAgySessionId("256f2d03-3c38-4118-88ba-0dd56162078f")).toBe(true);
  });

  it("validates conv slugs", () => {
    expect(isAgySessionId("conv-9f8e7d6c5b4a")).toBe(true);
  });

  it("rejects empty or invalid strings", () => {
    expect(isAgySessionId("")).toBe(false);
    expect(isAgySessionId("   ")).toBe(false);
    expect(isAgySessionId("short")).toBe(false);
  });
});

describe("discoverAgySessionId", () => {
  it("returns undefined when brain root does not exist", () => {
    const result = discoverAgySessionId({
      cwd: "/work",
      spawnedAtMs: Date.now(),
      home: home!,
    });
    expect(result).toBeUndefined();
  });

  it("discovers an agy session directory created after spawn", () => {
    const sid = "91c17023-0075-4eda-b4bc-afea69088130";
    const spawnedAt = Date.now();
    seedAgySession(sid);

    const result = discoverAgySessionId({
      cwd: "/work",
      spawnedAtMs: spawnedAt,
      home: home!,
    });
    expect(result).toBe(sid);
  });

  it("skips excluded session IDs", () => {
    const sid = "91c17023-0075-4eda-b4bc-afea69088130";
    seedAgySession(sid);

    const result = discoverAgySessionId({
      cwd: "/work",
      spawnedAtMs: Date.now(),
      home: home!,
      exclude: new Set([sid]),
    });
    expect(result).toBeUndefined();
  });

  it("matches workspace URI from history.jsonl when present", () => {
    const sid1 = "11111111-0000-0000-0000-000000000001";
    const sid2 = "22222222-0000-0000-0000-000000000002";
    seedAgySession(sid1);
    seedAgySession(sid2);

    // Create history.jsonl with workspace mapping
    const historyFile = agyHistoryPath(home!);
    const lines = [
      JSON.stringify({ conversationId: sid1, workspace: "/Users/me/project-a" }),
      JSON.stringify({ conversationId: sid2, workspace: "/Users/me/project-b" }),
    ].join("\n");
    writeFileSync(historyFile, `${lines}\n`, "utf8");

    const resultA = discoverAgySessionId({
      cwd: "/Users/me/project-a",
      spawnedAtMs: 0,
      home: home!,
    });
    expect(resultA).toBe(sid1);

    const resultB = discoverAgySessionId({
      cwd: "/Users/me/project-b",
      spawnedAtMs: 0,
      home: home!,
    });
    expect(resultB).toBe(sid2);
  });
});
