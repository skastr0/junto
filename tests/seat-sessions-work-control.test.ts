/**
 * `junto offboard` and onboard's past sessions over the real work-control
 * socket: the process-bound seat writes notes for its own current session
 * only, and the next onboard hands back past sessions, newest first, with the
 * latest notes inline, the paths to the rest, and the past-sessions framing.
 * Every store, home, and socket lives under a temp root.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame, workControlTokenPath } from "../src/shared/work-control";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { respondThen, startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { closingFence } from "../src/main/junto/term/closing-fence";
import { WorkLive } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/junto/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/junto/station/session-registry";
import { SettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { makeProcessIdentityMap } from "../src/main/junto/process-identity";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";
import {
  makeSeatSessionRepositoryLive,
  SeatSessionRepository,
} from "../src/main/junto/seat-sessions/repository";
import { subscribeSeatOffboard, type SeatOffboardEvent } from "../src/main/junto/seat-sessions/service";
import { endedPathOf, writeEndedMarker } from "../src/main/junto/seat-sessions/notes-file";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  CONTINUATION_FRAMING,
  PAST_SESSIONS_FRAMING,
  PREVIOUS_WITHOUT_NOTES_FRAMING,
} from "../src/shared/seat-sessions";

const CANVAS = "sessions";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      makeSeatSessionRepositoryLive(join(root, "seats")),
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
  const workLive = Layer.provideMerge(WorkLive, Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive));
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneAllPlaying));
};

const seatDoc = (sessionId: string | undefined): CanvasDoc => ({
  nodes: [
    {
      id: "agent",
      type: "text",
      x: 0,
      y: 0,
      width: 120,
      height: 48,
      text: "agent",
      ether: {
        entity: { kind: "agent", name: "local:agent" },
        terminal: {
          bindingId: "bind-agent",
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
          ...(sessionId ? { sessionId } : {}),
        },
      },
    },
    {
      id: "other",
      type: "text",
      x: 200,
      y: 0,
      width: 120,
      height: 48,
      text: "other",
      ether: {
        entity: { kind: "agent", name: "local:other" },
        terminal: {
          bindingId: "bind-other",
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
          sessionId: "other-session",
        },
      },
    },
  ],
  edges: [],
});

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-seat-sessions-ctl-"));
  const workHome = join(root, "work");
  mkdirSync(join(root, "canvases"), { recursive: true });
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_CANVASES_DIR = join(root, "canvases");
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(
    settings.setStationTopology({ role: "command-center", hostId: "local", supervisedPreferred: true }),
  );
  await writeSession("s1");
  const processMap = makeProcessIdentityMap();
  processMap.bind(process.pid, { agentKey: "local:agent" });
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    processMap,
    readPeerPid: () => process.pid,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_CANVASES_DIR;
  delete process.env.JUNTO_WORK_HOME;
});

const writeSession = async (sessionId: string | undefined) => {
  const canvases = await runtime.runPromise(CanvasesService);
  await runtime.runPromise(canvases.write(CANVAS, seatDoc(sessionId)));
  // What the app's canvas recorder does on this commit.
  if (sessionId) {
    await runtime.runPromise(
      Effect.flatMap(SeatSessionRepository, (r) => r.record({ seatId: "agent", sessionId, harness: "claude" })),
    );
  }
};

const call = (body: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame(body)));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

const token = () => readFileSync(workControlTokenPath(process.env.JUNTO_WORK_HOME!), "utf8").trim();
const op = (name: string, args: unknown) => call({ token: token(), op: name, args });

describe("junto offboard", () => {
  it("writes notes for the caller's own current session and announces it", async () => {
    const events: SeatOffboardEvent[] = [];
    const unsubscribe = subscribeSeatOffboard((event) => events.push(event));
    try {
      const notes = "# Parser shipped\n\n- next: retry on 429\n- why: nightly sync fails without it";
      const result = await op("offboard", { notes });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ session_id: "s1", gist: "Parser shipped", disposition: "applied" });
      expect(result.data.notes_path).toBe(join(root, "seats", "agent", "sessions", "s1.md"));
      expect(await readFile(result.data.notes_path, "utf8")).toBe(`${notes}\n`);
      expect(events).toEqual([expect.objectContaining({ seatId: "agent", canvasName: CANVAS, sessionId: "s1" })]);

      // Only the caller's own seat: the other seat's history is untouched.
      const other = await runtime.runPromise(Effect.flatMap(SeatSessionRepository, (r) => r.list("other")));
      expect(other).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("seals the seat before it answers, and announces the close only after the answer is written", async () => {
    closingFence.clearForTest();
    const sealedAtAnnounce: boolean[] = [];
    const unsubscribe = subscribeSeatOffboard(() => sealedAtAnnounce.push(closingFence.sealed("bind-agent")));
    try {
      expect(closingFence.sealed("bind-agent")).toBe(false);
      const result = await op("offboard", { notes: "# Done\n\n- nothing left" });
      expect(result.ok).toBe(true);
      // By the time the caller has its answer, nothing can be typed into the session.
      expect(closingFence.sealed("bind-agent")).toBe(true);
      for (let i = 0; i < 20 && sealedAtAnnounce.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(sealedAtAnnounce).toEqual([true]);
      // The reply no longer tells the agent to finish its turn: there is no turn left.
      expect(result.data.next_step).toContain("this session ends now");
      expect(result.data.next_step).not.toMatch(/idle|finish this turn/);
    } finally {
      unsubscribe();
      closingFence.clearForTest();
    }
  });

  it("a refused offboard seals nothing and announces nothing", async () => {
    closingFence.clearForTest();
    const events: SeatOffboardEvent[] = [];
    const unsubscribe = subscribeSeatOffboard((event) => events.push(event));
    try {
      const result = await op("offboard", { notes: "   " });
      expect(result.ok).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closingFence.sealed("bind-agent")).toBe(false);
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("the answer is written before what follows it, and what follows always runs, once", () => {
    const order: string[] = [];
    const envelope = { ok: true, command: "offboard", data: {} } as never;
    respondThen(
      {
        destroyed: false,
        write: ((_frame: unknown, flushed?: () => void) => {
          order.push("written");
          flushed?.();
          flushed?.();
          return true;
        }) as never,
      },
      envelope,
      () => order.push("then"),
    );
    expect(order).toEqual(["written", "then"]);

    // The caller is already gone: the close must still happen.
    const gone: string[] = [];
    respondThen({ destroyed: true, write: (() => true) as never }, envelope, () => gone.push("then"));
    expect(gone).toEqual(["then"]);

    const failed: string[] = [];
    respondThen(
      {
        destroyed: false,
        write: (() => {
          throw new Error("EPIPE");
        }) as never,
      },
      envelope,
      () => failed.push("then"),
    );
    expect(failed).toEqual(["then"]);
  });

  it("refuses notes that say nothing, unknown fields, and a seat whose session id is not known", async () => {
    const empty = await op("offboard", { notes: "  \n " });
    expect(empty).toMatchObject({ ok: false, error: { type: "InputError" } });
    // Identity comes from the process, never from the payload.
    const claimed = await op("offboard", { notes: "x", seatId: "other" });
    expect(claimed).toMatchObject({ ok: false, error: { type: "InputError" } });

    await writeSession(undefined);
    const unknown = await op("offboard", { notes: "Notes" });
    expect(unknown).toMatchObject({ ok: false, error: { type: "InvalidTransition" } });
    expect(unknown.error.details.retryable).toBe(true);
  });
});

describe("junto onboard past sessions", () => {
  it("lists past sessions newest first, latest notes inline, framed as history", async () => {
    await op("offboard", { notes: "First session: set up the repo" });
    await writeSession("s2");
    await op("offboard", { notes: "Second session: wired the parser" });
    await writeSession("s3");
    await writeSession("s4");

    const onboard = await op("onboard", {});
    expect(onboard.ok).toBe(true);
    const sessions = onboard.data.sessions;
    expect(sessions.note).toBe(PAST_SESSIONS_FRAMING);
    expect(sessions.current).toMatchObject({ session_id: "s4", offboarded: false });
    expect(sessions.current.notes_path).toBe(join(root, "seats", "agent", "sessions", "s4.md"));
    expect(sessions.past.map((s: { session_id: string }) => s.session_id)).toEqual(["s3", "s2", "s1"]);
    const [s3, s2, s1] = sessions.past;
    // A session that never offboarded has no notes to point at.
    expect(s3).toMatchObject({ gist: null, notes_path: null, ended_because: "replaced" });
    expect(s3).not.toHaveProperty("notes");
    expect(s2).toMatchObject({
      gist: "Second session: wired the parser",
      notes_path: join(root, "seats", "agent", "sessions", "s2.md"),
      notes: "Second session: wired the parser",
    });
    expect(s1.notes).toBe("First session: set up the repo");

    // The inline count is configurable; older notes keep their paths.
    const one = await op("onboard", { past_notes: 1 });
    const [, t2, t1] = one.data.sessions.past;
    expect(t2.notes).toBe("Second session: wired the parser");
    expect(t1).not.toHaveProperty("notes");
    expect(t1.notes_path).toBe(join(root, "seats", "agent", "sessions", "s1.md"));

    const tooMany = await op("onboard", { past_notes: 99 });
    expect(tooMany).toMatchObject({ ok: false, error: { type: "InputError" } });
  });
});

/** What the closer does once a session has offboarded: end it as an offboard. */
const endAsOffboard = (sessionId: string) =>
  runtime.runPromise(Effect.flatMap(SeatSessionRepository, (r) => r.end("agent", "offboard", sessionId)));

