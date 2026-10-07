/**
 * Seat sessions: recording a seat's sessions as its canvas node names them,
 * ending and reopening them, writing offboard notes, and finding transcripts.
 * Every store and home lives under a temp root.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  makeSeatSessionRepositoryLive,
  SeatSessionRepository,
} from "../src/main/junto/seat-sessions/repository";
import { listSeatSessions, recordCanvasChange } from "../src/main/junto/seat-sessions/service";
import { pathSegment, seatSessionNotesPath } from "../src/main/junto/seat-sessions/notes-file";
import { seatSessionTransitions } from "../src/main/junto/seat-sessions/transitions";
import {
  __setSessionExistenceHomeForTest,
  encodeClaudeProjectCwd,
} from "../src/main/junto/term/session-existence";
import { gistOfNotes } from "../src/shared/seat-sessions";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { HarnessId } from "../src/shared/managed-terminal-templates";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<SeatSessionRepository, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-seat-sessions-"));
  runtime = ManagedRuntime.make(
    makeSeatSessionRepositoryLive(join(root, "seats")).pipe(
      Layer.provide(makeStateEngineLive(join(root, "junto.db"))),
    ),
  );
});

afterEach(async () => {
  __setSessionExistenceHomeForTest(undefined);
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, SeatSessionRepository>) => runtime.runPromise(effect);
const repo = Effect.gen(function* () {
  return yield* SeatSessionRepository;
});

const seat = (id: string, terminal: { harness?: HarnessId; bindingId?: string; sessionId?: string; cwd?: string }): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 120,
  height: 48,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: {
      bindingId: terminal.bindingId ?? `bind-${id}`,
      harness: terminal.harness ?? "claude",
      launch: { kind: "harness", argv: ["claude"], ...(terminal.cwd ? { cwd: terminal.cwd } : {}) },
      ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}),
    },
  },
});

const doc = (...nodes: CanvasNode[]): CanvasDoc => ({ nodes, edges: [] });

describe("seat session transitions", () => {
  it("starts a session when a seat's id appears or changes, and names why the old one ended", () => {
    const a = seat("a", {});
    const pinned = seat("a", { sessionId: "s1" });
    expect(seatSessionTransitions(doc(a), doc(pinned))).toEqual([
      { kind: "start", observation: { seatId: "a", sessionId: "s1", harness: "claude", endReason: "replaced" } },
    ]);
    // Same id: nothing happened to the session.
    expect(seatSessionTransitions(doc(pinned), doc({ ...pinned, x: 40 }))).toEqual([]);
    // A new binding or harness is a reseat.
    const reseated = seat("a", { sessionId: "s2", harness: "codex", bindingId: "bind-2" });
    expect(seatSessionTransitions(doc(pinned), doc(reseated))[0]).toMatchObject({
      kind: "start",
      observation: { sessionId: "s2", harness: "codex", endReason: "reseat" },
    });
    // A cleared id ends the session; a removed seat keeps its history.
    expect(seatSessionTransitions(doc(pinned), doc(a))).toEqual([
      { kind: "end", seatId: "a", sessionId: "s1", reason: "replaced" },
    ]);
    expect(seatSessionTransitions(doc(pinned), doc())).toEqual([]);
    // Notes and other nodes are not seats.
    const note: CanvasNode = { id: "n", type: "text", text: "note", x: 0, y: 0, width: 10, height: 10 };
    expect(seatSessionTransitions(undefined, doc(note))).toEqual([]);
  });
});

describe("SeatSessionRepository", () => {
  it("keeps an ordered history: one open session, ended ones with their reason", async () => {
    const sessions = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        expect(yield* r.record({ seatId: "a", sessionId: "s1", harness: "claude" })).toEqual({ started: true });
        // Seeing the open session again is a no-op.
        expect(yield* r.record({ seatId: "a", sessionId: "s1", harness: "claude" })).toEqual({ started: false });
        yield* Effect.sleep("2 millis");
        expect(
          yield* r.record({ seatId: "a", sessionId: "s2", harness: "codex", endReason: "reseat" }),
        ).toEqual({ started: true, ended: "s1" });
        yield* r.record({ seatId: "b", sessionId: "s1", harness: "claude" });
        return yield* r.list("a");
      }),
    );
    expect(sessions.map((s) => [s.sessionId, s.harness, s.endReason ?? "open"])).toEqual([
      ["s2", "codex", "open"],
      ["s1", "claude", "reseat"],
    ]);
    expect(sessions[1]!.endedAt).toBeGreaterThanOrEqual(sessions[1]!.startedAt);
    expect(sessions[0]!.notesPath).toBe(join(root, "seats", "a", "sessions", "s2.md"));
  });

  it("reopens a session the seat goes back to and ends only the named open session", async () => {
    const sessions = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        yield* r.record({ seatId: "a", sessionId: "s1", harness: "claude" });
        yield* r.record({ seatId: "a", sessionId: "s2", harness: "claude" });
        yield* r.record({ seatId: "a", sessionId: "s1", harness: "claude" });
        // s2 is no longer open, so ending it is a no-op.
        expect(yield* r.end("a", "offboard", "s2")).toBeUndefined();
        expect(yield* r.end("a", "offboard")).toBe("s1");
        return yield* r.list("a");
      }),
    );
    expect(sessions.map((s) => [s.sessionId, s.endReason])).toEqual(
      expect.arrayContaining([
        ["s1", "offboard"],
        ["s2", "replaced"],
      ]),
    );
    expect(sessions.every((s) => s.endedAt !== undefined)).toBe(true);
  });

  it("writes offboard notes as a file and records the gist, starting history if needed", async () => {
    const notes = "# Wired the importer\n\n- parser done\n- next: retry on 429\n";
    const offboarded = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        return yield* r.offboard({
          seatId: "a",
          sessionId: "s1",
          harness: "claude",
          notes,
          gist: gistOfNotes(notes)!,
        });
      }),
    );
    expect(offboarded).toMatchObject({ sessionId: "s1", gist: "Wired the importer" });
    expect(offboarded.offboardedAt).toBeTypeOf("number");
    expect(offboarded.endedAt).toBeUndefined();
    expect(await readFile(offboarded.notesPath, "utf8")).toBe(notes);
    expect((await stat(offboarded.notesPath)).mode & 0o777).toBe(0o600);

    // Offboarding again replaces the notes whole.
    await run(
      Effect.gen(function* () {
        const r = yield* repo;
        yield* r.offboard({ seatId: "a", sessionId: "s1", harness: "claude", notes: "Second pass", gist: "Second pass" });
      }),
    );
    expect(await readFile(offboarded.notesPath, "utf8")).toBe("Second pass\n");
  });

  it("keeps notes inside the seat's own directory whatever the ids say", () => {
    expect(pathSegment("seat-1")).toBe("seat-1");
    for (const hostile of ["../../etc", "a/b", ".hidden", "", "x".repeat(200)]) {
      expect(pathSegment(hostile)).toMatch(/^id-[0-9a-f]{32}$/);
    }
    expect(seatSessionNotesPath("/r", "../x", "../../y")).toMatch(/^\/r\/id-[0-9a-f]{32}\/sessions\/id-[0-9a-f]{32}\.md$/);
  });

  it("records what a canvas commit did and lists each session with its transcript", async () => {
    const home = join(root, "home");
    __setSessionExistenceHomeForTest(home);
    const cwd = "/Users/me/proj";
    const project = join(home, ".claude", "projects", encodeClaudeProjectCwd(cwd));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "s1.jsonl"), "{}\n");

    const sessions = await run(
      Effect.gen(function* () {
        yield* recordCanvasChange({ previous: doc(seat("a", { cwd })), next: doc(seat("a", { cwd, sessionId: "s1" })) });
        yield* recordCanvasChange({
          previous: doc(seat("a", { cwd, sessionId: "s1" })),
          next: doc(seat("a", { cwd, sessionId: "s2" })),
        });
        return yield* listSeatSessions("a");
      }),
    );
    expect(sessions.map((s) => [s.sessionId, s.transcriptPath])).toEqual([
      ["s2", undefined],
      ["s1", join(project, "s1.jsonl")],
    ]);
    // The found path is remembered.
    const stored = await run(Effect.flatMap(repo, (r) => r.list("a")));
    expect(stored[1]!.transcriptPath).toBe(join(project, "s1.jsonl"));
  });
});

describe("gistOfNotes", () => {
  it("takes the first line with text, without markdown markers, bounded", () => {
    expect(gistOfNotes("\n\n## Shipped the parser  \nmore")).toBe("Shipped the parser");
    expect(gistOfNotes("- first   item\n")).toBe("first item");
    expect(gistOfNotes("   \n")).toBeUndefined();
    const long = gistOfNotes("a".repeat(400))!;
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("what became of an offboarded session's process", () => {
  const offboarded = (seatId: string, sessionId: string) =>
    Effect.gen(function* () {
      const repository = yield* SeatSessionRepository;
      yield* repository.record({ seatId, sessionId, harness: "claude" });
      yield* repository.offboard({ seatId, sessionId, harness: "claude", notes: "# Done" });
      yield* repository.end(seatId, "offboard", sessionId);
      return repository;
    });
  const sessionOf = (seatId: string, sessionId: string) =>
    Effect.gen(function* () {
      const repository = yield* SeatSessionRepository;
      return (yield* repository.list(seatId)).find((session) => session.sessionId === sessionId);
    });

  it("a session that never offboarded has no drain", async () => {
    await run(Effect.flatMap(repo, (repository) => repository.record({ seatId: "a", sessionId: "s1", harness: "claude" })));
    expect(await run(sessionOf("a", "s1"))).not.toHaveProperty("drain");
  });

  it("shows it winding down from the detach, then ended and how", async () => {
    const repository = await run(offboarded("a", "s1"));
    await run(repository.beginDrain("a", "s1", 1_000));
    expect((await run(sessionOf("a", "s1")))?.drain).toEqual({ detachedAt: 1_000 });

    await run(repository.endDrain("a", "s1", "settled", 61_000));
    const session = await run(sessionOf("a", "s1"));
    expect(session?.drain).toEqual({ detachedAt: 1_000, endedAt: 61_000, endedHow: "settled" });
    // The session itself still ended, as offboard, when the seat moved on.
    expect(session?.endReason).toBe("offboard");
    expect(session?.offboardedAt).toBeDefined();
  });

  it("records each way a drain can end", async () => {
    for (const how of ["settled", "cap", "crashed", "quit"] as const) {
      const repository = await run(offboarded("seat", `s-${how}`));
      await run(repository.beginDrain("seat", `s-${how}`, 10));
      await run(repository.endDrain("seat", `s-${how}`, how, 20));
      expect((await run(sessionOf("seat", `s-${how}`)))?.drain?.endedHow).toBe(how);
    }
  });

  it("the first end recorded stands, and an end is never before its detach", async () => {
    const repository = await run(offboarded("a", "s1"));
    await run(repository.beginDrain("a", "s1", 1_000));
    await run(repository.endDrain("a", "s1", "cap", 500));
    await run(repository.endDrain("a", "s1", "settled", 9_000));
    expect((await run(sessionOf("a", "s1")))?.drain).toEqual({ detachedAt: 1_000, endedAt: 1_000, endedHow: "cap" });
  });

  it("several sessions of one seat can be winding down at once", async () => {
    const repository = await run(offboarded("a", "s1"));
    await run(repository.beginDrain("a", "s1", 1_000));
    await run(offboarded("a", "s2"));
    await run(repository.beginDrain("a", "s2", 2_000));
    await run(repository.endDrain("a", "s2", "settled", 3_000));
    const sessions = await run(Effect.flatMap(repo, (r) => r.list("a")));
    expect(Object.fromEntries(sessions.map((session) => [session.sessionId, session.drain?.endedHow ?? "winding down"]))).toEqual({
      s1: "winding down",
      s2: "settled",
    });
  });

  it("at start, whatever was still winding down is closed as ended when Junto quit", async () => {
    const repository = await run(offboarded("a", "s1"));
    await run(repository.beginDrain("a", "s1", 1_000));
    await run(offboarded("b", "t1"));
    await run(repository.beginDrain("b", "t1", 1_000));
    await run(repository.endDrain("b", "t1", "settled", 2_000));
    expect(await run(repository.closeOpenDrains(50_000))).toBe(1);
    expect((await run(sessionOf("a", "s1")))?.drain).toEqual({ detachedAt: 1_000, endedAt: 50_000, endedHow: "quit" });
    // One that had ended keeps its own end.
    expect((await run(sessionOf("b", "t1")))?.drain?.endedHow).toBe("settled");
    expect(await run(repository.closeOpenDrains(60_000))).toBe(0);
  });

  it("a drain for a session the seat never ran is not recorded, and ending one that is not open does nothing", async () => {
    const repository = await run(repo);
    await run(repository.beginDrain("a", "ghost", 1_000));
    await run(repository.endDrain("a", "ghost", "settled", 2_000));
    expect(await run(repository.list("a"))).toEqual([]);
  });

  it("a session that offboards again starts a new wind-down", async () => {
    const repository = await run(offboarded("a", "s1"));
    await run(repository.beginDrain("a", "s1", 1_000));
    await run(repository.endDrain("a", "s1", "settled", 2_000));
    await run(repository.beginDrain("a", "s1", 5_000));
    expect((await run(sessionOf("a", "s1")))?.drain).toEqual({ detachedAt: 5_000 });
  });
});
