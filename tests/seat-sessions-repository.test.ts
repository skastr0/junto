/**
 * Seat sessions: recording a seat's sessions in its machine store,
 * ending and reopening them, writing offboard notes, and finding transcripts.
 * Every store and home lives under a temp root.
 */
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
import { seatSessionTransitions } from "../src/main/junto/seat-sessions/transitions";
import {
  __setSessionExistenceHomeForTest,
  encodeClaudeProjectCwd,
} from "../src/main/junto/term/session-existence";
import {
  gistOfNotes,
  SEAT_SESSION_CONTINUATION_MAX_CHARS,
  SEAT_SESSION_NOTES_MAX_CHARS,
} from "../src/shared/seat-sessions";
import { canvasOf, note, seat as seatNode } from "./support/model-nodes";
import type { Canvas, Node } from "../src/shared/model";
import type { HarnessId } from "../src/shared/managed-terminal-templates";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<SeatSessionRepository, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-seat-sessions-"));
  runtime = ManagedRuntime.make(
    makeSeatSessionRepositoryLive().pipe(
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

const seat = (id: string, terminal: { harness?: HarnessId; bindingId?: string; cwd?: string }): Node =>
  seatNode(id, {
    width: 120,
    height: 48,
    bindingId: (terminal.bindingId ?? `bind-${id}`) as never,
    harness: terminal.harness ?? "claude",
    launch: { kind: "harness", argv: ["claude"], ...(terminal.cwd ? { cwd: terminal.cwd } : {}) },
  });

const doc = (...nodes: Node[]): Canvas => canvasOf(nodes);

describe("seat session transitions", () => {
  it("retires the former occupant on a changed binding or harness only", () => {
    const original = seat("a", {});
    expect(seatSessionTransitions(undefined, doc(original))).toEqual([]);
    expect(seatSessionTransitions(doc(original), doc({ ...original, x: 40 }))).toEqual([]);
    const changed = seat("a", { harness: "codex", bindingId: "bind-2" });
    expect(seatSessionTransitions(doc(original), doc(changed))).toEqual([{ seatId: "a", bindingId: "bind-a" }]);
    expect(seatSessionTransitions(doc(original), doc())).toEqual([]);
    expect(seatSessionTransitions(undefined, doc(note("n")))).toEqual([]);
  });
});

describe("SeatSessionRepository", () => {
  it("concurrent pinning keeps one id and a delayed reseat cannot end a new occupant", async () => {
    const r = await run(repo);
    const pins = await Promise.all(["s1", "s2"].map(sessionId => run(r.pin({
      seatId: "a", bindingId: "bind-a", harness: "claude", sessionId,
    }))));
    expect(pins[0]?.sessionId).toBe(pins[1]?.sessionId);
    expect(pins.filter(pin => pin.minted)).toHaveLength(1);
    expect(await run(r.current("a", "new-binding"))).toBeUndefined();
    await run(r.pin({ seatId: "a", bindingId: "new-binding", harness: "claude", sessionId: "fresh" }));
    await run(recordCanvasChange({ previous: doc(seat("a", {})), next: doc(seat("a", { bindingId: "new-binding" })) }));
    expect(await run(r.current("a", "new-binding"))).toMatchObject({ sessionId: "fresh" });
    expect(await run(r.current("a", "bind-a"))).toBeUndefined();
  });

  it("keeps an ordered history: one open session, ended ones with their reason", async () => {
    const sessions = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        expect(yield* r.record({ seatId: "a", sessionId: "s1", harness: "claude" })).toEqual({ started: true });
        // Seeing the open session again is a no-op.
        expect(yield* r.record({ seatId: "a", sessionId: "s1", harness: "claude" })).toEqual({ started: false });
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

  it("keeps offboard notes on the session's row and records the gist, starting history if needed", async () => {
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
    const notesOf = () => run(Effect.flatMap(repo, (r) => r.notesOf("a", ["s1"])));
    expect((await notesOf()).get("s1")).toEqual({ notes: notes.trim() });

    // Offboarding again replaces the notes whole.
    await run(
      Effect.gen(function* () {
        const r = yield* repo;
        yield* r.offboard({ seatId: "a", sessionId: "s1", harness: "claude", notes: "Second pass", gist: "Second pass" });
      }),
    );
    expect((await notesOf()).get("s1")).toEqual({ notes: "Second pass" });
    expect(readdirSync(root)).not.toContain("seats");
  });

  it("records local pins and lists each session with its transcript", async () => {
    const home = join(root, "home");
    __setSessionExistenceHomeForTest(home);
    const cwd = "/Users/me/proj";
    const project = join(home, ".claude", "projects", encodeClaudeProjectCwd(cwd));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "s1.jsonl"), "{}\n");

    const sessions = await run(
      Effect.gen(function* () {
        const r = yield* SeatSessionRepository;
        yield* r.record({ seatId: "a", bindingId: "bind-a", harness: "claude", sessionId: "s1", cwd });
        yield* r.record({ seatId: "a", bindingId: "bind-a", harness: "claude", sessionId: "s2", cwd });
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

describe("a session's transcript at close", () => {
  const cwd = "/Users/me/proj";
  const opened = (sessionId: string, harness = "claude") =>
    Effect.flatMap(repo, (r) => r.record({ seatId: "a", bindingId: "bind-a", harness, sessionId, cwd }));
  const written = (sessionId: string) => {
    const project = join(root, "home", ".claude", "projects", encodeClaudeProjectCwd(cwd));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${sessionId}.jsonl`), "{}\n");
    return join(project, `${sessionId}.jsonl`);
  };
  // The stored row, not a listing: a listing would look the path up itself.
  const stored = async (sessionId: string) =>
    (await run(Effect.flatMap(repo, (r) => r.list("a")))).find((s) => s.sessionId === sessionId);

  beforeEach(() => __setSessionExistenceHomeForTest(join(root, "home")));

  it.each([
    ["a reseat to another harness", "reseat", recordCanvasChange({
      previous: doc(seat("a", {})), next: doc(seat("a", { harness: "codex", bindingId: "bind-2" })),
    })],
    ["a pin under a new binding", "reseat", Effect.flatMap(repo, (r) => r.pin({ seatId: "a", bindingId: "bind-2", harness: "codex", sessionId: "next" }))],
    ["a new id", "replaced", opened("next")],
    ["a rotation", "offboard", Effect.flatMap(repo, (r) => r.end("a", "offboard", "s1"))],
  ] as const)("is saved by %s", async (_how, reason, close) => {
    await run(opened("s1"));
    const path = written("s1");
    await run(close as Effect.Effect<unknown, unknown, SeatSessionRepository>);
    expect(await stored("s1")).toMatchObject({ endReason: reason, transcriptPath: path });
  });

  it("keeps a path already found", async () => {
    await run(opened("s1"));
    written("s1");
    await run(Effect.flatMap(repo, (r) => r.noteTranscript("a", "s1", "/elsewhere/s1.jsonl")));
    await run(Effect.flatMap(repo, (r) => r.end("a", "reseat")));
    expect((await stored("s1"))?.transcriptPath).toBe("/elsewhere/s1.jsonl");
  });

  it("is none for a session the harness never wrote, and a listing says so", async () => {
    await run(opened("s1"));
    await run(Effect.flatMap(repo, (r) => r.end("a", "reseat")));
    expect(await stored("s1")).not.toHaveProperty("transcriptPath");
    const [listed] = await run(listSeatSessions("a"));
    expect(listed).toMatchObject({ sessionId: "s1", transcriptMissing: "none" });
    expect(listed).not.toHaveProperty("transcriptPath");
  });

  it("is kept as the harness reports it, only inside its store and only while the row has none", async () => {
    await run(opened("s1"));
    const path = written("s1");
    const report = (over: { path?: string; bindingId?: string; fidelity?: "native" | "screen" } = {}) =>
      Effect.flatMap(repo, (r) => r.noteReportedTranscript({
        bindingId: over.bindingId ?? "bind-a", sessionId: "s1", path: over.path ?? path, channel: "report", fidelity: over.fidelity ?? "native",
      }));
    // Another binding's report, a path outside the store, a screen read: none of them name this row's transcript.
    expect(await run(report({ bindingId: "bind-other" }))).toBe(false);
    expect(await run(report({ path: "/etc/passwd" }))).toBe(false);
    expect(await run(report({ fidelity: "screen" }))).toBe(false);
    expect((await stored("s1"))?.transcriptPath).toBeUndefined();
    expect(await run(report())).toBe(true);
    expect((await stored("s1"))?.transcriptPath).toBe(realpathSync(path));
    // A path the row already has stands.
    const other = written("s1-copy");
    expect(await run(report({ path: other }))).toBe(false);
    expect((await stored("s1"))?.transcriptPath).toBe(realpathSync(path));
  });

  it("cannot be looked for under a harness whose sessions Junto cannot find", async () => {
    await run(opened("s1", "junto-overseer"));
    await run(Effect.flatMap(repo, (r) => r.end("a", "reseat")));
    const [listed] = await run(listSeatSessions("a"));
    expect(listed).toMatchObject({ sessionId: "s1", transcriptMissing: "unsearchable" });
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

  it("an offboard that did not go through leaves no wind-down on the session; one that ended stays", async () => {
    const repository = await run(offboarded("a", "s1"));
    await run(repository.beginDrain("a", "s1", 1_000));
    await run(offboarded("a", "s2"));
    await run(repository.beginDrain("a", "s2", 1_000));
    await run(repository.endDrain("a", "s2", "settled", 2_000));
    await run(repository.cancelDrain("a", "s1"));
    await run(repository.cancelDrain("a", "s2"));
    expect((await run(sessionOf("a", "s1")))?.drain).toBeUndefined();
    expect((await run(sessionOf("a", "s2")))?.drain).toMatchObject({ endedHow: "settled" });
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

describe("a session's notes and marks, kept on its row", () => {
  const offboard = (sessionId: string, notes: string, continuation?: string) =>
    run(Effect.flatMap(repo, (r) =>
      r.offboard({ seatId: "a", sessionId, harness: "claude", notes, gist: gistOfNotes(notes)!, ...(continuation ? { continuation } : {}) }),
    ));
  const notesOf = (sessionIds: ReadonlyArray<string>, seatId = "a") => run(Effect.flatMap(repo, (r) => r.notesOf(seatId, sessionIds)));
  const listed = (sessionId: string) =>
    run(Effect.flatMap(repo, (r) => r.list("a"))).then((sessions) => sessions.find((session) => session.sessionId === sessionId));

  it("hands back the notes and continuation of the sessions asked for, and nothing for one that never offboarded", async () => {
    await offboard("s1", "# First\n\n- done\n", "Pick up the retry");
    await run(Effect.flatMap(repo, (r) => r.record({ seatId: "a", sessionId: "s2", harness: "claude" })));
    await offboard("s3", "Third");
    const found = await notesOf(["s1", "s2", "s3", "s1"]);
    expect(Object.fromEntries(found)).toEqual({
      s1: { notes: "# First\n\n- done", continuation: "Pick up the retry" },
      s3: { notes: "Third" },
    });
    expect(Object.fromEntries(await notesOf(["s3"]))).toEqual({ s3: { notes: "Third" } });
    expect((await notesOf([])).size).toBe(0);
    // Another seat's session of the same id is not this seat's.
    expect((await notesOf(["s1"], "b")).size).toBe(0);
  });

  it("the latest offboard decides: notes are replaced whole, and a plain one withdraws a continuation", async () => {
    await offboard("s1", "First pass", "Next: retry");
    await offboard("s1", "Second pass");
    expect(Object.fromEntries(await notesOf(["s1"]))).toEqual({ s1: { notes: "Second pass" } });
  });

  it("bounds the text as before: notes and continuation cut at their limits", async () => {
    await offboard("s1", `  ${"n".repeat(SEAT_SESSION_NOTES_MAX_CHARS + 50)}  `, "c".repeat(SEAT_SESSION_CONTINUATION_MAX_CHARS + 50));
    const kept = (await notesOf(["s1"])).get("s1")!;
    expect(kept.notes).toHaveLength(SEAT_SESSION_NOTES_MAX_CHARS);
    expect(kept.continuation).toHaveLength(SEAT_SESSION_CONTINUATION_MAX_CHARS);
  });

  it("keeps whether a session onboarded on that session alone, so a fresh one starts without it", async () => {
    const onboarded = (sessionId: string) => run(Effect.flatMap(repo, (r) => r.onboarded("a", sessionId)));
    await run(Effect.flatMap(repo, (r) => r.record({ seatId: "a", sessionId: "s1", harness: "claude" })));
    expect(await onboarded("s1")).toBe(false);
    await run(Effect.flatMap(repo, (r) => r.markOnboarded("a", "s1", 1_000)));
    await run(Effect.flatMap(repo, (r) => r.markOnboarded("a", "s1", 2_000)));
    expect(await onboarded("s1")).toBe(true);
    await run(Effect.flatMap(repo, (r) => r.record({ seatId: "a", sessionId: "s2", harness: "claude" })));
    expect(await onboarded("s2")).toBe(false);
    // Resumed, the earlier session reads its own mark back.
    await run(Effect.flatMap(repo, (r) => r.record({ seatId: "a", sessionId: "s1", harness: "claude" })));
    expect(await onboarded("s1")).toBe(true);
    expect(await onboarded("never-seen")).toBe(false);
  });

  it("saves the operator offboard clock whole and reads it back", async () => {
    expect(await run(Effect.flatMap(repo, (r) => r.offboardClock()))).toBeUndefined();
    const first = {
      savedAt: 5_000,
      seats: {
        "bind-a": { idleSince: 1_000, activitySince: 900, offboarded: true, workMs: 1_234, sessionId: "s1" },
        "bind-b": { activitySince: 2_000 },
      },
    };
    await run(Effect.flatMap(repo, (r) => r.saveOffboardClock(first)));
    expect(await run(Effect.flatMap(repo, (r) => r.offboardClock()))).toEqual(first);
    // A later save replaces it: a seat it no longer names is gone.
    const second = { savedAt: 6_000, seats: { "bind-b": { idleSince: 5_500, workMs: 10.6 } } };
    await run(Effect.flatMap(repo, (r) => r.saveOffboardClock(second)));
    expect(await run(Effect.flatMap(repo, (r) => r.offboardClock()))).toEqual({
      savedAt: 6_000,
      seats: { "bind-b": { idleSince: 5_500, workMs: 10 } },
    });
  });

  it("saves only the clock's changes: named seats are written, removed ones go, the rest stand", async () => {
    await run(Effect.flatMap(repo, (r) => r.saveOffboardClock({
      savedAt: 5_000,
      seats: { "bind-a": { idleSince: 1_000 }, "bind-b": { activitySince: 2_000 }, "bind-c": { workMs: 7 } },
    })));
    await run(Effect.flatMap(repo, (r) => r.saveOffboardClockChanges({
      savedAt: 8_000,
      seats: { "bind-b": { idleSince: 7_000, activitySince: 2_000, workMs: 3.9 }, "bind-d": { sessionId: " s4 " } },
      removed: ["bind-c"],
    })));
    expect(await run(Effect.flatMap(repo, (r) => r.offboardClock()))).toEqual({
      savedAt: 8_000,
      seats: {
        "bind-a": { idleSince: 1_000 },
        "bind-b": { idleSince: 7_000, activitySince: 2_000, workMs: 3 },
        "bind-d": { sessionId: "s4" },
      },
    });
  });

  it("reads every open session in one read, with its binding", async () => {
    await run(Effect.flatMap(repo, (r) => r.record({ seatId: "a", sessionId: "s1", harness: "claude", bindingId: "bind-a" })));
    await run(Effect.flatMap(repo, (r) => r.record({ seatId: "a", sessionId: "s2", harness: "claude", bindingId: "bind-a" })));
    await run(Effect.flatMap(repo, (r) => r.record({ seatId: "b", sessionId: "s3", harness: "codex" })));
    const open = await run(Effect.flatMap(repo, (r) => r.openSessions()));
    expect([...open].sort((x, y) => x.seatId.localeCompare(y.seatId))).toEqual([
      { seatId: "a", sessionId: "s2", bindingId: "bind-a" },
      { seatId: "b", sessionId: "s3" },
    ]);
  });

  it("records who ended a session from outside it, and forgets it when the session is the seat's again", async () => {
    await run(Effect.flatMap(repo, (r) => r.record({ seatId: "a", sessionId: "s1", harness: "claude" })));
    await run(Effect.flatMap(repo, (r) => r.end("a", "replaced", "s1")));
    await run(Effect.flatMap(repo, (r) => r.markEnded("a", "s1", "automatic")));
    expect((await listed("s1"))?.endedBy).toBe("automatic");
    await run(Effect.flatMap(repo, (r) => r.record({ seatId: "a", sessionId: "s1", harness: "claude" })));
    expect((await listed("s1"))?.endedBy).toBeUndefined();
  });
});