const noteTranscript = (sessionId: string, path: string) =>
  runtime.runPromise(Effect.flatMap(SeatSessionRepository, (r) => r.noteTranscript("agent", sessionId, path)));

describe("junto onboard after an offboard that continues", () => {
  const NOTES = "# Parser half done\n\n- shipped: tokenizer\n- left: the 429 retry in sync.ts";
  const CONTINUATION = "Finish the 429 retry in sync.ts, then run the nightly sync once.";

  const handOver = async () => {
    const offboarded = await op("offboard", { notes: NOTES, continuation: CONTINUATION });
    expect(offboarded.ok).toBe(true);
    await noteTranscript("s1", "/harness/sessions/s1.jsonl");
    await endAsOffboard("s1");
    await writeSession("s2");
  };

  it("hands the next session everything in one place, first", async () => {
    await handOver();
    const onboard = await op("onboard", {});
    expect(onboard.ok).toBe(true);
    // Read first: the handoff leads the answer.
    expect(Object.keys(onboard.data)[0]).toBe("handoff");
    const { handoff } = onboard.data;
    expect(handoff.note).toBe(CONTINUATION_FRAMING);
    // What to do next comes before what happened.
    expect(Object.keys(handoff).indexOf("continuation")).toBeLessThan(Object.keys(handoff).indexOf("notes"));
    expect(handoff).toMatchObject({
      from_session: "s1",
      continuation: CONTINUATION,
      gist: "Parser half done",
      notes: NOTES,
      notes_path: join(root, "seats", "agent", "sessions", "s1.md"),
      transcript_path: "/harness/sessions/s1.jsonl",
    });
    expect(typeof handoff.left_at).toBe("string");
    expect(onboard.data.sessions.current).toMatchObject({ session_id: "s2" });
    expect(onboard.data).not.toHaveProperty("previous_session_without_notes");
  });

  it("does not print the same notes twice", async () => {
    await handOver();
    const onboard = await op("onboard", {});
    const [previous] = onboard.data.sessions.past;
    expect(previous).toMatchObject({
      session_id: "s1",
      ended_because: "offboard",
      gist: "Parser half done",
      notes_path: join(root, "seats", "agent", "sessions", "s1.md"),
      notes_in: "handoff",
    });
    expect(previous).not.toHaveProperty("notes");
    expect(JSON.stringify(onboard.data).split("the 429 retry in sync.ts, then run").length - 1).toBe(1);
    expect(JSON.stringify(onboard.data).split("shipped: tokenizer").length - 1).toBe(1);
  });

  it("carries the notes even when the caller asked for no past notes inline", async () => {
    await handOver();
    const onboard = await op("onboard", { past_notes: 0 });
    expect(onboard.data.handoff.notes).toBe(NOTES);
  });

  it("only the very next session gets the handoff", async () => {
    await handOver();
    await writeSession("s3");
    const onboard = await op("onboard", {});
    expect(onboard.data).not.toHaveProperty("handoff");
    // The notes are history now, inline like any other.
    const s1 = onboard.data.sessions.past.find((s: { session_id: string }) => s.session_id === "s1");
    expect(s1.notes).toBe(NOTES);
    expect(s1).not.toHaveProperty("notes_in");
  });

  it("an offboard that rests leaves notes as history and no handoff", async () => {
    await op("offboard", { notes: NOTES });
    await endAsOffboard("s1");
    await writeSession("s2");
    const onboard = await op("onboard", {});
    expect(onboard.data).not.toHaveProperty("handoff");
    expect(onboard.data).not.toHaveProperty("previous_session_without_notes");
    expect(onboard.data.sessions.past[0]).toMatchObject({ session_id: "s1", notes: NOTES });
  });
});

