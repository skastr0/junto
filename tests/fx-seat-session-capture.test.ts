import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  write: vi.fn(async (_input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly sessionId: string;
    readonly onlyIfAbsent?: boolean;
    readonly capture?: { readonly isCurrent: () => boolean };
  }) => ({ ok: true as const })),
}));

// The canvas persistence boundary is recorded; discovery reads a real fx
// index and every capture decision runs through the production service.
vi.mock("../src/main/junto/term/seat-session-id", () => ({
  writeSeatSessionId: persistence.write,
}));

import { SeatSessionCapture } from "../src/main/junto/term/seat-session-capture";
import { FX_INDEX_SCHEMA_VERSION } from "../src/main/junto/term/templates/fx-session";

const SESSION = "1787761861883-1787761861883720000-7afaf80c8f5acd35";
const OTHER_SESSION = "1787761862883-1787761862883720000-97d25f70d04d6c5e";
const SPAWN = 1787761861000;
const homes: string[] = [];

const fixture = (
  rows: readonly { readonly id: string; readonly workspace: string }[],
): { readonly home: string; readonly capture: SeatSessionCapture } => {
  const home = mkdtempSync(join(tmpdir(), "vc-fx-capture-"));
  homes.push(home);
  const root = join(home, ".fx", "sessions");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.json"), JSON.stringify({
    schema_version: FX_INDEX_SCHEMA_VERSION,
    sessions: rows.map((row) => ({
      id: row.id,
      created_at_ms: SPAWN + 1000,
      workspace_root: row.workspace,
    })),
  }));
  return { home, capture: new SeatSessionCapture(() => home) };
};

const watch = (
  capture: SeatSessionCapture,
  bindingId: string,
  cwd = "/workspace/shared",
): void => capture.watch({
  bindingId,
  harness: "fx",
  canvasName: "factory",
  nodeId: `agent-${bindingId}`,
  cwd,
  spawnedAtMs: SPAWN,
});

afterEach(() => {
  persistence.write.mockClear();
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("fx capture candidate ownership", () => {
  it("does not assign a unique index row to either of two eligible seats", async () => {
    const { capture } = fixture([{ id: SESSION, workspace: "/workspace/shared" }]);
    watch(capture, "a");
    watch(capture, "b");

    expect(await Promise.all([capture.attempt("a"), capture.attempt("b")]))
      .toEqual([undefined, undefined]);
    expect(persistence.write).not.toHaveBeenCalled();
    expect(capture.pending()).toEqual(["a", "b"]);
  });

  it("does not give a captured session to a later sibling after forgetting its watcher", async () => {
    const { capture } = fixture([{ id: SESSION, workspace: "/workspace/shared" }]);
    watch(capture, "a");
    expect(await capture.attempt("a")).toBe(SESSION);
    capture.forget("a");

    watch(capture, "b");
    expect(await capture.attempt("b")).toBeUndefined();
    expect(persistence.write.mock.calls.map(([input]) => input.nodeId))
      .toEqual(["agent-a"]);
  });

  it("captures separate indexed sessions for separate workspaces", async () => {
    const { capture } = fixture([
      { id: SESSION, workspace: "/workspace/a" },
      { id: OTHER_SESSION, workspace: "/workspace/b" },
    ]);
    watch(capture, "a", "/workspace/a");
    watch(capture, "b", "/workspace/b");

    expect(await Promise.all([capture.attempt("a"), capture.attempt("b")]))
      .toEqual([SESSION, OTHER_SESSION]);
    expect(persistence.write.mock.calls.map(([input]) => [input.nodeId, input.sessionId]))
      .toEqual([["agent-a", SESSION], ["agent-b", OTHER_SESSION]]);
  });

  it("keeps a replacement watcher when an old persistence operation completes", async () => {
    const { capture } = fixture([{ id: SESSION, workspace: "/workspace/shared" }]);
    let complete!: (result: { readonly ok: true }) => void;
    persistence.write.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    watch(capture, "a");
    const oldAttempt = capture.attempt("a");
    const oldGeneration = persistence.write.mock.calls[0]![0].capture!;
    expect(oldGeneration.isCurrent()).toBe(true);

    capture.forget("a");
    watch(capture, "a");
    expect(oldGeneration.isCurrent()).toBe(false);
    complete({ ok: true });

    expect(await oldAttempt).toBeUndefined();
    expect(capture.pending()).toEqual(["a"]);
    expect(await capture.attempt("a")).toBeUndefined();
    expect(persistence.write).toHaveBeenCalledTimes(1);
  });
});
