/**
 * The two offboard modes over the real work-control socket. Plain offboard
 * saves notes and announces a rest; `--continue` also saves a note for the
 * next session and announces a continue. Onboard hands that note back as a
 * handoff exactly once, and only to the session right after the one that
 * continued. Every store, home, and socket lives under a temp root.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame, workControlTokenPath } from "../src/shared/work-control";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
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
import type { CanvasDoc } from "../src/shared/canvas";
import { CONTINUATION_FRAMING, SEAT_SESSION_CONTINUATION_MAX_CHARS } from "../src/shared/seat-sessions";

const CANVAS = "offboard-modes";

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
  root = await mkdtemp(join(tmpdir(), "junto-offboard-modes-"));
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

const NOTES = "# Parser shipped\n\n- why: nightly sync fails without it";
const CONTINUATION = "Pick up the 429 retry in src/import/feed.ts: backoff is written, the test is not.";

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** What rotation does to the history: the session ends as offboard, the next starts. */
const rotateTo = async (next: string) => {
  await runtime.runPromise(Effect.flatMap(SeatSessionRepository, (r) => r.end("agent", "offboard")));
  await writeSession(next);
};

const withEvents = async (body: (events: SeatOffboardEvent[]) => Promise<void>) => {
  const events: SeatOffboardEvent[] = [];
  const unsubscribe = subscribeSeatOffboard((event) => events.push(event));
  try {
    await body(events);
  } finally {
    unsubscribe();
  }
};

describe("junto offboard modes", () => {
  it("plain offboard saves the notes and announces a rest, with no continuation", () =>
    withEvents(async (events) => {
      const result = await op("offboard", { notes: NOTES });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ session_id: "s1", mode: "rest", disposition: "applied" });
      expect(result.data).not.toHaveProperty("continuation_path");
      expect(result.data.next_step).toContain("the seat rests");
      expect(events).toEqual([expect.objectContaining({ seatId: "agent", sessionId: "s1", mode: "rest" })]);
      expect(existsSync(join(root, "seats", "agent", "sessions", "s1.next.md"))).toBe(false);
    }));

  it("--continue saves the notes and the continuation and announces a continue", () =>
    withEvents(async (events) => {
      const result = await op("offboard", { notes: NOTES, continuation: CONTINUATION });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ session_id: "s1", mode: "continue" });
      expect(result.data.continuation_path).toBe(join(root, "seats", "agent", "sessions", "s1.next.md"));
      expect(await readFile(result.data.continuation_path, "utf8")).toBe(`${CONTINUATION}\n`);
      expect(result.data.next_step).toContain("fresh session");
      expect(events).toEqual([expect.objectContaining({ mode: "continue" })]);
    }));

  it("a later plain offboard withdraws the continuation", async () => {
    await op("offboard", { notes: NOTES, continuation: CONTINUATION });
    const plain = await op("offboard", { notes: NOTES });
    expect(plain.data.mode).toBe("rest");
    expect(existsSync(join(root, "seats", "agent", "sessions", "s1.next.md"))).toBe(false);
  });

  it("keeps notes validation and checks the continuation", async () => {
    expect(await op("offboard", { notes: " ", continuation: CONTINUATION })).toMatchObject({
      ok: false,
      error: { type: "InputError", details: { path: "args.notes" } },
    });
    expect(await op("offboard", { notes: NOTES, continuation: " \n " })).toMatchObject({
      ok: false,
      error: { type: "InputError", details: { path: "args.continuation" } },
    });
    const long = "x".repeat(SEAT_SESSION_CONTINUATION_MAX_CHARS + 1);
    expect(await op("offboard", { notes: NOTES, continuation: long })).toMatchObject({
      ok: false,
      error: { type: "InputError", details: { path: "args.continuation" } },
    });
  });
});

describe("junto onboard handoff", () => {
  it("hands the continuation to the next session once, and to no later one", async () => {
    await op("offboard", { notes: NOTES, continuation: CONTINUATION });

    // The session that continued sees no handoff of its own.
    const self = await op("onboard", {});
    expect(self.data).not.toHaveProperty("handoff");

    await rotateTo("s2");
    const next = await op("onboard", {});
    expect(next.data.handoff).toEqual({
      note: CONTINUATION_FRAMING,
      from_session: "s1",
      left_at: expect.any(String),
      continuation: CONTINUATION,
    });
    // Once: the note appears in the handoff only, and leads the payload.
    expect(occurrences(JSON.stringify(next.data), "Pick up the 429 retry")).toBe(1);
    expect(Object.keys(next.data)[0]).toBe("handoff");
    // The notes stay history, beside it.
    expect(next.data.sessions.past[0]).toMatchObject({ session_id: "s1", gist: "Parser shipped" });

    // Re-orienting after a compaction still finds it.
    expect((await op("onboard", {})).data.handoff.continuation).toBe(CONTINUATION);

    await rotateTo("s3");
    const later = await op("onboard", {});
    expect(later.data).not.toHaveProperty("handoff");
    expect(occurrences(JSON.stringify(later.data), "Pick up the 429 retry")).toBe(0);
  });

  it("a session that rested hands nothing over", async () => {
    await op("offboard", { notes: NOTES });
    await rotateTo("s2");
    const next = await op("onboard", {});
    expect(next.data).not.toHaveProperty("handoff");
    expect(next.data.sessions.past[0]).toMatchObject({ session_id: "s1", notes: NOTES });
  });

  it("a session replaced for any other reason hands nothing over", async () => {
    await op("offboard", { notes: NOTES, continuation: CONTINUATION });
    await writeSession("s2");
    expect((await op("onboard", {})).data).not.toHaveProperty("handoff");
  });
});