describe("junto onboard after a session that ended without notes", () => {
  it("says so first, with the previous session's id and transcript as the reference", async () => {
    // Junto ended the session itself: no agent turn, so no notes were written.
    await noteTranscript("s1", "/harness/sessions/s1.jsonl");
    await endAsOffboard("s1");
    await writeSession("s2");

    const onboard = await op("onboard", {});
    expect(onboard.ok).toBe(true);
    expect(Object.keys(onboard.data)[0]).toBe("previous_session_without_notes");
    expect(onboard.data).not.toHaveProperty("handoff");
    const told = onboard.data.previous_session_without_notes;
    expect(told.note).toBe(PREVIOUS_WITHOUT_NOTES_FRAMING);
    expect(told).toMatchObject({
      session_id: "s1",
      ended_because: "offboard",
      transcript_path: "/harness/sessions/s1.jsonl",
    });
    expect(typeof told.ended_at).toBe("string");
    // History to read if needed, never a task: the framing says both.
    expect(PREVIOUS_WITHOUT_NOTES_FRAMING).toMatch(/without (leaving )?notes/);
    expect(PREVIOUS_WITHOUT_NOTES_FRAMING).toMatch(/history/i);
    expect(PREVIOUS_WITHOUT_NOTES_FRAMING).toMatch(/if you need/i);
  });

  it.each(["operator", "overseer", "automatic"] as const)(
    "says who ended it when Junto recorded that: %s",
    async (by) => {
      const notesPath = join(root, "seats", "agent", "sessions", "s1.md");
      writeEndedMarker(notesPath, { by, at: 1_800_000_000_000 });
      await endAsOffboard("s1");
      await writeSession("s2");
      const told = (await op("onboard", {})).data.previous_session_without_notes;
      expect(told).toMatchObject({ session_id: "s1", ended_because: "offboard", ended_by: by });
    },
  );

  it("names nobody when nothing was recorded, or the record cannot be read", async () => {
    await endAsOffboard("s1");
    await writeSession("s2");
    const unmarked = (await op("onboard", {})).data.previous_session_without_notes;
    expect(unmarked).toMatchObject({ session_id: "s1" });
    expect(unmarked).not.toHaveProperty("ended_by");

    const notesPath = join(root, "seats", "agent", "sessions", "s1.md");
    mkdirSync(join(root, "seats", "agent", "sessions"), { recursive: true });
    writeFileSync(endedPathOf(notesPath), "{not json");
    const malformed = (await op("onboard", {})).data.previous_session_without_notes;
    expect(malformed).toMatchObject({ session_id: "s1" });
    expect(malformed).not.toHaveProperty("ended_by");
  });

  it("says so when no transcript is known, and names none", async () => {
    await endAsOffboard("s1");
    await writeSession("s2");
    const told = (await op("onboard", {})).data.previous_session_without_notes;
    expect(told).toMatchObject({ session_id: "s1", transcript_path: null });
  });

  it("covers a session that was replaced without notes for any other reason", async () => {
    await writeSession("s2");
    const told = (await op("onboard", {})).data.previous_session_without_notes;
    expect(told).toMatchObject({ session_id: "s1", ended_because: "replaced" });
  });

  it("is about the session just before this one only, and a first session is told nothing", async () => {
    const first = await op("onboard", {});
    expect(first.data).not.toHaveProperty("previous_session_without_notes");

    // s1 ended without notes; s2 left notes; s3 follows s2.
    await endAsOffboard("s1");
    await writeSession("s2");
    await op("offboard", { notes: "Second session: wired the parser" });
    await endAsOffboard("s2");
    await writeSession("s3");
    const third = await op("onboard", {});
    expect(third.data).not.toHaveProperty("previous_session_without_notes");
  });
});

describe("junto onboard when the previous session's process was detached to finish its turn", () => {
  const drain = (how?: "settled" | "cap" | "crashed" | "quit") =>
    runtime.runPromise(
      Effect.flatMap(SeatSessionRepository, (r) =>
        Effect.gen(function* () {
          yield* r.beginDrain("agent", "s1", 1_800_000_000_000);
          if (how) yield* r.endDrain("agent", "s1", how, 1_800_000_060_000);
        }),
      ),
    );

  const handOver = async (how?: "settled" | "cap" | "crashed" | "quit") => {
    await op("offboard", { notes: "# Half done", continuation: "Finish the retry." });
    await endAsOffboard("s1");
    await drain(how);
    await writeSession("s2");
    return (await op("onboard", {})).data;
  };

  it("says the predecessor is still winding down, and that its transcript may still grow", async () => {
    const data = await handOver();
    expect(data.handoff.wind_down).toBe("Offboarded, winding down");
    expect(data.handoff.transcript_caution).toMatch(/still/i);
    expect(data.handoff.transcript_caution).toMatch(/transcript/i);
    expect(data.sessions.past[0].wind_down).toBe("Offboarded, winding down");
  });

  it.each([
    ["cap", "Offboarded, stopped at the 10 minute limit before its last turn finished"],
    ["crashed", "Offboarded, then its process crashed"],
    // Junto quitting stops the process wherever it is.
    ["quit", "Offboarded, ended when Junto quit"],
  ] as const)("warns that the transcript may end mid-turn when it ended as %s", async (how, line) => {
    const data = await handOver(how);
    expect(data.handoff.wind_down).toBe(line);
    expect(data.handoff.transcript_caution).toMatch(/mid-turn|before/i);
  });

  it.each([
    ["settled", "Offboarded, finished its last turn"],
  ] as const)("states how it ended and adds no warning when it ended as %s", async (how, line) => {
    const data = await handOver(how);
    expect(data.handoff.wind_down).toBe(line);
    expect(data.handoff).not.toHaveProperty("transcript_caution");
  });

  it("says nothing about winding down for a session that was never detached", async () => {
    await op("offboard", { notes: "# Half done", continuation: "Finish the retry." });
    await endAsOffboard("s1");
    await writeSession("s2");
    const data = (await op("onboard", {})).data;
    expect(data.handoff).not.toHaveProperty("wind_down");
    expect(data.handoff).not.toHaveProperty("transcript_caution");
    expect(data.sessions.past[0]).not.toHaveProperty("wind_down");
  });

  it("tells a session whose predecessor left no notes the same thing", async () => {
    await endAsOffboard("s1");
    await drain("cap");
    await writeSession("s2");
    const told = (await op("onboard", {})).data.previous_session_without_notes;
    expect(told.wind_down).toBe("Offboarded, stopped at the 10 minute limit before its last turn finished");
    expect(told.transcript_caution).toMatch(/mid-turn|before/i);
  });
});
